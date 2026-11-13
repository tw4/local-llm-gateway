import { randomUUID } from "node:crypto";
import type { BackendConfig } from "../config/schema.js";
import { errors } from "../errors.js";
import type {
  ChatCompletionRequest,
  ChatDelta,
  ChatMessage,
  ChatResult,
  FinishReason,
  SamplingOptions,
  ToolCall,
  Usage,
} from "../openai/types.js";
import { lines, upstreamFetch } from "./http.js";
import type { Backend, CallOptions } from "./types.js";

// Ollama's native API: https://github.com/ollama/ollama/blob/main/docs/api.md

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i;

/** Converts OpenAI messages to Ollama's: text parts joined, images as base64, tool calls as objects. */
export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((m, i) => {
    let content = "";
    const images: string[] = [];
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      const texts: string[] = [];
      m.content.forEach((part, j) => {
        if (part.type === "text") texts.push(part.text);
        else {
          const data = DATA_URL.exec(part.image_url.url)?.[1];
          // Fetching remote images would let clients make the gateway call arbitrary URLs.
          if (!data) {
            throw errors.badRequest(
              "Only base64 data URLs (data:image/...;base64,...) are supported for images.",
              `messages[${i}].content[${j}].image_url.url`,
              "unsupported_image_url",
            );
          }
          images.push(data);
        }
      });
      content = texts.join("\n");
    }

    const out: OllamaMessage = {
      role: m.role === "developer" ? "system" : m.role,
      content,
    };
    if (images.length > 0) out.images = images;
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        toolNames.set(tc.id, tc.function.name);
        return { function: { name: tc.function.name, arguments: parseArguments(tc.function.arguments) } };
      });
    }
    if (m.role === "tool" && m.tool_call_id) {
      const name = toolNames.get(m.tool_call_id);
      if (name) out.tool_name = name;
    }
    return out;
  });
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI sampling parameters → Ollama `options`. */
export function toOllamaOptions(s: SamplingOptions): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (s.temperature !== undefined) o.temperature = s.temperature;
  if (s.top_p !== undefined) o.top_p = s.top_p;
  if (s.max_tokens !== undefined) o.num_predict = s.max_tokens;
  if (s.stop !== undefined) o.stop = s.stop;
  if (s.seed !== undefined) o.seed = s.seed;
  if (s.presence_penalty !== undefined) o.presence_penalty = s.presence_penalty;
  if (s.frequency_penalty !== undefined) o.frequency_penalty = s.frequency_penalty;
  return o;
}

function toolCallsFrom(calls: OllamaToolCall[] | undefined): ToolCall[] | undefined {
  if (!calls?.length) return undefined;
  return calls.map((c) => ({
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) },
  }));
}

function usageFrom(r: OllamaChatResponse): Usage {
  const prompt = r.prompt_eval_count ?? 0;
  const completion = r.eval_count ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function finishReason(r: OllamaChatResponse, sawToolCalls: boolean): FinishReason {
  if (sawToolCalls) return "tool_calls";
  return r.done_reason === "length" ? "length" : "stop";
}

export class OllamaBackend implements Backend {
  readonly type = "ollama";

  constructor(
    readonly name: string,
    private readonly config: BackendConfig,
  ) {}

  private chatBody(req: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOllamaMessages(req.messages),
      stream,
      options: toOllamaOptions(req),
    };
    if (req.tools?.length && req.tool_choice !== "none") body.tools = req.tools;
    if (req.response_format?.type === "json_object") body.format = "json";
    if (req.response_format?.type === "json_schema") body.format = req.response_format.json_schema.schema ?? "json";
    return body;
  }

  private post(path: string, body: unknown, signal: AbortSignal, model: string): Promise<Response> {
    return upstreamFetch({ backend: this.name, url: `${this.config.url}${path}`, body, signal }, (status, detail) =>
      // Ollama answers 404 "model 'x' not found"; the route replaces the name with the one the client used.
      status === 404 && /model/i.test(detail) ? errors.modelNotFound(model) : undefined,
    );
  }

  async chat(req: ChatCompletionRequest, { signal }: CallOptions): Promise<ChatResult> {
    const res = await this.post("/api/chat", this.chatBody(req, false), signal, req.model);
    const r = (await res.json()) as OllamaChatResponse;
    if (r.error) throw errors.upstreamError(this.name, 500, r.error);
    const toolCalls = toolCallsFrom(r.message?.tool_calls);
    const result: ChatResult = {
      content: r.message?.content ?? "",
      finishReason: finishReason(r, toolCalls !== undefined),
      usage: usageFrom(r),
    };
    if (r.message?.thinking) result.reasoning = r.message.thinking;
    if (toolCalls) result.toolCalls = toolCalls;
    return result;
  }

  async chatStream(req: ChatCompletionRequest, { signal }: CallOptions): Promise<AsyncIterable<ChatDelta>> {
    const res = await this.post("/api/chat", this.chatBody(req, true), signal, req.model);
    if (!res.body) throw errors.upstreamUnavailable(this.name);
    const body = res.body;
    const name = this.name;
    return (async function* () {
      let sawToolCalls = false;
      for await (const line of lines(body, name, signal)) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as OllamaChatResponse;
        if (r.error) throw errors.upstreamError(name, 500, r.error);
        const delta: ChatDelta = {};
        if (r.message?.content) delta.content = r.message.content;
        if (r.message?.thinking) delta.reasoning = r.message.thinking;
        const toolCalls = toolCallsFrom(r.message?.tool_calls);
        if (toolCalls) {
          delta.toolCalls = toolCalls;
          sawToolCalls = true;
        }
        if (r.done) {
          delta.finishReason = finishReason(r, sawToolCalls);
          delta.usage = usageFrom(r);
        }
        if (Object.keys(delta).length > 0) yield delta;
        if (r.done) return;
      }
      // The stream ended without `done`: the backend went away mid-response.
      throw errors.upstreamUnavailable(name);
    })();
  }
}
