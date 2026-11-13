export interface Closable {
  close(): Promise<unknown>;
}

export interface ShutdownOptions {
  /** How long in-flight requests get to finish before the process exits anyway. */
  timeoutMs: number;
  signals?: NodeJS.Signals[];
  /** Injected for tests. */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  process?: Pick<NodeJS.Process, "once" | "removeListener">;
}

/**
 * On SIGTERM/SIGINT: stop accepting connections and let in-flight requests finish.
 * If closing takes longer than `timeoutMs`, or a second signal arrives, exit immediately.
 * Returns a function that removes the handlers.
 */
export function installShutdownHandlers(server: Closable, options: ShutdownOptions): () => void {
  const proc = options.process ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? (() => undefined);
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let closing = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (closing) {
      log(`Received ${signal} again, exiting now`);
      exit(1);
      return;
    }
    closing = true;
    log(`Received ${signal}, shutting down`);
    const timer = setTimeout(() => {
      log(`Shutdown took longer than ${options.timeoutMs} ms, exiting`);
      exit(1);
    }, options.timeoutMs);
    timer.unref();
    server.close().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        log(`Error during shutdown: ${String(err)}`);
        exit(1);
      },
    );
    // Listen again so a second signal is handled (once() removed the first listener).
    proc.once(signal, onSignal);
  };

  for (const s of signals) proc.once(s, onSignal);
  return () => {
    for (const s of signals) proc.removeListener(s, onSignal);
  };
}
