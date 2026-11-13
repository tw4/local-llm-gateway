import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

/** The body OpenAI returns for every error; SDKs read `error.message` and pick the class by status. */
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "server_error"
  | "upstream_error"
  | "timeout_error";

/** Any error the gateway answers on purpose. Everything else becomes a generic 500. */
export class GatewayError extends Error {
  readonly status: number;
  readonly type: ErrorType;
  readonly code: string | null;
  readonly param: string | null;
  /** Extra response headers, e.g. Retry-After. */
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    options: { type: ErrorType; code?: string | null; param?: string | null; headers?: Record<string, string>; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "GatewayError";
    this.status = status;
    this.type = options.type;
    this.code = options.code ?? null;
    this.param = options.param ?? null;
    this.headers = options.headers ?? {};
  }

  toJSON(): OpenAIErrorBody {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
  }
}

export const errors = {
  badRequest: (message: string, param: string | null = null, code: string | null = null) =>
    new GatewayError(400, message, { type: "invalid_request_error", param, code }),

  missingApiKey: () =>
    new GatewayError(
      401,
      "You didn't provide an API key. Send it in the Authorization header as 'Bearer <key>'.",
      { type: "invalid_request_error", code: "missing_api_key", headers: { "www-authenticate": 'Bearer realm="local-llm-gateway"' } },
    ),

  invalidApiKey: () =>
    new GatewayError(401, "Incorrect API key provided.", {
      type: "invalid_request_error",
      code: "invalid_api_key",
      headers: { "www-authenticate": 'Bearer realm="local-llm-gateway", error="invalid_token"' },
    }),

  modelNotAllowed: (model: string) =>
    new GatewayError(403, `This API key is not allowed to use the model '${model}'.`, {
      type: "permission_error",
      param: "model",
      code: "model_not_allowed",
    }),

  modelNotFound: (model: string) =>
    new GatewayError(404, `The model '${model}' does not exist or you do not have access to it.`, {
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    }),

  rateLimited: (message: string, retryAfterSeconds: number, code = "rate_limit_exceeded") =>
    new GatewayError(429, message, {
      type: "rate_limit_error",
      code,
      headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    }),

  upstreamUnavailable: (backend: string, cause?: unknown) =>
    new GatewayError(502, `The backend '${backend}' is unavailable.`, { type: "upstream_error", code: "upstream_unavailable", cause }),

  upstreamTimeout: (backend: string, detail = "did not respond in time", cause?: unknown) =>
    new GatewayError(504, `The backend '${backend}' ${detail}.`, { type: "timeout_error", code: "upstream_timeout", cause }),

  /**
   * The backend answered with an error status.
   * - 400/413/422 and similar: the request itself was rejected (e.g. context too long), so the
   *   client gets the same status and can fix the request.
   * - 401/403: the gateway's credentials for the backend are wrong; not the client's fault → 502.
   * - 429: the backend is overloaded → 503, so SDKs retry instead of reporting the client's own limit.
   * - 5xx: → 502.
   */
  upstreamError: (backend: string, status: number, detail: string) => {
    const message = `The backend '${backend}' returned an error: ${detail}`;
    if (status === 429) {
      return new GatewayError(503, message, { type: "upstream_error", code: "upstream_overloaded" });
    }
    if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
      return new GatewayError(status, message, { type: "invalid_request_error", code: "upstream_rejected" });
    }
    return new GatewayError(502, message, { type: "upstream_error", code: "upstream_error" });
  },
};

/** Sends an error in the OpenAI shape. */
export function sendError(reply: FastifyReply, err: GatewayError): FastifyReply {
  return reply.code(err.status).headers(err.headers).type("application/json").send(err.toJSON());
}

/** Maps Fastify's own errors (bad JSON, body too large, …) to the OpenAI shape. */
function fromFastifyError(err: FastifyError): GatewayError | null {
  switch (err.code) {
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return errors.badRequest(
        "We could not parse the JSON body of your request. Check that it is valid JSON and that the Content-Type header is application/json.",
        null,
        "invalid_json",
      );
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return new GatewayError(413, "The request body is too large.", { type: "invalid_request_error", code: "request_too_large" });
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return new GatewayError(415, "Unsupported Content-Type. Send application/json.", {
        type: "invalid_request_error",
        code: "unsupported_media_type",
      });
    case "FST_ERR_VALIDATION":
      return errors.badRequest(err.message, null, "invalid_request");
    default:
      if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
        return new GatewayError(err.statusCode, err.message, { type: "invalid_request_error" });
      }
      return null;
  }
}

/** Every error and unknown route answers in the OpenAI error format. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const mapped = err instanceof GatewayError ? err : fromFastifyError(err);
    if (mapped) {
      if (mapped.status >= 500) request.log.warn({ err }, mapped.message);
      return sendError(reply, mapped);
    }
    // Unexpected: log the details, never send them (they may include internals).
    request.log.error({ err }, "unhandled error");
    return sendError(
      reply,
      new GatewayError(500, "The gateway had an internal error while processing your request.", {
        type: "server_error",
        code: "internal_error",
      }),
    );
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(
      reply,
      new GatewayError(404, `Invalid URL (${request.method} ${request.url.split("?")[0] ?? ""})`, {
        type: "invalid_request_error",
        code: "unknown_url",
      }),
    ),
  );
}
