import Fastify, { type FastifyInstance, type FastifyServerOptions, LogController } from "fastify";
import { isApiPath, registerAuth, servedPath } from "./auth.js";
import { createBackends } from "./backends/index.js";
import type { Config } from "./config/schema.js";
import { registerErrorHandling } from "./errors.js";
import { HealthMonitor } from "./health.js";
import { genReqId, loggerOptions, type LogStream, registerAccessLog } from "./logging.js";
import { Metrics, newRequestInfo } from "./metrics.js";
import { createModelResolver } from "./models.js";
import { RateLimiter } from "./ratelimit.js";
import { UsageTracker } from "./usage.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerCompletionRoutes } from "./routes/completions.js";
import { registerEmbeddingRoutes } from "./routes/embeddings.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { registerModelRoutes } from "./routes/models.js";
import type { RouteContext } from "./routes/context.js";

declare module "fastify" {
  interface FastifyInstance {
    metrics: Metrics;
  }
}

export interface AppOptions {
  /** Extra Fastify options (tests pass `logger: false`). */
  fastify?: FastifyServerOptions;
  /** Where log lines go instead of stdout (tests). */
  logStream?: LogStream;
}

/** Shortest key length that is not reported as guessable at startup. */
export const MIN_KEY_LENGTH = 24;

/** Keys are bearer secrets with no lockout: short ones can be guessed, so say so loudly. */
function warnWeakKeys(app: FastifyInstance, config: Config): void {
  for (const k of config.keys) {
    if (k.key.length < MIN_KEY_LENGTH) {
      app.log.warn(
        { key: k.name },
        `API key "${k.name}" is only ${k.key.length} characters long; use at least ${MIN_KEY_LENGTH} random characters (e.g. openssl rand -hex 32)`,
      );
    }
  }
  if (config.metrics.enabled && !config.metrics.token && config.server.host !== "127.0.0.1" && config.server.host !== "localhost") {
    app.log.warn("/metrics is served without a token on a public interface; it shows key names and aliases (set metrics.token)");
  }
}

/** Builds the HTTP app without listening, so tests can use `app.inject()`. */
export function buildApp(config: Config, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    // One access line per request instead of Fastify's two (see logging.ts).
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "reqId" }),
    genReqId,
    bodyLimit: config.server.bodyLimitBytes,
    requestTimeout: config.server.requestTimeoutMs,
    // Handed to http.createServer as well, because Fastify only assigns requestTimeout after
    // the server exists: Node then keeps its 60 s headersTimeout, and silently ignores any
    // requestTimeout shorter than that. Node also checks timeouts only every 30 s by default.
    http: {
      requestTimeout: config.server.requestTimeoutMs,
      headersTimeout: Math.min(60_000, config.server.requestTimeoutMs),
      connectionsCheckingInterval: Math.max(100, Math.min(5_000, Math.floor(config.server.requestTimeoutMs / 2))),
    },
    ...options.fastify,
  });

  // Per-request labels and timings, filled in by the routes and the error handler.
  app.decorateRequest("gw", null as never);
  app.addHook("onRequest", (request, _reply, done) => {
    request.gw = newRequestInfo();
    done();
  });
  // The OpenAI API speaks JSON only: anything else gets 415 instead of reaching the routes.
  app.removeContentTypeParser("text/plain");
  warnWeakKeys(app, config);
  registerAccessLog(app, config);
  registerErrorHandling(app);
  registerAuth(app, config.keys);

  const metrics = new Metrics();
  app.decorate("metrics", metrics);
  // Every /v1 request, once its response (or stream) has ended.
  app.addHook("onResponse", (request, reply, done) => {
    if (isApiPath(servedPath(request))) {
      metrics.observeRequest(request.apiKey?.name ?? "unauthenticated", request.gw, reply.statusCode, Date.now());
    }
    done();
  });

  const backends = createBackends(config);
  const health = new HealthMonitor(backends, {
    ...config.healthCheck,
    log: app.log,
    onChange: (name, h) => {
      metrics.setBackendUp(name, h.healthy);
    },
  });
  // The first round of checks finishes before the server accepts connections.
  app.addHook("onReady", () => health.start());
  app.addHook("onClose", (_instance, done) => {
    health.stop();
    done();
  });

  const usage = new UsageTracker();
  const limiter = new RateLimiter(config.limits);
  usage.onRecord((e) => {
    // Tokens are charged when a response is complete (or estimated, for a stream cut short).
    limiter.charge(e.key, e.promptTokens + e.completionTokens);
    metrics.observeUsage(e);
  });
  app.decorateRequest("tokenUsage", null);
  app.decorate("usage", usage);

  const ctx: RouteContext = { config, backends, health, usage, limiter, resolveModel: createModelResolver(config, backends) };
  registerHealthRoutes(app, health);
  registerMetricsRoute(app, metrics, config.metrics);
  registerChatRoutes(app, ctx);
  registerCompletionRoutes(app, ctx);
  registerEmbeddingRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  return app;
}
