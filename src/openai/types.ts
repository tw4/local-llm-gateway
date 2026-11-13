// The parts of the OpenAI API the gateway speaks. Requests are validated in ./validate.ts.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string | undefined } };

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Tool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name?: string; schema?: Record<string, unknown>; strict?: boolean | null } };

/** Sampling options shared by chat and text completions. */
export interface SamplingOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
}

export interface ChatCompletionRequest extends SamplingOptions {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  include_usage: boolean;
  tools?: Tool[];
  tool_choice?: unknown;
  response_format?: ResponseFormat;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint: string | null;
  choices: {
    index: number;
    message: { role: "assistant"; content: string | null; refusal: null; tool_calls?: ToolCall[]; reasoning_content?: string };
    logprobs: null;
    finish_reason: FinishReason;
  }[];
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint: string | null;
  choices: {
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: (ToolCall & { index: number })[];
    };
    logprobs: null;
    finish_reason: FinishReason | null;
  }[];
  usage?: Usage | null;
}

export interface CompletionRequest extends SamplingOptions {
  model: string;
  prompt: string;
  suffix?: string;
  stream: boolean;
  include_usage: boolean;
}

export interface EmbeddingRequest {
  model: string;
  input: string[];
  encoding_format: "float" | "base64";
  dimensions?: number;
}

export interface EmbeddingResult {
  embeddings: number[][];
  promptTokens: number;
}

export interface ModelInfo {
  id: string;
  /** Unix seconds. */
  created: number;
}

/** What a backend returns for a chat request, before the gateway fills in id, model and timestamps. */
export interface ChatResult {
  content: string | null;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

/** One streamed piece from a backend. The last one carries finishReason and usage. */
export interface ChatDelta {
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: FinishReason;
  usage?: Usage;
}
