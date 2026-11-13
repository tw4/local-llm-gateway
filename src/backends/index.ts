import type { Config } from "../config/schema.js";
import { OllamaBackend } from "./ollama.js";
import type { Backend } from "./types.js";

/** Creates one client per configured backend. */
export function createBackends(config: Config): Map<string, Backend> {
  const backends = new Map<string, Backend>();
  for (const [name, cfg] of Object.entries(config.backends)) {
    switch (cfg.type) {
      case "ollama":
        backends.set(name, new OllamaBackend(name, cfg));
        break;
      case "openai":
        throw new Error(`backends.${name}: type "openai" is not supported yet`);
    }
  }
  return backends;
}

export type { Backend } from "./types.js";
