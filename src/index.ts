import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { installShutdownHandlers } from "./shutdown.js";

// A local .env fills in variables that are not already set (the real environment wins).
if (existsSync(".env")) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) {
    process.env[name] ??= value;
  }
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  // Fail fast with every problem listed, before anything starts.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const app = buildApp(config);

installShutdownHandlers(app, {
  timeoutMs: 10_000,
  log: (m) => {
    app.log.info(m);
  },
});

try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
