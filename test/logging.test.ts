import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";

const PROMPT = "my-private-prompt-7f3a";
const ANSWER = "the-private-answer-9c1d";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(logging: Record<string, unknown> = {}) {
  const stub = await new OllamaStub({ reply: ANSWER }).start();
  const lines: Record<string, unknown>[] = [];
  const app: FastifyInstance = buildApp(
    testConfig({
      backends: { ollama: { type: "ollama", url: stub.url } },
      aliases: { chat: "ollama/llama3:8b" },
      logging: { level: "info", ...logging },
    }),
    { logStream: { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) } },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => stub.stop(), () => app.close());
  const client = new OpenAI({ apiKey: TEST_KEY, baseURL: `${address}/v1`, maxRetries: 0 });
  const accessLines = () => lines.filter((l) => l.msg === "request completed");
  return { app, stub, address, client, lines, accessLines };
}

const user = [{ role: "user" as const, content: PROMPT }];

describe("structured logs", () => {
  it("writes one JSON line per request with id, key, alias, status, timings and tokens", async () => {
    const { client, lines, accessLines } = await start();
    await client.chat.completions.create({ model: "chat", messages: user });
    const stream = await client.chat.completions.create({ model: "chat", messages: user, stream: true });
    for await (const _ of stream) {
      // drain
    }

    expect(lines.filter((l) => l.msg === "incoming request")).toEqual([]);
    const [plain, streamed] = accessLines();
    expect(plain).toMatchObject({
      level: 30,
      reqId: expect.any(String) as unknown,
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      key: "test",
      endpoint: "chat",
      model: "chat",
      backend: "ollama",
      durationMs: expect.any(Number) as unknown,
      tokens: { prompt: 12, completion: 1 },
    });
    expect(plain).not.toHaveProperty("firstChunkMs");
    expect(streamed).toMatchObject({ status: 200, tokens: { prompt: 12, completion: 1 }, firstChunkMs: expect.any(Number) as unknown });
  });

  it("never logs prompts, completions or keys by default", async () => {
    const { client, lines } = await start();
    await client.chat.completions.create({ model: "chat", messages: user });
    const stream = await client.completions.create({ model: "chat", prompt: PROMPT, stream: true });
    for await (const _ of stream) {
      // drain
    }
    await client.embeddings.create({ model: "chat", input: PROMPT });
    await new OpenAI({ apiKey: "wrong-key-xyz", baseURL: client.baseURL, maxRetries: 0 }).models.list().catch(() => undefined);

    const all = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [PROMPT, ANSWER, TEST_KEY, "wrong-key-xyz", "Bearer"]) expect(all).not.toContain(secret);
  });

  it("logs bodies, streamed text included, only when logBodies is on", async () => {
    const { client, accessLines } = await start({ logBodies: true });
    await client.chat.completions.create({ model: "chat", messages: user });
    const stream = await client.chat.completions.create({ model: "chat", messages: user, stream: true });
    for await (const _ of stream) {
      // drain
    }
    const [plain, streamed] = accessLines();
    expect(JSON.stringify(plain?.requestBody)).toContain(PROMPT);
    expect(String(plain?.responseBody)).toContain(ANSWER);
    expect(streamed?.responseBody).toBe(ANSWER);
  });

  it("uses a safe X-Request-Id from the client, echoes it, and replaces unsafe ones", async () => {
    const { address, accessLines } = await start();
    const send = (id: string) => fetch(`${address}/v1/models`, { headers: { authorization: `Bearer ${TEST_KEY}`, "x-request-id": id } });

    const good = await send("trace-abc_123");
    expect(good.headers.get("x-request-id")).toBe("trace-abc_123");
    const bad = await send("x\"}{fake json");
    const replaced = bad.headers.get("x-request-id") ?? "";
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
    expect(accessLines().map((l) => l.reqId)).toEqual(["trace-abc_123", replaced]);
  });

  it("logs upstream failures as warnings with their code", async () => {
    const { client, stub, accessLines } = await start();
    await stub.stop();
    await client.chat.completions.create({ model: "chat", messages: user }).catch(() => undefined);
    expect(accessLines()[0]).toMatchObject({ level: 40, status: 502, error: "upstream_unavailable", model: "chat" });
  });

  it("masks authorization headers and keys wherever they appear", async () => {
    const { app, lines } = await start();
    app.log.info({ headers: { authorization: "Bearer abc" }, upstream: { apiKey: "s3cret" }, key: { name: "n", key: "k3y" } }, "probe");
    const probe = lines.find((l) => l.msg === "probe");
    expect(JSON.stringify(probe)).not.toMatch(/Bearer abc|s3cret|k3y/);
    expect(probe).toMatchObject({ headers: { authorization: "[redacted]" }, upstream: { apiKey: "[redacted]" }, key: { name: "n", key: "[redacted]" } });
  });
});
