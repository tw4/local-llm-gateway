import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub, type OllamaStubOptions } from "./stubs/ollama.js";

let app: FastifyInstance | undefined;
let stub: OllamaStub | undefined;

afterEach(async () => {
  await app?.close();
  await stub?.stop();
  app = undefined;
  stub = undefined;
});

async function setup(stubOptions: OllamaStubOptions = {}, config: Record<string, unknown> = {}) {
  stub = await new OllamaStub(stubOptions).start();
  app = buildApp(testConfig({ backends: { ollama: { type: "ollama", url: stub.url } }, ...config }), { fastify: { logger: false } });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new OpenAI({ apiKey: TEST_KEY, baseURL: `${address}/v1`, maxRetries: 0 });
  return { client, address, stub };
}

describe("POST /v1/chat/completions (non-streaming)", () => {
  it("returns a chat.completion with content, finish_reason and usage", async () => {
    const { client } = await setup({ reply: "Hi there" });
    const res = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "Hello" }] });
    expect(res.object).toBe("chat.completion");
    expect(res.id).toMatch(/^chatcmpl-/);
    expect(res.model).toBe("llama3:8b");
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0]?.message).toMatchObject({ role: "assistant", content: "Hi there" });
    expect(res.choices[0]?.finish_reason).toBe("stop");
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
  });

  it("maps messages and sampling parameters to Ollama", async () => {
    const { client, stub } = await setup();
    await client.chat.completions.create({
      model: "llama3:8b",
      messages: [
        { role: "developer", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "What is" }, { type: "text", text: "this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      stop: "END",
      seed: 7,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      response_format: { type: "json_object" },
    });
    const body = stub.last("/api/chat")?.body;
    expect(body).toMatchObject({
      model: "llama3:8b",
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "What is\nthis?", images: ["AAAA"] },
      ],
      options: { temperature: 0.2, top_p: 0.9, num_predict: 50, stop: ["END"], seed: 7, presence_penalty: 0.5, frequency_penalty: 0.3 },
    });
  });

  it("prefers max_completion_tokens and passes a JSON schema as the format", async () => {
    const { client, stub } = await setup();
    const schema = { type: "object", properties: { a: { type: "string" } } };
    await client.chat.completions.create({
      model: "llama3:8b",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 10,
      max_completion_tokens: 20,
      response_format: { type: "json_schema", json_schema: { name: "s", schema } },
    });
    expect(stub.last("/api/chat")?.body).toMatchObject({ options: { num_predict: 20 }, format: schema });
  });

  it("reports finish_reason length when max_tokens cut the answer", async () => {
    const { client } = await setup({ reply: "one two three four" });
    const res = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "x" }], max_tokens: 2 });
    expect(res.choices[0]?.finish_reason).toBe("length");
    expect(res.choices[0]?.message.content).toBe("one two ");
  });

  it("returns tool calls in the OpenAI format and sends tool results back", async () => {
    const { client, stub } = await setup({ toolCalls: [{ function: { name: "get_weather", arguments: { city: "Izmir" } } }] });
    const tools = [{ type: "function" as const, function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
    const res = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "Weather?" }], tools });
    const call = res.choices[0]?.message.tool_calls?.[0];
    expect(res.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call).toMatchObject({ type: "function", function: { name: "get_weather", arguments: '{"city":"Izmir"}' } });
    expect(call?.id).toMatch(/^call_/);
    expect(stub.last("/api/chat")?.body?.tools).toEqual(tools);

    await client.chat.completions.create({
      model: "llama3:8b",
      tools,
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Izmir"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "24°C" },
      ],
    });
    expect(stub.last("/api/chat")?.body?.messages).toEqual([
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Izmir" } } }] },
      { role: "tool", content: "24°C", tool_name: "get_weather" },
    ]);
  });

  it("returns a reasoning model's thinking as reasoning_content", async () => {
    const { address } = await setup({ thinking: "Let me think." });
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3:8b", messages: [{ role: "user", content: "x" }] }),
    });
    const body = (await res.json()) as { choices: { message: { reasoning_content?: string } }[] };
    expect(body.choices[0]?.message.reasoning_content).toBe("Let me think.");
  });
});

