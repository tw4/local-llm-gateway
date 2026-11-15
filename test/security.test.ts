// Regression tests for the security review (#20): each one is an attack that must keep failing.
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { isAllowed, resolveForKey } from "../src/models.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";
import { OpenAIStub } from "./stubs/openai.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function gateway(config: Record<string, unknown>, lines?: Record<string, unknown>[]) {
  const app: FastifyInstance = buildApp(
    testConfig(config),
    lines
      ? { logStream: { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) } }
      : { fastify: { logger: false } },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  return { app, address };
}

async function ollama() {
  const stub = await new OllamaStub().start();
  cleanup.push(() => stub.stop());
  return stub;
}

const chatBody = JSON.stringify({ model: "llama3:8b", messages: [{ role: "user", content: "hi" }] });

describe("authentication cannot be bypassed", () => {
  // The router percent-decodes paths, so each of these reaches a /v1 route.
  const encoded: [string, string][] = [
    ["GET", "/%76%31/models"],
    ["GET", "/v%31/models"],
    ["GET", "/%76%31/models/llama3:8b"],
    ["POST", "/v%31/chat/completions"],
    ["POST", "/%76%31/completions"],
    ["POST", "/%76%31/%65mbeddings"],
    ["GET", "/%76%31/no-such-route"],
  ];

  it.each(encoded)("%s %s without a key is 401", async (method, url) => {
    const stub = await ollama();
    const { app } = await gateway({ backends: { ollama: { type: "ollama", url: stub.url } } });
    const res = await app.inject({ method, url, headers: { "content-type": "application/json" }, ...(method === "POST" ? { payload: chatBody } : {}) });
    expect(res.statusCode).toBe(401);
    expect(stub.requests.filter((r) => r.path !== "/api/version" && r.path !== "/api/tags")).toHaveLength(0);
  });

  it("an encoded path with a valid key still works", async () => {
    const stub = await ollama();
    const { app } = await gateway({ backends: { ollama: { type: "ollama", url: stub.url } } });
    const res = await app.inject({ url: "/%76%31/models", headers: { authorization: `Bearer ${TEST_KEY}` } });
    expect(res.statusCode).toBe(200);
  });

  it("no key may use any model, as a second line of defence", () => {
    expect(isAllowed(null, "anything")).toBe(false);
    expect(() => resolveForKey(() => { throw new Error("resolver must not run"); }, null, "m")).toThrow(/API key/);
  });
});

describe("request limits", () => {
  it("drops a client that sends its body too slowly", async () => {
    const { address } = await gateway({ server: { requestTimeoutMs: 300 } });
    const { port } = new URL(address);
    const answer = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TEST_KEY}\r\n` +
            "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{",
        );
        // ...and never sends the rest.
      });
      let data = "";
      socket.on("data", (d) => (data += d.toString()));
      socket.on("close", () => { resolve(data); });
      setTimeout(() => socket.destroy(), 3000).unref();
    });
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
  });

  it("rejects a body over the limit with 413 before it reaches a backend", async () => {
    const stub = await ollama();
    const { app } = await gateway({ backends: { ollama: { type: "ollama", url: stub.url } }, server: { bodyLimitBytes: 1024 } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: JSON.stringify({ model: "llama3:8b", messages: [{ role: "user", content: "x".repeat(4096) }] }),
    });
    expect(res.statusCode).toBe(413);
    expect(stub.requests.some((r) => r.path === "/api/chat")).toBe(false);
  });

  it("rejects prototype pollution in JSON bodies", async () => {
    const { app } = await gateway({});
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: '{"model":"m","messages":[],"__proto__":{"polluted":true}}',
    });
    expect(res.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("upstream handling (SSRF)", () => {
  it("never lets a client make a backend fetch a remote image", async () => {
    const stub = await new OpenAIStub().start();
    cleanup.push(() => stub.stop());
    const { app } = await gateway({ backends: { compat: { type: "openai", url: `${stub.url}/v1` } } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/latest/meta-data/" } }] }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(stub.requests.some((r) => r.path === "/v1/chat/completions")).toBe(false);
  });

  it("does not follow redirects from a backend", async () => {
    let elsewhereHit = false;
    const elsewhere = await listen(createServer((_req, res) => {
      elsewhereHit = true;
      res.end("{}");
    }));
    const redirecting = await listen(createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${port(elsewhere)}/v1/chat/completions` }).end();
    }));
    const { app } = await gateway({ backends: { compat: { type: "openai", url: `http://127.0.0.1:${port(redirecting)}/v1` } } });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: chatBody,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(elsewhereHit).toBe(false);
  });

  it("keeps a backend's failure text out of the response but in the log", async () => {
    const leaky = await listen(createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "open /srv/internal/models/secret.gguf: permission denied" }));
    }));
    const lines: Record<string, unknown>[] = [];
    const { app } = await gateway(
      { backends: { compat: { type: "openai", url: `http://127.0.0.1:${port(leaky)}/v1` } }, logging: { level: "warn" } },
      lines,
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      payload: chatBody,
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("/srv/internal");
    expect(JSON.stringify(lines)).toContain("/srv/internal/models/secret.gguf");
  });
});

describe("startup warnings", () => {
  it("warns about short keys and an open /metrics", async () => {
    const lines: Record<string, unknown>[] = [];
    await gateway({ keys: [{ name: "weak", key: "short" }], logging: { level: "warn" } }, lines);
    const messages = lines.map((l) => String(l.msg));
    expect(messages.some((m) => m.includes('API key "weak" is only 5 characters'))).toBe(true);
    expect(messages.some((m) => m.includes("/metrics is served without a token"))).toBe(true);
    // The key itself is never logged.
    expect(JSON.stringify(lines)).not.toContain('"short"');
  });
});

function listen(server: Server): Promise<Server> {
  cleanup.push(() => new Promise((r) => server.close(r)));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { resolve(server); }));
}
function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}
