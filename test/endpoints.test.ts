import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/routes/embeddings.js";
import { startGateway } from "./gateway.js";

describe("POST /v1/completions", () => {
  it("returns a text_completion", async () => {
    const { client, stub } = await startGateway({ reply: "Paris is the capital" });
    const res = await client.completions.create({ model: "llama3:8b", prompt: "The capital of France is", max_tokens: 3, temperature: 0, suffix: "." });
    expect(res.object).toBe("text_completion");
    expect(res.id).toMatch(/^cmpl-/);
    expect(res.model).toBe("llama3:8b");
    expect(res.choices[0]).toEqual({ text: "Paris is the ", index: 0, logprobs: null, finish_reason: "length" });
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    expect(stub.last("/api/generate")?.body).toMatchObject({
      model: "llama3:8b",
      prompt: "The capital of France is",
      suffix: ".",
      stream: false,
      options: { num_predict: 3, temperature: 0 },
    });
  });

  it("accepts a prompt list with one prompt", async () => {
    const { client } = await startGateway({ reply: "ok" });
    const res = await client.completions.create({ model: "llama3:8b", prompt: ["Say ok"] });
    expect(res.choices[0]?.text).toBe("ok");
  });

  it("streams text chunks and ends with [DONE]", async () => {
    const { client } = await startGateway({ reply: "one two three" });
    const stream = await client.completions.create({ model: "llama3:8b", prompt: "Count", stream: true, stream_options: { include_usage: true } });
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks.map((c) => c.choices[0]?.text ?? "").join("")).toBe("one two three");
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe("stop");
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  it.each([
    [{ model: "llama3:8b", prompt: ["a", "b"] }, "prompt"],
    [{ model: "llama3:8b", prompt: "a", echo: true }, "echo"],
    [{ model: "llama3:8b", prompt: "a", best_of: 3 }, "best_of"],
    [{ model: "llama3:8b" }, "prompt"],
  ])("rejects %j", async (body, param) => {
    const { fetch } = await startGateway();
    const res = await fetch("/v1/completions", { body });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { param } });
  });
});

describe("POST /v1/embeddings", () => {
  it("embeds a single input (float)", async () => {
    const { client, stub } = await startGateway();
    const res = await client.embeddings.create({ model: "llama3:8b", input: "hello", encoding_format: "float" });
    expect(res.object).toBe("list");
    expect(res.model).toBe("llama3:8b");
    expect(res.data).toEqual([{ object: "embedding", index: 0, embedding: [5, 104, 0.5, -0.25] }]);
    expect(res.usage).toEqual({ prompt_tokens: 1, total_tokens: 1 });
    expect(stub.last("/api/embed")?.body).toEqual({ model: "llama3:8b", input: ["hello"] });
  });

  it("embeds a batch in order", async () => {
    const { client } = await startGateway();
    const res = await client.embeddings.create({ model: "llama3:8b", input: ["a", "bb", "ccc"], encoding_format: "float" });
    expect(res.data.map((d) => [d.index, d.embedding[0]])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("works with the SDK's default base64 encoding", async () => {
    // The Node SDK requests base64 unless told otherwise and decodes it to numbers.
    const { client, fetch } = await startGateway();
    const res = await client.embeddings.create({ model: "llama3:8b", input: "hello" });
    expect(res.data[0]?.embedding).toEqual([5, 104, 0.5, -0.25]);

    const raw = (await (await fetch("/v1/embeddings", { body: { model: "llama3:8b", input: "hi", encoding_format: "base64" } })).json()) as {
      data: { embedding: string }[];
    };
    expect(raw.data[0]?.embedding).toBe(toBase64([2, 104, 0.5, -0.25]));
  });

  it("passes dimensions through", async () => {
    const { client, stub } = await startGateway();
    await client.embeddings.create({ model: "llama3:8b", input: "x", dimensions: 2, encoding_format: "float" });
    expect(stub.last("/api/embed")?.body).toMatchObject({ dimensions: 2 });
  });

  it("explains that a chat-only model cannot embed", async () => {
    const { client } = await startGateway({ embeddingModels: [] });
    const err = await client.embeddings.create({ model: "llama3:8b", input: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect((err as InstanceType<typeof OpenAI.BadRequestError>).code).toBe("model_not_supported");
  });

  it("rejects token arrays", async () => {
    const { fetch } = await startGateway();
    const res = await fetch("/v1/embeddings", { body: { model: "llama3:8b", input: [[1, 2, 3]] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { param: "input" } });
  });
});

describe("GET /v1/models", () => {
  it("lists the backend's models when no aliases are configured", async () => {
    const { client } = await startGateway({ models: ["llama3:8b", "hf.co/org/model:Q4"] });
    const page = await client.models.list();
    expect(page.data).toEqual([
      { id: "llama3:8b", object: "model", created: 1767323045, owned_by: "local-llm-gateway" },
      { id: "hf.co/org/model:Q4", object: "model", created: 1767323045, owned_by: "local-llm-gateway" },
    ]);
  });

  it("lists only aliases when aliases are configured", async () => {
    const { client, stub } = await startGateway(
      { models: ["qwen3:8b"] },
      { aliases: { "chat-default": { backend: "ollama", model: "qwen3:8b" }, embed: { backend: "ollama", model: "nomic" } } },
    );
    const page = await client.models.list();
    expect(page.data.map((m) => m.id)).toEqual(["chat-default", "embed"]);
    expect(JSON.stringify(page.data)).not.toContain("qwen3");
    expect(stub.modelRequests).toHaveLength(0);
  });

  it("retrieves one model, including ids with slashes", async () => {
    const { client } = await startGateway({ models: ["hf.co/org/model:Q4"] });
    expect((await client.models.retrieve("hf.co/org/model:Q4")).id).toBe("hf.co/org/model:Q4");
    await expect(client.models.retrieve("nope")).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("answers 502 when the backend is down", async () => {
    const { client, stub } = await startGateway();
    await stub.stop();
    const err = await client.models.list().catch((e: unknown) => e);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(502);
  });
});
