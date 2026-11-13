import { Agent, fetch, type RequestInit, type Response } from "undici";
import { errors, GatewayError } from "../errors.js";

export interface Timeouts {
  /** TCP/TLS connection setup. */
  connectMs: number;
  /** Longest silence: before the response starts, and between streamed chunks. */
  responseMs: number;
}

/** One connection pool per backend, with its connect timeout. Our own timers handle the rest. */
export function createAgent(timeouts: Timeouts): Agent {
  return new Agent({ connect: { timeout: timeouts.connectMs }, headersTimeout: 0, bodyTimeout: 0 });
}

/**
 * Cancellation for one upstream call: the client's signal (disconnect) combined with the
 * response timeout, which restarts whenever the backend sends something. Ollama sends no
 * headers until a non-streamed answer is complete, and nothing while it loads a model, so
 * "silence" is the only timeout that is fair to slow hardware and still catches a hung
 * backend.
 */
export class Deadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(
    private readonly backend: string,
    client: AbortSignal,
    private readonly responseMs: number,
  ) {
    this.signal = AbortSignal.any([client, this.controller.signal]);
    this.progress();
  }

  /** The backend sent something (headers, a chunk): restart the silence timer. */
  progress(): void {
    clearTimeout(this.timer);
    const detail = this.started ? `stopped sending data for ${this.responseMs} ms` : `did not start responding within ${this.responseMs} ms`;
    this.timer = setTimeout(() => {
      this.controller.abort(errors.upstreamTimeout(this.backend, detail));
    }, this.responseMs);
    this.timer.unref();
  }

  /** Headers arrived. */
  responding(): void {
    this.started = true;
    this.progress();
  }

  done(): void {
    clearTimeout(this.timer);
  }
}

export interface UpstreamRequest {
  backend: string;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Either a deadline (model calls) or a plain signal (health checks). */
  deadline?: Deadline;
  signal?: AbortSignal;
  agent?: Agent;
}

/** Finds the errno-style code anywhere in an error's cause chain. */
function causeCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === "string") return e.code;
  }
  return undefined;
}

/**
 * Turns a failed request into the gateway's error: a timeout (504), the backend being
 * unreachable (502), or the client's own cancellation (rethrown as is).
 */
export function mapFetchError(backend: string, err: unknown, signal: AbortSignal | undefined): never {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof GatewayError) throw reason;
    throw err;
  }
  if (err instanceof GatewayError) throw err;
  const code = causeCode(err);
  if (code === "UND_ERR_CONNECT_TIMEOUT") throw errors.upstreamTimeout(backend, "could not be reached in time", err);
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") throw errors.upstreamTimeout(backend, undefined, err);
  // ECONNREFUSED, ENOTFOUND, ECONNRESET, a socket closed mid-response, …
  throw errors.upstreamUnavailable(backend, err);
}

/** Reads the error message an upstream put in its body (`{ error: "…" }` or `{ error: { message } }`). */
export async function upstreamErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

type OnErrorStatus = (status: number, detail: string) => GatewayError | undefined;

/** Sends a request; resolves once a 2xx response's headers arrived, maps everything else. */
export async function upstreamFetch(req: UpstreamRequest, onErrorStatus?: OnErrorStatus): Promise<Response> {
  const signal = req.deadline?.signal ?? req.signal;
  let res: Response;
  try {
    const init: RequestInit = {
      method: req.method ?? (req.body === undefined ? "GET" : "POST"),
      headers: { accept: "application/json", ...(req.body === undefined ? {} : { "content-type": "application/json" }), ...req.headers },
      ...(signal ? { signal } : {}),
      ...(req.agent ? { dispatcher: req.agent } : {}),
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    res = await fetch(req.url, init);
  } catch (err) {
    req.deadline?.done();
    mapFetchError(req.backend, err, signal);
  }
  req.deadline?.responding();
  if (!res.ok) {
    const detail = await upstreamErrorDetail(res);
    req.deadline?.done();
    throw onErrorStatus?.(res.status, detail) ?? errors.upstreamError(req.backend, res.status, detail);
  }
  return res;
}

/** Sends a request and reads a JSON response, with the same error mapping. */
export async function upstreamJson<T>(req: UpstreamRequest, onErrorStatus?: OnErrorStatus): Promise<T> {
  const res = await upstreamFetch(req, onErrorStatus);
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    mapFetchError(req.backend, err, req.deadline?.signal ?? req.signal);
  } finally {
    req.deadline?.done();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw errors.upstreamError(req.backend, 502, "the response was not valid JSON");
  }
}

/**
 * Splits a streamed body into lines (NDJSON, SSE), handling chunks that end mid-line.
 * Every chunk restarts the deadline's silence timer.
 */
export async function* lines(res: Response, backend: string, deadline: Deadline): AsyncGenerator<string> {
  if (!res.body) throw errors.upstreamUnavailable(backend);
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        mapFetchError(backend, err, deadline.signal);
      }
      if (chunk.done) break;
      deadline.progress();
      buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    deadline.done();
    // Stops the upstream body if the consumer stopped early (client disconnected).
    await reader.cancel().catch(() => undefined);
  }
}
