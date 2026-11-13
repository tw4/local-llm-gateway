import { readFileSync } from "node:fs";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { configSchema, type Config } from "./schema.js";

/** Thrown for any problem with the configuration; `problems` lists every one found. */
export class ConfigError extends Error {
  constructor(
    readonly source: string,
    readonly problems: string[],
  ) {
    super(`Invalid configuration (${source}):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface LoadOptions {
  /** Path of the YAML (or JSON) file. Defaults to $LLM_GATEWAY_CONFIG, then ./config.yaml. */
  path?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_CONFIG_PATH = "config.yaml";

/** Reads, interpolates, overrides and validates the configuration. Throws ConfigError. */
export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env;
  const path = options.path ?? env.LLM_GATEWAY_CONFIG ?? DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(path, [
      code === "ENOENT"
        ? `file not found. Create it (see config.example.yaml) or set LLM_GATEWAY_CONFIG to its path`
        : `cannot read the file: ${(err as Error).message}`,
    ]);
  }
  return parseConfig(text, { source: path, env });
}

/** Same as loadConfig, from text. */
export function parseConfig(text: string, options: { source?: string; env?: NodeJS.ProcessEnv } = {}): Config {
  const source = options.source ?? "config";
  const env = options.env ?? process.env;

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const where = err instanceof YAMLParseError && err.linePos ? ` at line ${err.linePos[0].line}` : "";
    throw new ConfigError(source, [`not valid YAML${where}: ${(err as Error).message.split("\n")[0] ?? ""}`]);
  }
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(source, ["the top level must be a mapping (key: value)"]);
  }

  const missing: string[] = [];
  const interpolated = interpolate(raw, env, [], missing);
  if (missing.length > 0) throw new ConfigError(source, missing);

  applyEnvOverrides(interpolated as Record<string, unknown>, env);

  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(
      source,
      result.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`),
    );
  }
  return result.data;
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces `${NAME}` and `${NAME:-default}` in every string value. The result stays a string;
 * the schema converts it where a number or boolean is expected, so `port: ${PORT}` works
 * while an all-digit API key stays a string.
 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: PropertyKey[], missing: string[]): unknown {
  if (typeof value === "string") {
    return value.replace(VAR, (_m, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      missing.push(`${formatPath(path)}: environment variable ${name} is not set`);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, [...path, i], missing));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, env, [...path, k], missing)]),
    );
  }
  return value;
}

/** A few settings that are commonly set per deployment can be overridden directly. */
function applyEnvOverrides(cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const section = (name: string): Record<string, unknown> => {
    const s = cfg[name];
    if (s !== null && typeof s === "object" && !Array.isArray(s)) return s as Record<string, unknown>;
    const created: Record<string, unknown> = {};
    cfg[name] = created;
    return created;
  };
  if (env.LLM_GATEWAY_HOST) section("server").host = env.LLM_GATEWAY_HOST;
  if (env.LLM_GATEWAY_PORT) section("server").port = env.LLM_GATEWAY_PORT;
  if (env.LLM_GATEWAY_LOG_LEVEL) section("logging").level = env.LLM_GATEWAY_LOG_LEVEL;
}
