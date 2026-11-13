import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerAuth } from "./auth.js";
import { createBackends } from "./backends/index.js";
import type { Config } from "./config/schema.js";
import { registerErrorHandling } from "./errors.js";
import { HealthMonitor } from "./health.js";
import { createModelResolver } from "./models.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerCompletionRoutes } from "./routes/completions.js";
import { registerEmbeddingRoutes } from "./routes/embeddings.js";
import { registerModelRoutes } from "./routes/models.js";
import type { RouteContext } from "./routes/context.js";

export interface AppOptions {
  /** Extra Fastify options (tests pass `logger: false`). */
  fastify?: FastifyServerOptions;
}

/** Builds the HTTP app without listening, so tests can use `app.inject()`. */
export function buildApp(config: Config, options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logging.level },
    bodyLimit: config.server.bodyLimitBytes,
    ...options.fastify,
  });
  registerErrorHandling(app);
  registerAuth(app, config.keys);

  const backends = createBackends(config);
  const health = new HealthMonitor(backends, { ...config.healthCheck, log: app.log });
  // The first round of checks finishes before the server accepts connections.
  app.addHook("onReady", () => health.start());
  app.addHook("onClose", (_instance, done) => {
    health.stop();
    done();
  });

  const ctx: RouteContext = { config, backends, health, resolveModel: createModelResolver(config, backends) };
  registerHealthRoutes(app, health);
  registerChatRoutes(app, ctx);
  registerCompletionRoutes(app, ctx);
  registerEmbeddingRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  return app;
}
