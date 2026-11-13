import { z } from "zod";

/** Values from `${VAR}` arrive as strings; accept "8080" where a number is expected. */
const fromString = (v: unknown) => (typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v);
const int = () => z.preprocess(fromString, z.number().int());
const positiveInt = z.preprocess(fromString, z.number().int().positive());
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());

const httpUrl = z
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "must start with http:// or https://" })
  // A trailing slash would produce `//api/...` when paths are appended.
  .transform((u) => u.replace(/\/+$/, ""));

/** A name used in URLs, logs and metric labels. */
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
    message: "may only contain letters, digits, '.', '_', ':' and '-', and must start with a letter or digit",
  });

const timeoutsSchema = z
  .object({
    /** Time to establish the TCP/TLS connection. Exceeded: 504, the backend could not be reached in time. */
    connectMs: positiveInt.default(5_000),
    /**
     * Longest silence from the backend: before the response starts (model loading, or a whole
     * non-streamed answer, since Ollama sends nothing until it is done) and between streamed
     * chunks. Each chunk restarts it, so long streams are fine. Exceeded: 504.
     */
    responseMs: positiveInt.default(300_000),
  })
  .strict();

export const backendSchema = z
  .object({
    /** `ollama` uses Ollama's native API; `openai` any OpenAI-compatible server (llama.cpp, LM Studio, vLLM). */
    type: z.enum(["ollama", "openai"]),
    url: httpUrl,
    /** Sent as `Authorization: Bearer` to the upstream, for servers that require one. */
    apiKey: z.string().min(1).optional(),
    timeouts: timeoutsSchema.prefault({}),
  })
  .strict();

const aliasObject = z
  .object({
    backend: identifier,
    /** The model name on the backend, e.g. `qwen3:8b`. */
    model: z.string().min(1),
  })
  .strict();

/**
 * `{ backend: ollama, model: qwen3:8b }`, or the short form `ollama/qwen3:8b`. In the short
 * form only the first `/` separates the backend, so `ollama/hf.co/org/model:Q4` works.
 */
export const aliasSchema = z.union([
  aliasObject,
  z
    .string()
    .regex(/^[^/]+\/.+$/, { message: 'use "backend/model" or { backend, model }' })
    .transform((s) => {
      const i = s.indexOf("/");
      return { backend: s.slice(0, i), model: s.slice(i + 1) };
    })
    .pipe(aliasObject),
]);

export const limitsSchema = z
  .object({
    requestsPerMinute: positiveInt.optional(),
    tokensPerMinute: positiveInt.optional(),
  })
  .strict();

export const keySchema = z
  .object({
    /** Shown in logs and metrics instead of the key itself. */
    name: identifier,
    key: z.string().min(1),
    /** Aliases this key may use. Omit to allow every alias. */
    models: z.array(z.string().min(1)).min(1).optional(),
    limits: limitsSchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).default("0.0.0.0"),
        port: int().pipe(z.number().min(0).max(65_535)).default(8080),
        /** Largest accepted request body. */
        bodyLimitBytes: positiveInt.default(4 * 1024 * 1024),
      })
      .strict()
      .prefault({}),
    logging: z
      .object({
        level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
        /** Log prompt and completion bodies. Off by default: prompts often contain private data. */
        logBodies: bool.default(false),
      })
      .strict()
      .prefault({}),
    healthCheck: z
      .object({
        intervalMs: positiveInt.default(30_000),
        timeoutMs: positiveInt.default(5_000),
      })
      .strict()
      .prefault({}),
    // A missing section gets the same clear message as an empty one.
    backends: z.preprocess(
      (v) => v ?? {},
      z.record(identifier, backendSchema).refine((b) => Object.keys(b).length > 0, {
        message: "define at least one backend",
      }),
    ),
    aliases: z.record(identifier, aliasSchema).default({}),
    /** Defaults applied to keys that set no limits of their own. */
    limits: limitsSchema.prefault({}),
    // No key, no access: the gateway never runs open.
    keys: z.preprocess(
      (v) => v ?? [],
      z.array(keySchema).min(1, { message: "define at least one API key; the gateway does not run without authentication" }),
    ),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const [alias, a] of Object.entries(cfg.aliases)) {
      if (!(a.backend in cfg.backends)) {
        ctx.addIssue({
          code: "custom",
          path: ["aliases", alias, "backend"],
          message: `unknown backend "${a.backend}" (defined: ${Object.keys(cfg.backends).join(", ")})`,
        });
      }
    }
    const names = new Set<string>();
    const secrets = new Set<string>();
    cfg.keys.forEach((k, i) => {
      if (names.has(k.name)) ctx.addIssue({ code: "custom", path: ["keys", i, "name"], message: `duplicate key name "${k.name}"` });
      names.add(k.name);
      if (secrets.has(k.key)) ctx.addIssue({ code: "custom", path: ["keys", i, "key"], message: "the same key value is used twice" });
      secrets.add(k.key);
      k.models?.forEach((m, j) => {
        if (!(m in cfg.aliases)) {
          ctx.addIssue({ code: "custom", path: ["keys", i, "models", j], message: `unknown alias "${m}"` });
        }
      });
    });
  });

export type Config = z.infer<typeof configSchema>;
export type BackendConfig = z.infer<typeof backendSchema>;
export type AliasConfig = z.infer<typeof aliasSchema>;
export type KeyConfig = z.infer<typeof keySchema>;
export type Limits = z.infer<typeof limitsSchema>;
