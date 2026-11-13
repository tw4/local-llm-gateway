import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";
import { OpenAIStub, type OpenAIStubOptions } from "./stubs/openai.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A gateway with an Ollama backend and an OpenAI-compatible one, both behind aliases. */
async function start(openaiOptions: OpenAIStubOptions = {}, backendExtra: Record<string, unknown> = {}) {
  const ollama = await new OllamaStub({ models: ["qwen3:8b"], reply: "from ollama" }).start();
  const llamacpp = await new OpenAIStub({ models: ["gemma-3-4b"], ...openaiOptions }).start();
  cleanup.push(() => ollama.stop(), () => llamacpp.stop());
  const app: FastifyInstance = buildApp(
    testConfig({
      backends: {
        ollama: { type: "ollama", url: ollama.url },
        llamacpp: { type: "openai", url: `${llamacpp.url}/v1/`, ...backendExtra },
      },
      aliases: {
        "chat-ollama": { backend: "ollama", model: "qwen3:8b" },
        "chat-llamacpp": { backend: "llamacpp", model: "gemma-3-4b" },
        "embed-llamacpp": { backend: "llamacpp", model: "gemma-3-4b" },
      },
    }),
    { fastify: { logger: false } },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  return { client: new OpenAI({ apiKey: TEST_KEY, baseURL: `${address}/v1`, maxRetries: 0 }), ollama, llamacpp, app };
}

describe("OpenAI-compatible backend", () => {
  it("serves an Ollama model and a llama.cpp model from one gateway under aliases", async () => {
    const { client, ollama, llamacpp } = await start({ reply: "from llama.cpp" });
    const a = await client.chat.completions.create({ model: "chat-ollama", messages: [{ role: "user", content: "hi" }] });
    const b = await client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "hi" }] });
    expect(a.choices[0]?.message.content).toBe("from ollama");
    expect(b.choices[0]?.message.content).toBe("from llama.cpp");
    expect(b.model).toBe("chat-llamacpp");
    expect(ollama.last("/api/chat")?.body?.model).toBe("qwen3:8b");
    expect(llamacpp.last("/v1/chat/completions")?.body?.model).toBe("gemma-3-4b");
  });

  it("forwards the OpenAI request fields under their own names", async () => {
    const { client, llamacpp } = await start();
    await client.chat.completions.create({
      model: "chat-llamacpp",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      temperature: 0.1,
      max_tokens: 5,
      stop: ["x"],
      seed: 1,
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "f" } }],
      tool_choice: "auto",
    });
    expect(llamacpp.last("/v1/chat/completions")?.body).toEqual({
      model: "gemma-3-4b",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      temperature: 0.1,
      max_tokens: 5,
      stop: ["x"],
      seed: 1,
      response_format: { type: "json_object" },
      tools: [{ type: "function", function: { name: "f" } }],
      tool_choice: "auto",
    });
  });

  it("returns usage, reasoning and tool calls (non-streaming)", async () => {
    const { client } = await start({ toolCall: { name: "lookup", arguments: '{"q":"x"}' }, reasoning: "hmm" });
    const res = await client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "x" }] });
    expect(res.choices[0]?.finish_reason).toBe("tool_calls");
    expect(res.choices[0]?.message.tool_calls).toEqual([{ id: "call_abc", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }]);
    expect((res.choices[0]?.message as unknown as { reasoning_content: string }).reasoning_content).toBe("hmm");
    expect(res.usage?.prompt_tokens).toBe(9);
  });

  it("streams text and asks the upstream for usage even if the client did not", async () => {
    const { client, llamacpp } = await start({ reply: "a b c" });
    const stream = await client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "x" }], stream: true });
    let text = "";
    let finish: string | null = null;
    for await (const c of stream) {
      text += c.choices[0]?.delta.content ?? "";
      finish = c.choices[0]?.finish_reason ?? finish;
    }
    expect(text).toBe("a b c");
    expect(finish).toBe("stop");
    expect(llamacpp.last("/v1/chat/completions")?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("assembles tool calls that arrive in fragments", async () => {
    const { client } = await start({ toolCall: { name: "lookup", arguments: '{"query":"weather in Izmir"}' } });
    const stream = await client.chat.completions.create({
      model: "chat-llamacpp",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls).toEqual([{ index: 0, id: "call_abc", type: "function", function: { name: "lookup", arguments: '{"query":"weather in Izmir"}' } }]);
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunks.at(-1)?.usage?.prompt_tokens).toBe(9);
  });

  it("streams text completions", async () => {
    const { client } = await start({ reply: "one two" });
    const stream = await client.completions.create({ model: "chat-llamacpp", prompt: "x", stream: true });
    let text = "";
    for await (const c of stream) text += c.choices[0]?.text ?? "";
    expect(text).toBe("one two");
    const plain = await client.completions.create({ model: "chat-llamacpp", prompt: "x" });
    expect(plain.choices[0]?.text).toBe("one two");
  });

  it("returns embeddings in input order and encodes base64 itself", async () => {
    const { client, llamacpp } = await start();
    const res = await client.embeddings.create({ model: "embed-llamacpp", input: ["a", "bbb"] });
    expect(res.data.map((d) => d.embedding)).toEqual([
      [1, 1, 2],
      [3, 1, 2],
    ]);
    expect(llamacpp.last("/v1/embeddings")?.body).toMatchObject({ encoding_format: "float" });
  });

  it("sends the upstream API key and reports a wrong one as a gateway problem (502)", async () => {
    const ok = await start({ apiKey: "upstream-secret" }, { apiKey: "upstream-secret" });
    await expect(ok.client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "x" }] })).resolves.toBeDefined();

    const bad = await start({ apiKey: "upstream-secret" }, { apiKey: "wrong" });
    const err = await bad.client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(502);
  });

  it("hides the real model name when the upstream does not have it", async () => {
    const { client } = await start({ models: ["something-else"] });
    const err = await client.chat.completions.create({ model: "chat-llamacpp", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    expect((err as Error).message).not.toContain("gemma");
  });

  it("checks health with /models", async () => {
    const { app, llamacpp } = await start();
    const res = await app.inject({ url: "/healthz" });
    expect(res.json()).toEqual({ status: "ok", backends: { healthy: 2, total: 2 } });
    expect(llamacpp.requests.some((r) => r.path === "/v1/models")).toBe(true);
  });

  it("works with a server that leaves usage out of streams", async () => {
    const { client } = await start({ noStreamUsage: true });
    const stream = await client.chat.completions.create({
      model: "chat-llamacpp",
      messages: [{ role: "user", content: "x" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});
