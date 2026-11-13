import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

export interface AppOptions {
  /** Passed through to Fastify (logger, body limit, …). */
  fastify?: FastifyServerOptions;
}

/** Builds the HTTP app without listening, so tests can use `app.inject()`. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ ...options.fastify });
  return app;
}
