declare module "fastify" {
  interface FastifyRequest {
    /** Tokens used by this request, once known (for the log line). */
    tokenUsage: UsageEvent | null;
  }
  interface FastifyInstance {
    /** Token usage per key and model since start. */
    usage: UsageTracker;
  }
}

export type Endpoint = "chat" | "completions" | "embeddings";

/** Tokens used by one request. */
export interface UsageEvent {
  /** API key name (never the key). */
  key: string;
  /** The alias the client asked for. */
  model: string;
  endpoint: Endpoint;
  promptTokens: number;
  completionTokens: number;
  /**
   * True when the backend never reported the counts (a stream the client cut short or that
   * failed): the completion is then estimated as one token per streamed chunk.
   */
  estimated: boolean;
}

export interface UsageTotals {
  key: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/** Totals per key and model since the gateway started, and a hook for each request. */
export class UsageTracker {
  private readonly totals = new Map<string, UsageTotals>();
  private readonly listeners: ((event: UsageEvent) => void)[] = [];

  record(event: UsageEvent): void {
    const id = `${event.key}\u0000${event.model}`;
    const t = this.totals.get(id) ?? { key: event.key, model: event.model, requests: 0, promptTokens: 0, completionTokens: 0 };
    t.requests += 1;
    t.promptTokens += event.promptTokens;
    t.completionTokens += event.completionTokens;
    this.totals.set(id, t);
    for (const listener of this.listeners) listener(event);
  }

  /** Called for every recorded request (metrics, rate limits). */
  onRecord(listener: (event: UsageEvent) => void): void {
    this.listeners.push(listener);
  }

  snapshot(): UsageTotals[] {
    return [...this.totals.values()].map((t) => ({ ...t }));
  }
}

/**
 * Counts a stream: exact numbers when the backend reports them at the end, otherwise an
 * estimate from the chunks seen. `finish()` must be called exactly once, in a `finally`.
 */
export class StreamUsage {
  private chunks = 0;
  private exact: { prompt: number; completion: number } | null = null;
  private finished = false;

  constructor(private readonly report: (promptTokens: number, completionTokens: number, estimated: boolean) => void) {}

  chunk(): void {
    this.chunks += 1;
  }

  final(promptTokens: number, completionTokens: number): void {
    this.exact = { prompt: promptTokens, completion: completionTokens };
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.exact) this.report(this.exact.prompt, this.exact.completion, false);
    else if (this.chunks > 0) this.report(0, this.chunks, true);
  }
}
