import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";
import { installShutdownHandlers } from "../src/shutdown.js";

function fakeProcess() {
  const emitter = new EventEmitter();
  return {
    proc: {
      once: (event: string, listener: (...args: unknown[]) => void) => emitter.once(event, listener),
      removeListener: (event: string, listener: (...args: unknown[]) => void) => emitter.removeListener(event, listener),
    } as unknown as Pick<NodeJS.Process, "once" | "removeListener">,
    signal: (s: NodeJS.Signals) => emitter.emit(s, s),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("graceful shutdown", () => {
  it("lets an in-flight request finish before exiting with 0", async () => {
    const app = buildApp(testConfig(), { fastify: { logger: false } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.get("/slow", async () => {
      await gate;
      return { ok: true };
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const { proc, signal } = fakeProcess();
    const exit = vi.fn();
    installShutdownHandlers(app, { timeoutMs: 5_000, exit, process: proc });

    const response = fetch(`${address}/slow`);
    // Give the request time to reach the handler before shutting down.
    await new Promise((r) => setTimeout(r, 50));
    signal("SIGTERM");
    expect(exit).not.toHaveBeenCalled();

    release();
    const res = await response;
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("exits with 1 when closing takes longer than the timeout", () => {
    vi.useFakeTimers();
    const { proc, signal } = fakeProcess();
    const exit = vi.fn();
    installShutdownHandlers({ close: () => new Promise(() => undefined) }, { timeoutMs: 1_000, exit, process: proc });

    signal("SIGINT");
    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits immediately on a second signal", () => {
    const { proc, signal } = fakeProcess();
    const exit = vi.fn();
    installShutdownHandlers({ close: () => new Promise(() => undefined) }, { timeoutMs: 60_000, exit, process: proc });

    signal("SIGTERM");
    signal("SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("can be uninstalled", () => {
    const { proc, signal } = fakeProcess();
    const exit = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const uninstall = installShutdownHandlers({ close }, { timeoutMs: 1_000, exit, process: proc });

    uninstall();
    signal("SIGTERM");
    expect(close).not.toHaveBeenCalled();
  });
});
