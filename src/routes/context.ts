import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimiter } from "../ratelimit.js";
import type { Endpoint, UsageEvent, UsageTracker } from "../usage.js";
import type { Backend } from "../backends/types.js";
import type { Config } from "../config/schema.js";
import { GatewayError } from "../errors.js";
import type { HealthMonitor } from "../health.js";
import type { ModelResolver, ResolvedModel } from "../models.js";

/** Everything the /v1 routes need, created once in buildApp. */
export interface RouteContext {
  config: Config;
  backends: Map<string, Backend>;
  health: HealthMonitor;
  usage: UsageTracker;
  limiter: RateLimiter;
  resolveModel: ModelResolver;
}

/** Returns a function that records the tokens of this request (and keeps them for the log line). */
export function usageRecorder(
  ctx: RouteContext,
  request: FastifyRequest,
  target: ResolvedModel,
  endpoint: Endpoint,
): (promptTokens: number, completionTokens: number, estimated: boolean) => void {
  return (promptTokens, completionTokens, estimated) => {
    const event: UsageEvent = { key: request.apiKey?.name ?? "", model: target.requested, endpoint, promptTokens, completionTokens, estimated };
    request.tokenUsage = event;
    ctx.usage.record(event);
  };
}

/** Raised as the abort reason when the client goes away. */
export class ClientDisconnected extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientDisconnected";
  }
}

/**
 * An AbortController that fires when the client disconnects before the response is
 * complete, so the upstream request is cancelled and the backend stops generating.
 */
export function abortOnDisconnect(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) controller.abort(new ClientDisconnected());
  });
  return controller;
}

/** Errors from the backend mention its real model name; replace them with the client's. */
export function hideModelName(err: unknown, target: ResolvedModel): unknown {
  if (err instanceof GatewayError && err.code === "model_not_found") {
    return new GatewayError(404, `The model '${target.requested}' does not exist or you do not have access to it.`, {
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    });
  }
  if (err instanceof GatewayError && err.message.includes(target.model) && target.model !== target.requested) {
    return new GatewayError(err.status, err.message.split(target.model).join(target.requested), {
      type: err.type,
      code: err.code,
      param: err.param,
      headers: err.headers,
    });
  }
  return err;
}
