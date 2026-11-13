import type { FastifyInstance } from "fastify";
import { bearerToken, createKeyMatcher } from "../auth.js";
import type { Config } from "../config/schema.js";
import { errors } from "../errors.js";
import type { Metrics } from "../metrics.js";

/** GET /metrics in the Prometheus text format, optionally behind a bearer token. */
export function registerMetricsRoute(app: FastifyInstance, metrics: Metrics, config: Config["metrics"]): void {
  if (!config.enabled) return;
  // Same constant-time comparison as API keys.
  const matches = config.token ? createKeyMatcher([{ name: "metrics", key: config.token }]) : null;

  app.get("/metrics", async (request, reply) => {
    if (matches) {
      const token = bearerToken(request.headers.authorization);
      if (token === null) throw errors.missingApiKey();
      if (!matches(token)) throw errors.invalidApiKey();
    }
    return reply
      .header("content-type", metrics.registry.contentType)
      .header("cache-control", "no-store")
      .send(await metrics.registry.metrics());
  });
}
