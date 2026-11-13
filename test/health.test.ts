import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { Backend } from "../src/backends/types.js";
import { HealthMonitor } from "../src/health.js";
import { startGateway } from "./gateway.js";
import { testConfig } from "./helpers.js";
import { OllamaStub } from "./stubs/ollama.js";

describe("health endpoints", () => {
  it("serves /livez and /healthz without a key and reveals no configuration", async () => {
    const { address, stub } = await startGateway();
    const live = await fetch(`${address}/livez`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    const health = await fetch(`${address}/healthz`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    const text = await health.text();
    expect(JSON.parse(text)).toEqual({ status: "ok", backends: { healthy: 1, total: 1 } });
    expect(text).not.toContain("ollama");
    expect(text).not.toContain(stub.url);
    expect(stub.last("/api/version")).toBeDefined();
  });

  it("answers 503 unavailable once the only backend goes down", async () => {
    const { address, stub } = await startGateway({}, { healthCheck: { intervalMs: 50, timeoutMs: 500 } });
    await stub.stop();
    await expect
      .poll(async () => {
        const res = await fetch(`${address}/healthz`);
        return [res.status, ((await res.json()) as { status: string }).status];
      })
      .toEqual([503, "unavailable"]);
  });

  it("reports degraded (still 200) when only some backends are up", async () => {
    const down = await new OllamaStub().start();
    await down.stop();
    const up = await new OllamaStub().start();
    const app = buildApp(
      testConfig({
        backends: { a: { type: "ollama", url: up.url }, b: { type: "ollama", url: down.url } },
        healthCheck: { intervalMs: 60_000, timeoutMs: 500 },
      }),
      { fastify: { logger: false } },
    );
    await app.ready();
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "degraded", backends: { healthy: 1, total: 2 } });
    await app.close();
    await up.stop();
  });

  it("does not require a key and is not affected by one", async () => {
    const { address } = await startGateway();
    const res = await fetch(`${address}/healthz`, { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(200);
  });
});

describe("HealthMonitor", () => {
  const backend = (name: string, healthy: () => boolean): Backend =>
    ({
      name,
      checkHealth: () => (healthy() ? Promise.resolve() : Promise.reject(new Error(`${name} down`))),
    }) as unknown as Backend;

  it("is 'starting' before the first check and tracks recoveries", async () => {
    let up = false;
    const log = { info: vi.fn(), warn: vi.fn() };
    const changes: boolean[] = [];
    const monitor = new HealthMonitor(new Map([["x", backend("x", () => up)]]), {
      intervalMs: 60_000,
      timeoutMs: 1000,
      log: log as never,
      onChange: (_name, h) => changes.push(h.healthy),
    });
    expect(monitor.summary().status).toBe("starting");

    await monitor.checkAll();
    expect(monitor.summary()).toEqual({ status: "unavailable", healthy: 0, total: 1 });
    expect(monitor.get("x")?.error).toBe("x down");
    expect(log.warn).toHaveBeenCalledTimes(1);

    await monitor.checkAll();
    expect(log.warn).toHaveBeenCalledTimes(1); // no repeated warning while still down

    up = true;
    await monitor.checkAll();
    expect(monitor.summary().status).toBe("ok");
    expect(log.info).toHaveBeenCalledWith({ backend: "x" }, "backend is healthy again");
    expect(changes).toEqual([false, false, true]);
  });

  it("times out a check that hangs", async () => {
    const hanging = { name: "slow", checkHealth: ({ signal }: { signal: AbortSignal }) => new Promise((_r, reject) => { signal.addEventListener("abort", () => { reject(new Error("timed out")); }); }) };
    const monitor = new HealthMonitor(new Map([["slow", hanging as unknown as Backend]]), { intervalMs: 60_000, timeoutMs: 50 });
    await monitor.checkAll();
    expect(monitor.get("slow")).toMatchObject({ healthy: false, error: "timed out" });
  });

  it("checks periodically after start()", async () => {
    let calls = 0;
    const counting = { name: "c", checkHealth: () => ((calls += 1), Promise.resolve()) };
    const monitor = new HealthMonitor(new Map([["c", counting as unknown as Backend]]), { intervalMs: 20, timeoutMs: 1000 });
    await monitor.start();
    await expect.poll(() => calls).toBeGreaterThanOrEqual(3);
    monitor.stop();
  });
});
