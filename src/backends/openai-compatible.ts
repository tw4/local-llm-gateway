import type { BackendConfig } from "../config/schema.js";
import { errors } from "../errors.js";
import type {
  ChatCompletionRequest,
  ChatDelta,
  ChatResult,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResult,
  FinishReason,
  ModelInfo,
  SamplingOptions,
  ToolCall,
  Usage,
} from "../openai/types.js";
import type { Agent } from "undici";
import { createAgent, Deadline, lines, upstreamFetch, upstreamJson, type UpstreamRequest, type UpstreamResponse as HttpResponse } from "./http.js";
import type { Backend, CallOptions } from "./types.js";

// Any server that speaks the OpenAI API: llama.cpp server, LM Studio, vLLM, Ollama's /v1, …
// `url` is the base URL including /v1, e.g. http://localhost:8081/v1.

interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface UpstreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface UpstreamChoice {
  index?: number;
  message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: ToolCall[] };
  delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: UpstreamToolCallDelta[] };
  text?: string;
  finish_reason?: string | null;
}

interface UpstreamResponse {
  choices?: UpstreamChoice[];
  usage?: UpstreamUsage | null;
  error?: { message?: string } | string;
}

const FINISH: ReadonlySet<string> = new Set(["stop", "length", "tool_calls", "content_filter"]);

function finishReason(value: string | null | undefined, sawToolCalls: boolean): FinishReason {
  if (sawToolCalls && (value === "tool_calls" || value === "stop" || !value)) return "tool_calls";
  // Older servers say "function_call"; anything unknown is treated as a normal stop.
  if (value === "function_call") return "tool_calls";
  return value && FINISH.has(value) ? (value as FinishReason) : "stop";
}

function usageFrom(u: UpstreamUsage | null | undefined): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: u?.total_tokens ?? prompt + completion };
}

function errorText(e: UpstreamResponse["error"]): string {
  return typeof e === "string" ? e : (e?.message ?? "unknown error");
}

/** The sampling fields, under the names the OpenAI API uses. */
function samplingBody(s: SamplingOptions): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (s.temperature !== undefined) b.temperature = s.temperature;
  if (s.top_p !== undefined) b.top_p = s.top_p;
  if (s.max_tokens !== undefined) b.max_tokens = s.max_tokens;
  if (s.stop !== undefined) b.stop = s.stop;
  if (s.seed !== undefined) b.seed = s.seed;
  if (s.presence_penalty !== undefined) b.presence_penalty = s.presence_penalty;
  if (s.frequency_penalty !== undefined) b.frequency_penalty = s.frequency_penalty;
  return b;
}

