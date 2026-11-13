import type { FastifyInstance } from "fastify";
import type { HealthMonitor } from "../health.js";

/**
 * Unauthenticated health endpoints. They report only counts and a status word: no
 * backend names, URLs or models, so they reveal nothing about the configuration.
 */
export function registerHealthRoutes(app: FastifyInstance, monitor: HealthMonitor): void {
  /** Liveness: the gateway process is serving requests. Use this for container restarts. */
  app.get("/livez", () => ({ status: "ok" }));

  /**
   * Readiness: can the gateway serve model requests? 200 while at least one backend is up
   * ("ok" or "degraded"), 503 when none is ("unavailable") or none has been checked yet.
   */
  app.get("/healthz", (_request, reply) => {
    const { status, healthy, total } = monitor.summary();
    const ready = status === "ok" || status === "degraded";
    return reply
      .code(ready ? 200 : 503)
      .header("cache-control", "no-store")
      .send({ status, backends: { healthy, total } });
  });
}
