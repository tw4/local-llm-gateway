// OpenAI SDK conformance: every endpoint, streaming edge cases and every error shape,
// run with the official `openai` Node SDK against both backend types.

import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";
import { OpenAIStub } from "./stubs/openai.js";

const REPLY = "Merhaba dünya, nasılsın?";
const FULL = "full-key-0123456789";
const RESTRICTED = "restricted-key-0123456789";
const LIMITED = "limited-key-0123456789";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Kind = "ollama" | "openai";

interface Fixture {
  address: string;
  client: OpenAI;
  as: (key: string) => OpenAI;
  raw: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
}

/**
 * A gateway in front of one backend of the given kind, with the alias `chat`, the alias
 * `other` (same backend, for allowlist checks) and three keys.
 */
async function start(kind: Kind, options: { toolCall?: boolean; reasoning?: boolean; responseMs?: number } = {}): Promise<Fixture> {
  let url: string;
  if (kind === "ollama") {
    const stub = await new OllamaStub({
      models: ["m"],
      reply: REPLY,
      ...(options.toolCall ? { toolCalls: [{ function: { name: "lookup", arguments: { q: "x" } } }] } : {}),
      ...(options.reasoning ? { thinking: "thinking…" } : {}),
    }).start();
    cleanup.push(() => stub.stop());
    url = stub.url;
  } else {
    const stub = await new OpenAIStub({
      models: ["m"],
      reply: REPLY,
      ...(options.toolCall ? { toolCall: { name: "lookup", arguments: '{"q":"x"}' } } : {}),
      ...(options.reasoning ? { reasoning: "thinking…" } : {}),
    }).start();
    cleanup.push(() => stub.stop());
    url = `${stub.url}/v1`;
  }
  const app: FastifyInstance = buildApp(
    testConfig({
      backends: { b: { type: kind, url, ...(options.responseMs ? { timeouts: { responseMs: options.responseMs } } : {}) } },
      aliases: { chat: "b/m", other: "b/m" },
      keys: [
        { name: "full", key: FULL },
        { name: "restricted", key: RESTRICTED, models: ["chat"] },
        { name: "limited", key: LIMITED, limits: { requestsPerMinute: 1 } },
      ],
      server: { bodyLimitBytes: 64 * 1024 },
    }),
    { fastify: { logger: false } },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const as = (key: string) => new OpenAI({ apiKey: key, baseURL: `${address}/v1`, maxRetries: 0 });
  return {
    address,
    client: as(FULL),
    as,
    raw: (path, body, headers = {}) =>
      fetch(`${address}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${FULL}`, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
  };
}

const user = [{ role: "user" as const, content: "hi" }];

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

/** Runs a call and returns the error it threw (or null). */
async function failure(call: () => Promise<unknown>): Promise<InstanceType<typeof OpenAI.APIError> | null> {
  try {
    await call();
    return null;
  } catch (e) {
    return e as InstanceType<typeof OpenAI.APIError>;
  }
}

describe.each<Kind>(["ollama", "openai"])("conformance with a %s backend", (kind) => {
  describe("chat completions", () => {
    it("non-streaming: object, id, model, choice, usage", async () => {
      const { client } = await start(kind);
      const r = await client.chat.completions.create({ model: "chat", messages: user });
      expect(r).toMatchObject({ object: "chat.completion", model: "chat" });
      expect(r.id).toMatch(/^chatcmpl-/);
      expect(r.created).toBeGreaterThan(1_700_000_000);
      expect(r.choices).toEqual([
        { index: 0, message: { role: "assistant", content: REPLY, refusal: null }, logprobs: null, finish_reason: "stop" },
      ]);
      expect(r.usage?.total_tokens).toBe((r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0));
    });

    it("streaming: role first, content deltas, one finish, then usage and [DONE]", async () => {
      const { client } = await start(kind);
      const chunks = await drain(
        await client.chat.completions.create({ model: "chat", messages: user, stream: true, stream_options: { include_usage: true } }),
      );
      expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
      expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe(REPLY);
      expect(chunks.filter((c) => c.choices[0]?.finish_reason).map((c) => c.choices[0]?.finish_reason)).toEqual(["stop"]);
      expect(chunks.at(-1)?.choices).toEqual([]);
      expect(chunks.at(-1)?.usage?.completion_tokens).toBeGreaterThan(0);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    });

    it("finish_reason length when max_tokens cuts the answer, streaming or not", async () => {
      const { client } = await start(kind);
      const r = await client.chat.completions.create({ model: "chat", messages: user, max_completion_tokens: 1 });
      expect(r.choices[0]?.finish_reason).toBe("length");
      const chunks = await drain(await client.chat.completions.create({ model: "chat", messages: user, max_completion_tokens: 1, stream: true }));
      expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe("length");
    });

    it("tool calls, streaming or not", async () => {
      const { client } = await start(kind, { toolCall: true });
      const tools = [{ type: "function" as const, function: { name: "lookup", parameters: { type: "object" } } }];
      const r = await client.chat.completions.create({ model: "chat", messages: user, tools });
      expect(r.choices[0]?.finish_reason).toBe("tool_calls");
      expect(r.choices[0]?.message.tool_calls?.[0]).toMatchObject({ type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } });

      const chunks = await drain(await client.chat.completions.create({ model: "chat", messages: user, tools, stream: true }));
      const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
      expect(calls).toMatchObject([{ index: 0, type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }]);
      expect(calls[0]?.id).toBeTruthy();
    });

    it("the SDK's stream helper assembles the final message", async () => {
      const { client } = await start(kind);
      const runner = client.chat.completions.stream({ model: "chat", messages: user });
      const final = await runner.finalChatCompletion();
      expect(final.choices[0]?.message.content).toBe(REPLY);
    });

    it("reasoning models: reasoning_content next to the content", async () => {
      const { raw } = await start(kind, { reasoning: true });
      const body = (await (await raw("/v1/chat/completions", { model: "chat", messages: user })).json()) as {
        choices: { message: { reasoning_content?: string } }[];
      };
      expect(body.choices[0]?.message.reasoning_content).toBe("thinking…");
    });
  });

  describe("text completions", () => {
    it("non-streaming and streaming", async () => {
      const { client } = await start(kind);
      const r = await client.completions.create({ model: "chat", prompt: "Say hi" });
      expect(r).toMatchObject({ object: "text_completion", model: "chat" });
      expect(r.choices[0]).toEqual({ index: 0, text: REPLY, logprobs: null, finish_reason: "stop" });
      const chunks = await drain(await client.completions.create({ model: "chat", prompt: "Say hi", stream: true }));
      expect(chunks.map((c) => c.choices[0]?.text ?? "").join("")).toBe(REPLY);
      expect(new Set(chunks.map((c) => c.object))).toEqual(new Set(["text_completion"]));
    });
  });

  describe("embeddings", () => {
    it("float and the SDK's default base64 give the same vectors, in input order", async () => {
      const { client } = await start(kind);
      const floats = await client.embeddings.create({ model: "chat", input: ["a", "bb", "ccc"], encoding_format: "float" });
      const decoded = await client.embeddings.create({ model: "chat", input: ["a", "bb", "ccc"] });
      expect(floats).toMatchObject({ object: "list", model: "chat" });
      expect(floats.data.map((d) => d.index)).toEqual([0, 1, 2]);
      expect(decoded.data.map((d) => d.embedding)).toEqual(floats.data.map((d) => d.embedding));
      expect(floats.data.map((d) => d.embedding[0])).toEqual([1, 2, 3]);
    });
  });

  describe("models", () => {
    it("list and retrieve, with the SDK's pagination helper", async () => {
      const { client } = await start(kind);
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      expect(ids).toEqual(["chat", "other"]);
      expect(await client.models.retrieve("chat")).toMatchObject({ id: "chat", object: "model", owned_by: "local-llm-gateway" });
    });
  });

  describe("streaming edge cases", () => {
    it("the client aborting a stream cancels it without breaking the gateway", async () => {
      const { client } = await start(kind);
      const stream = await client.chat.completions.create({ model: "chat", messages: user, stream: true });
      stream.controller.abort();
      // The SDK simply stops iterating an aborted stream.
      expect((await drain(stream)).length).toBeLessThan(3);
      const again = await client.chat.completions.create({ model: "chat", messages: user });
      expect(again.choices[0]?.message.content).toBe(REPLY);
    });

    it("an error before the stream starts is a normal HTTP error", async () => {
      const { client } = await start(kind);
      const err = await failure(() => client.chat.completions.create({ model: "missing", messages: user, stream: true }));
      expect(err).toBeInstanceOf(OpenAI.NotFoundError);
    });
  });

  describe("error shapes", () => {
    const cases: [string, number, (f: Fixture) => Promise<unknown>, unknown, string | null][] = [
      ["invalid request", 400, (f) => f.client.chat.completions.create({ model: "chat", messages: [] }), OpenAI.BadRequestError, "invalid_value"],
      ["missing parameter", 400, (f) => f.raw("/v1/chat/completions", { model: "chat" }).then(rejectIfError), OpenAI.BadRequestError, "missing_required_parameter"],
      ["wrong key", 401, (f) => f.as("nope").chat.completions.create({ model: "chat", messages: user }), OpenAI.AuthenticationError, "invalid_api_key"],
      ["model not allowed", 403, (f) => f.as(RESTRICTED).chat.completions.create({ model: "other", messages: user }), OpenAI.PermissionDeniedError, "model_not_allowed"],
      ["unknown model", 404, (f) => f.client.embeddings.create({ model: "missing", input: "x" }), OpenAI.NotFoundError, "model_not_found"],
      ["unknown URL", 404, (f) => f.client.get("/does-not-exist"), OpenAI.NotFoundError, "unknown_url"],
      ["body too large", 413, (f) => f.client.chat.completions.create({ model: "chat", messages: [{ role: "user", content: "x".repeat(70_000) }] }), OpenAI.APIError, "request_too_large"],
      ["wrong content type", 415, (f) => f.raw("/v1/chat/completions", "x", { "content-type": "text/plain" }).then(rejectIfError), OpenAI.APIError, "unsupported_media_type"],
      [
        "rate limited",
        429,
        async (f) => {
          const c = f.as(LIMITED);
          await c.chat.completions.create({ model: "chat", messages: user });
          return c.chat.completions.create({ model: "chat", messages: user });
        },
        OpenAI.RateLimitError,
        "requests_rate_limit_exceeded",
      ],
    ];

    it.each(cases)("%s → %i", async (_name, status, call, ErrorClass, code) => {
      const f = await start(kind);
      const err = await failure(() => call(f));
      expect(err).toBeInstanceOf(ErrorClass as typeof OpenAI.APIError);
      expect(err?.status).toBe(status);
      expect(err?.code).toBe(code);
      // The body has OpenAI's four fields.
      expect(Object.keys(err?.error as object).sort()).toEqual(["code", "message", "param", "type"]);
      expect(typeof err?.message).toBe("string");
    });
  });
});

/** Turns a raw fetch error response into the SDK's error, so raw requests go through the same checks. */
async function rejectIfError(res: Response): Promise<unknown> {
  const body = (await res.json()) as { error: { message: string } };
  if (res.ok) return body;
  throw OpenAI.APIError.generate(res.status, body, body.error.message, res.headers);
}

describe("streaming edge cases at the byte level (Ollama)", () => {
  /** An Ollama stub whose /api/chat stream is written by `write`. */
  async function rawStream(write: (res: ServerResponse, line: (o: unknown) => string) => Promise<void> | void, responseMs?: number) {
    const stub = await new OllamaStub({
      handle: async (_req, body, res) => {
        if (body?.stream !== true) return false;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        await write(res, (o) => `${JSON.stringify(o)}\n`);
        return true;
      },
    }).start();
    const app = buildApp(
      testConfig({ backends: { ollama: { type: "ollama", url: stub.url, ...(responseMs ? { timeouts: { responseMs } } : {}) } } }),
      { fastify: { logger: false } },
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => stub.stop(), () => app.close());
    return new OpenAI({ apiKey: "test-key-0123456789abcdef", baseURL: `${address}/v1`, maxRetries: 0 });
  }
  const msg = (content: string, done = false) => ({ model: "m", message: { role: "assistant", content }, done, ...(done ? { done_reason: "stop", prompt_eval_count: 1, eval_count: 1 } : {}) });

  it("keeps a multi-byte character that is split across two network packets intact", async () => {
    const client = await rawStream(async (res, line) => {
      const bytes = Buffer.from(line(msg("ğüş🙂 tamam")), "utf8");
      // Split inside the emoji (4 bytes in UTF-8).
      const cut = bytes.indexOf(Buffer.from("🙂")) + 2;
      res.write(bytes.subarray(0, cut));
      await new Promise((r) => setTimeout(r, 30));
      res.write(bytes.subarray(cut));
      res.end(line(msg("", true)));
    });
    const chunks = await drain(await client.chat.completions.create({ model: "m", messages: user, stream: true }));
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("ğüş🙂 tamam");
  });

  it("handles several lines in one packet and a line split over many packets", async () => {
    const client = await rawStream(async (res, line) => {
      res.write(line(msg("a")) + line(msg("b")) + line(msg("c")));
      for (const ch of line(msg("d"))) {
        res.write(ch);
        await new Promise((r) => setImmediate(r));
      }
      res.end(line(msg("", true)));
    });
    const chunks = await drain(await client.chat.completions.create({ model: "m", messages: user, stream: true }));
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("abcd");
  });

  it("raises an error in the SDK when the backend dies or goes silent mid-stream", async () => {
    const dies = await rawStream(async (res, line) => {
      res.write(line(msg("partial ")));
      await new Promise((r) => setTimeout(r, 30));
      res.destroy();
    });
    await expect(drain(await dies.chat.completions.create({ model: "m", messages: user, stream: true }))).rejects.toThrow(/unavailable/);

    const silent = await rawStream((res, line) => {
      res.write(line(msg("partial ")));
    }, 200);
    await expect(drain(await silent.chat.completions.create({ model: "m", messages: user, stream: true }))).rejects.toThrow(/stopped sending data/);
  });
});