/** Reads `data:` events from an SSE stream; multi-line data is joined, comments are skipped. */
async function* sseEvents(res: HttpResponse, backend: string, deadline: Deadline): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(res, backend, deadline)) {
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:`, `id:`, `retry:` and `:` comments are ignored.
  }
  if (data.length > 0) yield data.join("\n");
}

/**
 * Turns an upstream chunk stream into deltas. Tool calls arrive in pieces (name first,
 * arguments in fragments, keyed by index); they are assembled and emitted whole before the
 * finish, which every client handles.
 */
async function* deltasFrom(events: AsyncGenerator<string>, backend: string, field: "delta" | "text"): AsyncGenerator<ChatDelta> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let finish: string | null = null;
  let usage: UpstreamUsage | null = null;
  let done = false;

  for await (const data of events) {
    if (data === "[DONE]") {
      done = true;
      break;
    }
    const chunk = JSON.parse(data) as UpstreamResponse;
    if (chunk.error) throw errors.upstreamError(backend, 500, errorText(chunk.error));
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      const delta: ChatDelta = {};
      const content = field === "text" ? choice.text : choice.delta?.content;
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (content) delta.content = content;
      if (reasoning) delta.reasoning = reasoning;
      for (const tc of choice.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const call = calls.get(i) ?? { id: "", name: "", arguments: "" };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(i, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      if (Object.keys(delta).length > 0) yield delta;
    }
  }
  if (!done && finish === null) throw errors.upstreamUnavailable(backend);

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: c.arguments } }));
  const last: ChatDelta = { finishReason: finishReason(finish, toolCalls.length > 0) };
  // Left out when the server did not report it, so the gateway knows the counts are unknown.
  if (usage) last.usage = usageFrom(usage);
  if (toolCalls.length > 0) last.toolCalls = toolCalls;
  yield last;
}

export class OpenAICompatibleBackend implements Backend {
  readonly type = "openai";
  private readonly agent: Agent;

  constructor(
    readonly name: string,
    private readonly config: BackendConfig,
  ) {
    this.agent = createAgent(config.timeouts);
  }

  private request(path: string, deadline: Deadline | AbortSignal, model: string, body?: unknown): UpstreamRequest {
    return {
      backend: this.name,
      url: `${this.config.url}${path}`,
      body,
      ...(deadline instanceof Deadline ? { deadline } : { signal: deadline }),
      headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
      agent: this.agent,
    };
  }

  private readonly onError = (model: string) => (status: number, detail: string) =>
    status === 404 && /model/i.test(detail) ? errors.modelNotFound(model) : undefined;

  private async json<T extends { error?: UpstreamResponse["error"] }>(path: string, signal: AbortSignal, model: string, body?: unknown): Promise<T> {
    const deadline = new Deadline(this.name, signal, this.config.timeouts.responseMs);
    const r = await upstreamJson<T>(this.request(path, deadline, model, body), this.onError(model));
    if (r.error) throw errors.upstreamError(this.name, 500, errorText(r.error));
    return r;
  }

  private async stream(path: string, body: Record<string, unknown>, signal: AbortSignal, model: string, field: "delta" | "text"): Promise<AsyncIterable<ChatDelta>> {
    const deadline = new Deadline(this.name, signal, this.config.timeouts.responseMs);
    // Always ask for usage, so streamed requests can be counted.
    const res = await upstreamFetch(
      this.request(path, deadline, model, { ...body, stream: true, stream_options: { include_usage: true } }),
      this.onError(model),
    );
    return deltasFrom(sseEvents(res, this.name, deadline), this.name, field);
  }

  private chatBody(req: ChatCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, ...samplingBody(req) };
    if (req.tools?.length) body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
    if (req.response_format) body.response_format = req.response_format;
    return body;
  }

  async chat(req: ChatCompletionRequest, { signal }: CallOptions): Promise<ChatResult> {
    const r = await this.json<UpstreamResponse>("/chat/completions", signal, req.model, this.chatBody(req));
    const choice = r.choices?.[0];
    const toolCalls = choice?.message?.tool_calls?.length ? choice.message.tool_calls : undefined;
    const result: ChatResult = {
      content: choice?.message?.content ?? (toolCalls ? null : ""),
      finishReason: finishReason(choice?.finish_reason, toolCalls !== undefined),
      usage: usageFrom(r.usage),
    };
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
    if (reasoning) result.reasoning = reasoning;
    if (toolCalls) result.toolCalls = toolCalls;
    return result;
  }

  chatStream(req: ChatCompletionRequest, { signal }: CallOptions): Promise<AsyncIterable<ChatDelta>> {
    return this.stream("/chat/completions", this.chatBody(req), signal, req.model, "delta");
  }

  private completionBody(req: CompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...samplingBody(req) };
    if (req.suffix !== undefined) body.suffix = req.suffix;
    return body;
  }

  async complete(req: CompletionRequest, { signal }: CallOptions): Promise<ChatResult> {
    const r = await this.json<UpstreamResponse>("/completions", signal, req.model, this.completionBody(req));
    const choice = r.choices?.[0];
    return { content: choice?.text ?? "", finishReason: finishReason(choice?.finish_reason, false), usage: usageFrom(r.usage) };
  }

  completeStream(req: CompletionRequest, { signal }: CallOptions): Promise<AsyncIterable<ChatDelta>> {
    return this.stream("/completions", this.completionBody(req), signal, req.model, "text");
  }

  async embed(req: EmbeddingRequest, { signal }: CallOptions): Promise<EmbeddingResult> {
    // Always floats from upstream; the gateway encodes base64 itself if the client asked for it.
    const body: Record<string, unknown> = { model: req.model, input: req.input, encoding_format: "float" };
    if (req.dimensions !== undefined) body.dimensions = req.dimensions;
    const r = await this.json<{ data?: { index: number; embedding: number[] }[]; usage?: UpstreamUsage; error?: UpstreamResponse["error"] }>(
      "/embeddings",
      signal,
      req.model,
      body,
    );
    const data = [...(r.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== req.input.length || !data.every((d) => Array.isArray(d.embedding))) {
      throw errors.upstreamError(this.name, 500, "unexpected embeddings response");
    }
    return { embeddings: data.map((d) => d.embedding), promptTokens: r.usage?.prompt_tokens ?? 0 };
  }

  async listModels({ signal }: CallOptions): Promise<ModelInfo[]> {
    const r = await this.json<{ data?: { id: string; created?: number }[]; error?: UpstreamResponse["error"] }>("/models", signal, "");
    return (r.data ?? []).map((m) => ({ id: m.id, created: m.created ?? 0 }));
  }

  async checkHealth({ signal }: CallOptions): Promise<void> {
    await upstreamJson(this.request("/models", signal, ""));
  }
}