describe("POST /v1/chat/completions (streaming)", () => {
  it("streams chunks the SDK can assemble, ending with finish_reason", async () => {
    const { client } = await setup({ reply: "Streaming works fine" });
    const stream = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "x" }], stream: true });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("Streaming works fine");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(new Set(chunks.map((c) => `${c.object} ${c.model}`))).toEqual(new Set(["chat.completion.chunk llama3:8b"]));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  });

  it("uses the OpenAI SSE format and ends with [DONE]", async () => {
    const { address } = await setup({ reply: "a b" });
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3:8b", messages: [{ role: "user", content: "x" }], stream: true }),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    const events = text.split("\n\n").filter(Boolean);
    expect(events.every((e) => e.startsWith("data: "))).toBe(true);
    expect(events.at(-1)).toBe("data: [DONE]");
  });

  it("adds a usage chunk when stream_options.include_usage is set", async () => {
    const { client } = await setup({ reply: "one two" });
    const stream = await client.chat.completions.create({
      model: "llama3:8b",
      messages: [{ role: "user", content: "x" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const last = chunks.at(-1);
    expect(last?.choices).toEqual([]);
    expect(last?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
    expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
  });

  it("streams tool calls with an index", async () => {
    const { client } = await setup({ toolCalls: [{ function: { name: "f", arguments: { x: 1 } } }] });
    const stream = await client.chat.completions.create({
      model: "llama3:8b",
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f" } }],
      stream: true,
    });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls).toMatchObject([{ index: 0, type: "function", function: { name: "f", arguments: '{"x":1}' } }]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("cancels the upstream request when the client disconnects", async () => {
    const { client, stub } = await setup({ reply: "a b c d e f g h i j", chunkDelayMs: 100 });
    const stream = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "x" }], stream: true });
    for await (const c of stream) {
      if (c.choices[0]?.delta.content) break; // stop reading after the first word
    }
    stream.controller.abort();
    await expect.poll(() => stub.cancelled, { timeout: 3000 }).toBe(1);
  });

  it("raises an error in the SDK when the backend dies mid-stream", async () => {
    const { client } = await setup({ reply: "a b c d", dieAfterChunks: 2 });
    const stream = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "x" }], stream: true });
    const read = async () => {
      for await (const _ of stream) {
        // drain
      }
    };
    await expect(read()).rejects.toThrow(/unavailable/);
  });

  it("reports an unknown model as a normal 404 before streaming", async () => {
    const { client } = await setup();
    await expect(client.chat.completions.create({ model: "nope", messages: [{ role: "user", content: "x" }], stream: true })).rejects.toBeInstanceOf(
      OpenAI.NotFoundError,
    );
  });
});

describe("errors", () => {
  it("answers 404 model_not_found for a model the backend does not have", async () => {
    const { client } = await setup();
    const err = await client.chat.completions.create({ model: "nope", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    expect((err as InstanceType<typeof OpenAI.NotFoundError>).code).toBe("model_not_found");
  });

  it("answers 502 when the backend is down", async () => {
    const { client, stub } = await setup();
    await stub.stop();
    const err = await client.chat.completions.create({ model: "llama3:8b", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.InternalServerError);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(502);
  });

  it.each([
    [{ messages: [{ role: "user", content: "x" }] }, "model", "missing_required_parameter"],
    [{ model: "llama3:8b" }, "messages", "missing_required_parameter"],
    [{ model: "llama3:8b", messages: [] }, "messages", "invalid_value"],
    [{ model: "llama3:8b", messages: [{ role: "robot", content: "x" }] }, "messages[0].role", "invalid_value"],
    [{ model: "llama3:8b", messages: [{ role: "user", content: "x" }], n: 2 }, "n", "invalid_value"],
    [{ model: "llama3:8b", messages: [{ role: "user", content: "x" }], temperature: 5 }, "temperature", "invalid_value"],
  ])("rejects %j with 400 and param", async (body, param, code) => {
    const { address } = await setup();
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error", param, code } });
  });

  it("refuses remote image URLs (the gateway does not fetch URLs for clients)", async () => {
    const { client, stub } = await setup();
    const err = await client.chat.completions
      .create({ model: "llama3:8b", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/latest" } }] }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("aliases", () => {
  it("sends the real model name upstream and answers with the alias", async () => {
    const { client, stub } = await setup({ models: ["qwen3:8b"] }, { aliases: { "chat-default": { backend: "ollama", model: "qwen3:8b" } } });
    const res = await client.chat.completions.create({ model: "chat-default", messages: [{ role: "user", content: "x" }] });
    expect(stub.last("/api/chat")?.body?.model).toBe("qwen3:8b");
    expect(res.model).toBe("chat-default");
  });

  it("only accepts aliases once aliases are configured", async () => {
    const { client } = await setup({ models: ["qwen3:8b"] }, { aliases: { "chat-default": { backend: "ollama", model: "qwen3:8b" } } });
    await expect(client.chat.completions.create({ model: "qwen3:8b", messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("does not leak the real model name when the backend lacks it", async () => {
    const { client } = await setup({ models: [] }, { aliases: { "chat-default": { backend: "ollama", model: "secret-model:70b" } } });
    const err = await client.chat.completions.create({ model: "chat-default", messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    expect((err as Error).message).toContain("chat-default");
    expect((err as Error).message).not.toContain("secret-model");
  });
});
