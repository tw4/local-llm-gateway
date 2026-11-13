import { z } from "zod";
import { errors } from "../errors.js";
import type { ChatCompletionRequest, ChatMessage, CompletionRequest, EmbeddingRequest, SamplingOptions } from "./types.js";

// Unknown fields are accepted and ignored (clients send `user`, `logit_bias`, …), so
// objects are not strict. Known fields are checked so mistakes get a clear 400.

const stop = z
  .union([z.string(), z.array(z.string()).max(4)])
  .nullish()
  .transform((s) => (s == null ? undefined : typeof s === "string" ? [s] : s));

const sampling = {
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  /** Newer name for max_tokens in the chat API. */
  max_completion_tokens: z.number().int().positive().nullish(),
  stop,
  seed: z.number().int().nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  frequency_penalty: z.number().min(-2).max(2).nullish(),
  n: z
    .number()
    .int()
    .nullish()
    .refine((n) => n == null || n === 1, { message: "only n=1 is supported" }),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
};

const contentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string(), detail: z.string().optional() }) }),
]);

const toolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPart)]).nullish(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).nullish(),
  tool_call_id: z.string().optional(),
});

const tool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const responseFormat = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  tools: z.array(tool).nullish(),
  tool_choice: z.unknown().optional(),
  response_format: responseFormat.nullish(),
  ...sampling,
});

/** Turns the first validation problem into an OpenAI 400 with `param` set. */
function fail(error: z.ZodError): never {
  const issue = error.issues[0];
  const param = issue?.path.length ? issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : null;
  const missing = issue?.code === "invalid_type" && issue.input === undefined;
  const message = missing ? `Missing required parameter: '${param ?? ""}'.` : `Invalid value for '${param ?? "body"}': ${issue?.message ?? "invalid"}.`;
  throw errors.badRequest(message, param, missing ? "missing_required_parameter" : "invalid_value");
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw errors.badRequest("The request body must be a JSON object.", null, "invalid_body");
  }
  const result = schema.safeParse(body);
  if (!result.success) fail(result.error);
  return result.data;
}

const definedOnly = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

function samplingFrom(b: z.infer<z.ZodObject<typeof sampling>>): SamplingOptions {
  return definedOnly({
    temperature: b.temperature ?? undefined,
    top_p: b.top_p ?? undefined,
    max_tokens: b.max_completion_tokens ?? b.max_tokens ?? undefined,
    stop: b.stop,
    seed: b.seed ?? undefined,
    presence_penalty: b.presence_penalty ?? undefined,
    frequency_penalty: b.frequency_penalty ?? undefined,
  }) as SamplingOptions;
}

export function parseChatRequest(body: unknown): ChatCompletionRequest {
  const b = parse(chatSchema, body);
  return definedOnly({
    model: b.model,
    messages: b.messages.map((m) => {
      // `content` stays even when null (an assistant message that only calls tools).
      const msg: ChatMessage = { role: m.role, content: m.content ?? null };
      if (m.name !== undefined) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    stream: b.stream ?? false,
    include_usage: b.stream_options?.include_usage ?? false,
    tools: b.tools ?? undefined,
    tool_choice: b.tool_choice,
    response_format: b.response_format ?? undefined,
    ...samplingFrom(b),
  }) as ChatCompletionRequest;
}

const completionSchema = z.object({
  model: z.string().min(1),
  // OpenAI accepts a list of prompts (one choice each); one prompt per request is supported here.
  prompt: z.union([
    z.string(),
    z
      .array(z.string())
      .length(1, { message: "only a single prompt per request is supported" }),
  ]),
  suffix: z.string().nullish(),
  echo: z
    .boolean()
    .nullish()
    .refine((e) => e !== true, { message: "echo is not supported" }),
  best_of: z
    .number()
    .int()
    .nullish()
    .refine((b) => b == null || b === 1, { message: "only best_of=1 is supported" }),
  ...sampling,
});

export function parseCompletionRequest(body: unknown): CompletionRequest {
  const b = parse(completionSchema, body);
  return definedOnly({
    model: b.model,
    prompt: typeof b.prompt === "string" ? b.prompt : (b.prompt[0] ?? ""),
    suffix: b.suffix ?? undefined,
    stream: b.stream ?? false,
    include_usage: b.stream_options?.include_usage ?? false,
    ...samplingFrom(b),
  }) as CompletionRequest;
}

const embeddingSchema = z.object({
  model: z.string().min(1),
  input: z.union(
    [
      z.string(),
      z.array(z.string()).min(1).max(2048),
    ],
    { message: "must be a string or an array of strings (token arrays are not supported)" },
  ),
  encoding_format: z.enum(["float", "base64"]).nullish(),
  dimensions: z.number().int().positive().nullish(),
});

export function parseEmbeddingRequest(body: unknown): EmbeddingRequest {
  const b = parse(embeddingSchema, body);
  const req: EmbeddingRequest = {
    model: b.model,
    input: typeof b.input === "string" ? [b.input] : b.input,
    encoding_format: b.encoding_format ?? "float",
  };
  if (b.dimensions != null) req.dimensions = b.dimensions;
  return req;
}
