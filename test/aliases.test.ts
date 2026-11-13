import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config/load.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";
import { OpenAIStub } from "./stubs/openai.js";

// Real model names that must never appear in anything a client receives.
const SECRET_OLLAMA = "secret-ollama-model:13b";
const SECRET_COMPAT = "secret-compat-model";
const SECRETS = [SECRET_OLLAMA, SECRET_COMPAT, "secret-ollama", "secret-compat"];

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start() {
  const ollama = await new OllamaStub({
    models: [SECRET_OLLAMA],
    handle: (_req, body, res) => {
      // Upstream errors that mention the real model name.
      if (body?.prompt === "crash") {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: `failed to load ${SECRET_OLLAMA}: out of memory` }));
        return true;
      }
      if (body?.prompt === "crash-mid-stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ model: SECRET_OLLAMA, response: "partial ", done: false })}\n`);
        res.end(`${JSON.stringify({ error: `${SECRET_OLLAMA} runner crashed` })}\n`);
        return true;
      }
      return false;
    },
  }).start();
  const compat = await new OpenAIStub({ models: [SECRET_COMPAT] }).start();
  cleanup.push(() => ollama.stop(), () => compat.stop());

  const app: FastifyInstance = buildApp(
    testConfig({
      backends: { ollama: { type: "ollama", url: ollama.url }, compat: { type: "openai", url: `${compat.url}/v1` } },
      // Both forms: object and "backend/model".
      aliases: { chat: { backend: "ollama", model: SECRET_OLLAMA }, "chat-compat": `compat/${SECRET_COMPAT}`, missing: "ollama/not-pulled" },
    }),
    { fastify: { logger: false } },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${address}${path}`, {
      method,
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // Everything the client receives: status, headers and body.
    return { status: res.status, text, everything: `${JSON.stringify([...res.headers.entries()])}\n${text}` };
  };
  return { call };
}

const user = [{ role: "user", content: "hi" }];

describe("model aliases", () => {
  it("never reveal the real model name, in any response", async () => {
    const { call } = await start();
    const responses = await Promise.all([
      call("POST", "/v1/chat/completions", { model: "chat", messages: user }),
      call("POST", "/v1/chat/completions", { model: "chat", messages: user, stream: true, stream_options: { include_usage: true } }),
      call("POST", "/v1/chat/completions", { model: "chat-compat", messages: user }),
      call("POST", "/v1/chat/completions", { model: "chat-compat", messages: user, stream: true }),
      call("POST", "/v1/completions", { model: "chat", prompt: "x" }),
      call("POST", "/v1/completions", { model: "chat-compat", prompt: "x", stream: true }),
      call("POST", "/v1/embeddings", { model: "chat", input: ["a"] }),
      call("POST", "/v1/embeddings", { model: "chat-compat", input: ["a"] }),
      call("GET", "/v1/models"),
      call("GET", "/v1/models/chat"),
      // Errors that mention the model upstream:
      call("POST", "/v1/chat/completions", { model: "missing", messages: user }),
      call("POST", "/v1/completions", { model: "chat", prompt: "crash" }),
      call("POST", "/v1/completions", { model: "chat", prompt: "crash-mid-stream", stream: true }),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 404, 502, 200]);
    for (const r of responses) {
      for (const secret of SECRETS) expect(r.everything).not.toContain(secret);
    }
    // The errors still say which model failed, by its alias.
    expect(responses[10].text).toContain("'missing'");
    expect(responses[11].text).toContain("failed to load chat: out of memory");
    expect(responses[12].text).toContain("chat runner crashed");
  });

  it("answer with the alias as the model", async () => {
    const { call } = await start();
    const chat = JSON.parse((await call("POST", "/v1/chat/completions", { model: "chat-compat", messages: user })).text) as { model: string };
    expect(chat.model).toBe("chat-compat");
  });

  it("list only aliases, and refuse the real names", async () => {
    const { call } = await start();
    const models = JSON.parse((await call("GET", "/v1/models")).text) as { data: { id: string }[] };
    expect(models.data.map((m) => m.id)).toEqual(["chat", "chat-compat", "missing"]);
    expect((await call("POST", "/v1/chat/completions", { model: SECRET_OLLAMA, messages: user })).status).toBe(404);
    expect((await call("GET", `/v1/models/${SECRET_COMPAT}`)).status).toBe(404);
  });
});

describe("alias configuration", () => {
  const base = "backends:\n  ollama: { type: ollama, url: 'http://localhost:11434' }\nkeys: [{ name: a, key: k }]\n";

  it("accepts backend/model, splitting at the first slash only", () => {
    const cfg = parseConfig(`${base}aliases:\n  a: ollama/qwen3:8b\n  b: ollama/hf.co/org/model:Q4_K_M\n  c: { backend: ollama, model: x }\n`, { env: {} });
    expect(cfg.aliases).toEqual({
      a: { backend: "ollama", model: "qwen3:8b" },
      b: { backend: "ollama", model: "hf.co/org/model:Q4_K_M" },
      c: { backend: "ollama", model: "x" },
    });
  });

  it("rejects a short form without a backend and an unknown backend", () => {
    expect(() => parseConfig(`${base}aliases:\n  a: qwen3\n`, { env: {} })).toThrow(/aliases\.a/);
    expect(() => parseConfig(`${base}aliases:\n  a: nope/qwen3\n`, { env: {} })).toThrow(/aliases\.a\.backend: unknown backend "nope"/);
  });

  it("passes model names through to the first backend when no alias is configured", async () => {
    const stub = await new OllamaStub({ models: ["llama3:8b"] }).start();
    cleanup.push(() => stub.stop());
    const app = buildApp(testConfig({ backends: { ollama: { type: "ollama", url: stub.url } } }), { fastify: { logger: false } });
    cleanup.push(() => app.close());
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: { model: "llama3:8b", messages: user },
    });
    expect(res.json()).toMatchObject({ model: "llama3:8b" });
  });
});
