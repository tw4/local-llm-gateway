import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { UsageEvent } from "./usage.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Labels and timings collected while handling a /v1 request, for metrics and logs. */
    gw: RequestInfo;
  }
}

export interface RequestInfo {
  /** ms since epoch. */
  startedAt: number;
  /** "chat", "completions", "embeddings", "models"; empty for other paths. */
  endpoint: string;
  /** The resolved alias; empty until the model is known to exist (keeps label values bounded). */
  model: string;
  backend: string;
  /** `code` of the error the request ended with, if any. */
  errorCode: string | null;
  /** When the first streamed chunk was sent (ms since epoch), for time to first token. */
  firstChunkAt: number | null;
}

export const newRequestInfo = (): RequestInfo => ({ startedAt: Date.now(), endpoint: "", model: "", backend: "", errorCode: null, firstChunkAt: null });

/** Error codes that mean the backend, not the client, had a problem. */
const UPSTREAM_KINDS: Record<string, string> = {
  upstream_unavailable: "unavailable",
  upstream_timeout: "timeout",
  model_not_found: "model_not_found",
  upstream_error: "error",
  upstream_overloaded: "overloaded",
  upstream_rejected: "rejected",
};

const PREFIX = "llm_gateway_";
// LLM requests range from milliseconds (embeddings) to minutes (long generations).
const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300];

export class Metrics {
  readonly registry = new Registry();

  private readonly requests = new Counter({
    name: `${PREFIX}requests_total`,
    help: "Requests to /v1 endpoints, by key, alias, endpoint and HTTP status.",
    labelNames: ["key", "model", "endpoint", "status"] as const,
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: `${PREFIX}request_duration_seconds`,
    help: "Time from request to the end of the response (the whole stream for streamed responses).",
    labelNames: ["key", "model", "endpoint"] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly firstChunk = new Histogram({
    name: `${PREFIX}time_to_first_chunk_seconds`,
    help: "Time from request to the first streamed chunk with content (time to first token).",
    labelNames: ["key", "model", "endpoint"] as const,
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  private readonly tokens = new Counter({
    name: `${PREFIX}tokens_total`,
    help: "Tokens used, by key, alias and type (prompt or completion).",
    labelNames: ["key", "model", "type"] as const,
    registers: [this.registry],
  });

  private readonly estimated = new Counter({
    name: `${PREFIX}tokens_estimated_requests_total`,
    help: "Streamed requests whose tokens were estimated because the stream ended early.",
    labelNames: ["key", "model"] as const,
    registers: [this.registry],
  });

  private readonly upstreamErrors = new Counter({
    name: `${PREFIX}upstream_errors_total`,
    help: "Failures caused by a backend: unavailable, timeout, model_not_found, overloaded, rejected or error.",
    labelNames: ["backend", "model", "kind"] as const,
    registers: [this.registry],
  });

  private readonly rateLimited = new Counter({
    name: `${PREFIX}rate_limited_total`,
    help: "Requests refused by a rate limit, by key and limit (requests or tokens).",
    labelNames: ["key", "limit"] as const,
    registers: [this.registry],
  });

  private readonly backendUp = new Gauge({
    name: `${PREFIX}backend_up`,
    help: "1 if the backend's last health check succeeded, 0 otherwise.",
    labelNames: ["backend"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: PREFIX });
  }

  /** Called once per /v1 request, after the response (or stream) has ended. */
  observeRequest(key: string, info: RequestInfo, status: number, endedAt: number): void {
    const labels = { key, model: info.model, endpoint: info.endpoint || "other" };
    this.requests.inc({ ...labels, status: String(status) });
    this.duration.observe(labels, (endedAt - info.startedAt) / 1000);
    if (info.firstChunkAt !== null) this.firstChunk.observe(labels, (info.firstChunkAt - info.startedAt) / 1000);
    const kind = info.errorCode ? UPSTREAM_KINDS[info.errorCode] : undefined;
    if (kind && info.backend) this.upstreamErrors.inc({ backend: info.backend, model: info.model, kind });
    if (info.errorCode === "requests_rate_limit_exceeded") this.rateLimited.inc({ key, limit: "requests" });
    if (info.errorCode === "tokens_rate_limit_exceeded") this.rateLimited.inc({ key, limit: "tokens" });
  }

  observeUsage(e: UsageEvent): void {
    this.tokens.inc({ key: e.key, model: e.model, type: "prompt" }, e.promptTokens);
    this.tokens.inc({ key: e.key, model: e.model, type: "completion" }, e.completionTokens);
    if (e.estimated) this.estimated.inc({ key: e.key, model: e.model });
  }

  setBackendUp(backend: string, up: boolean): void {
    this.backendUp.set({ backend }, up ? 1 : 0);
  }
}
