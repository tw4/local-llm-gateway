import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { Config } from "./config/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Text the model produced, kept only when logging.logBodies is on. */
    completionText: string | null;
  }
}

/** Where log lines go (tests capture them); stdout by default. */
export interface LogStream {
  write(line: string): void;
}

/** Anything that might hold a secret is masked, wherever it shows up in a log object. */
const REDACT = [
  "req.headers.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "authorization",
  "*.authorization",
  "apiKey",
  "*.apiKey",
  "key.key",
  "*.key.key",
];

/** pino options for the gateway: JSON lines, secrets masked, an optional stream (tests). */
export function loggerOptions(config: Config, stream?: LogStream): NonNullable<FastifyServerOptions["logger"]> {
  return {
    level: config.logging.level,
    redact: { paths: REDACT, censor: "[redacted]" },
    ...(stream ? { stream } : {}),
  };
}

const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Uses the client's X-Request-Id when it is safe to log, otherwise a new UUID. */
export function genReqId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  return typeof header === "string" && VALID_REQUEST_ID.test(header) ? header : randomUUID();
}

/**
 * One JSON line per request when it ends (Fastify's own two lines are turned off):
 * request id, key name, alias, endpoint, backend, status, timings and tokens. Prompt and
 * completion bodies are added only with logging.logBodies.
 */
export function registerAccessLog(app: FastifyInstance, config: Config): void {
  const logBodies = config.logging.logBodies;
  app.decorateRequest("completionText", null);

  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });

  if (logBodies) {
    // Keep the non-streamed response body for the log line; streams collect their text in the routes.
    app.addHook("onSend", (request, _reply, payload, done) => {
      if (typeof payload === "string" && request.completionText === null) request.completionText = payload;
      done(null, payload);
    });
  }

  app.addHook("onResponse", (request, reply, done) => {
    const gw = request.gw;
    const status = reply.statusCode;
    // reqId and the key's name are already on request.log (Fastify and the auth hook bind them).
    const line: Record<string, unknown> = {
      method: request.method,
      path: request.url.split("?", 1)[0],
      status,
      durationMs: Math.round(reply.elapsedTime),
    };
    if (gw.endpoint) line.endpoint = gw.endpoint;
    if (gw.model) line.model = gw.model;
    if (gw.backend) line.backend = gw.backend;
    if (gw.firstChunkAt !== null) line.firstChunkMs = gw.firstChunkAt - gw.startedAt;
    if (request.tokenUsage) {
      line.tokens = {
        prompt: request.tokenUsage.promptTokens,
        completion: request.tokenUsage.completionTokens,
        ...(request.tokenUsage.estimated ? { estimated: true } : {}),
      };
    }
    if (gw.errorCode) line.error = gw.errorCode;
    if (logBodies) {
      line.requestBody = request.body;
      line.responseBody = request.completionText;
    }
    const message = "request completed";
    if (status >= 500 || (gw.errorCode !== null && status < 400)) request.log.warn(line, message);
    else request.log.info(line, message);
    done();
  });
}
