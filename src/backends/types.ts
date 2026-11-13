import type {
  ChatCompletionRequest,
  ChatDelta,
  ChatResult,
  CompletionRequest,
  EmbeddingRequest,
  EmbeddingResult,
  ModelInfo,
} from "../openai/types.js";

export interface CallOptions {
  /** Aborted when the client disconnects (or a timeout fires); the upstream request is cancelled. */
  signal: AbortSignal;
}

/**
 * An inference server. Requests and results are in OpenAI terms; each implementation
 * translates to its own API. `model` is always the backend's real model name.
 */
export interface Backend {
  readonly name: string;
  readonly type: string;

  chat(request: ChatCompletionRequest, options: CallOptions): Promise<ChatResult>;

  /**
   * Starts a streamed chat. Resolves once the backend has accepted the request (so errors
   * such as an unknown model are still reported as a normal HTTP error), then yields deltas.
   */
  chatStream(request: ChatCompletionRequest, options: CallOptions): Promise<AsyncIterable<ChatDelta>>;

  /** Text completion; the result's `content` is the generated text. */
  complete(request: CompletionRequest, options: CallOptions): Promise<ChatResult>;
  completeStream(request: CompletionRequest, options: CallOptions): Promise<AsyncIterable<ChatDelta>>;

  embed(request: EmbeddingRequest, options: CallOptions): Promise<EmbeddingResult>;

  /** Models the backend serves, by their real names. */
  listModels(options: CallOptions): Promise<ModelInfo[]>;
}
