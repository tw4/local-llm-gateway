import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerAuth } from "./auth.js";
import { createBackends } from "./backends/index.js";
import type { Config } from "./config/schema.js";
import { registerErrorHandling } from "./errors.js";
import { createModelResolver } from "./models.js";
import { registerChatRoutes } from "./routes/chat.js";
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
  const ctx: RouteContext = { config, backends, resolveModel: createModelResolver(config, backends) };
  registerChatRoutes(app, ctx);
  return app;
}
