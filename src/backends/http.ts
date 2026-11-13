import { errors, GatewayError } from "../errors.js";

export interface UpstreamRequest {
  backend: string;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  signal: AbortSignal;
}

/** Finds the errno-style code anywhere in an error's cause chain. */
function causeCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === "string") return e.code;
  }
  return undefined;
}

/** Turns a failed fetch into the gateway's error (or rethrows the abort). */
export function mapFetchError(backend: string, err: unknown, signal: AbortSignal): never {
  if (signal.aborted) {
    // Our own cancellation (client gone) or a timeout: the reason says which.
    const reason: unknown = signal.reason;
    if (reason instanceof GatewayError) throw reason;
    throw err;
  }
  const code = causeCode(err);
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    throw errors.upstreamTimeout(backend, err);
  }
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

/** fetch() with the gateway's error mapping. Returns the response only if it is 2xx. */
export async function upstreamFetch(req: UpstreamRequest, onErrorStatus?: (status: number, detail: string) => GatewayError | undefined): Promise<Response> {
  let res: Response;
  try {
    const init: RequestInit = {
      method: req.method ?? (req.body === undefined ? "GET" : "POST"),
      headers: { accept: "application/json", ...(req.body === undefined ? {} : { "content-type": "application/json" }), ...req.headers },
      signal: req.signal,
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    res = await fetch(req.url, init);
  } catch (err) {
    mapFetchError(req.backend, err, req.signal);
  }
  if (!res.ok) {
    const detail = await upstreamErrorDetail(res);
    throw onErrorStatus?.(res.status, detail) ?? errors.upstreamError(req.backend, res.status, detail);
  }
  return res;
}

/** Splits a byte stream into lines (NDJSON, SSE), handling chunks that end mid-line. */
export async function* lines(body: ReadableStream<Uint8Array>, backend: string, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        mapFetchError(backend, err, signal);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
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
    // Stops the upstream body if the consumer stopped early (client disconnected).
    await reader.cancel().catch(() => undefined);
  }
}
