import type { Backend } from "./backends/types.js";
import type { Config } from "./config/schema.js";
import { errors } from "./errors.js";

export interface ResolvedModel {
  /** What the client asked for; the only name the client ever sees. */
  requested: string;
  backend: Backend;
  /** The backend's real model name. */
  model: string;
}

export type ModelResolver = (requested: string) => ResolvedModel;

/**
 * Maps the model a client asks for to a backend and its real model name.
 * With aliases configured, only aliases are accepted. Without any, the name is passed
 * through to the first backend, which is enough for a single local Ollama.
 */
export function createModelResolver(config: Config, backends: Map<string, Backend>): ModelResolver {
  const aliases = new Map(Object.entries(config.aliases));
  const first = backends.values().next().value;
  return (requested) => {
    const alias = aliases.get(requested);
    if (alias) {
      const backend = backends.get(alias.backend);
      // The config schema guarantees the backend exists.
      if (!backend) throw new Error(`alias ${requested} points at unknown backend ${alias.backend}`);
      return { requested, backend, model: alias.model };
    }
    if (aliases.size === 0 && first) return { requested, backend: first, model: requested };
    throw errors.modelNotFound(requested);
  };
}
