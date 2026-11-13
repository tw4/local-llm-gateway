import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerAuth } from "./auth.js";
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

/** Builds the HTTP app without listening, so tests can use `app.inject()`. */
export function buildApp(config: Config, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    // One access line per request instead of Fastify's two (see logging.ts).
    disableRequestLogging: true,
    genReqId,
    requestIdLogLabel: "reqId",
    bodyLimit: config.server.bodyLimitBytes,
    ...options.fastify,
  });

  // Per-request labels and timings, filled in by the routes and the error handler.
  app.decorateRequest("gw", null as never);
  app.addHook("onRequest", (request, _reply, done) => {
    request.gw = newRequestInfo();
    done();
  });
  registerAccessLog(app, config);
  registerErrorHandling(app);
  registerAuth(app, config.keys);

  const metrics = new Metrics();
  app.decorate("metrics", metrics);
  // Every /v1 request, once its response (or stream) has ended.
  app.addHook("onResponse", (request, reply, done) => {
    if (request.url.startsWith("/v1/")) {
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
