import type { FastifyBaseLogger } from "fastify";
import type { Backend } from "./backends/types.js";

export interface BackendHealth {
  healthy: boolean;
  /** Unix ms of the last completed check; null before the first one. */
  checkedAt: number | null;
  /** Last failure, for logs only (never sent to clients). */
  error: string | null;
}

export type OverallStatus = "ok" | "degraded" | "unavailable" | "starting";

export interface HealthMonitorOptions {
  intervalMs: number;
  timeoutMs: number;
  log?: FastifyBaseLogger;
  /** Called after every check, e.g. to update metrics. */
  onChange?: (backend: string, health: BackendHealth) => void;
}

/** Checks every backend periodically and keeps the latest result. */
export class HealthMonitor {
  private readonly state = new Map<string, BackendHealth>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly backends: Map<string, Backend>,
    private readonly options: HealthMonitorOptions,
  ) {
    for (const name of backends.keys()) this.state.set(name, { healthy: false, checkedAt: null, error: null });
  }

  /** Runs one round of checks now (concurrent calls share the same round). */
  checkAll(): Promise<void> {
    this.running ??= Promise.all([...this.backends.values()].map((b) => this.check(b))).then(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(backend: Backend): Promise<void> {
    const before = this.state.get(backend.name);
    let next: BackendHealth;
    try {
      await backend.checkHealth({ signal: AbortSignal.timeout(this.options.timeoutMs) });
      next = { healthy: true, checkedAt: Date.now(), error: null };
    } catch (err) {
      next = { healthy: false, checkedAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
    }
    this.state.set(backend.name, next);
    // Log transitions only (and a backend that is down from the start), not every check.
    const firstCheck = before?.checkedAt == null;
    const changed = firstCheck ? !next.healthy : before.healthy !== next.healthy;
    if (changed) {
      if (next.healthy) this.options.log?.info({ backend: backend.name }, "backend is healthy again");
      else this.options.log?.warn({ backend: backend.name, error: next.error }, "backend is unhealthy");
    }
    this.options.onChange?.(backend.name, next);
  }

  /** Checks once now, then every intervalMs. */
  start(): Promise<void> {
    this.stop();
    this.timer = setInterval(() => void this.checkAll(), this.options.intervalMs);
    this.timer.unref();
    return this.checkAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(name: string): BackendHealth | undefined {
    return this.state.get(name);
  }

  summary(): { status: OverallStatus; healthy: number; total: number } {
    const all = [...this.state.values()];
    const total = all.length;
    const healthy = all.filter((h) => h.healthy).length;
    let status: OverallStatus;
    if (all.every((h) => h.checkedAt === null)) status = "starting";
    else if (healthy === total) status = "ok";
    else if (healthy > 0) status = "degraded";
    else status = "unavailable";
    return { status, healthy, total };
  }
}
