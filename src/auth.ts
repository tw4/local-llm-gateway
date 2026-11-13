import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { KeyConfig } from "./config/schema.js";
import { errors } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The API key that authenticated this request (set for every /v1/* request). */
    apiKey: KeyConfig | null;
  }
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * Returns a function that finds the key matching a presented secret.
 * Every configured key is compared, each with timingSafeEqual on SHA-256 digests, so the
 * time taken depends neither on how much of a key matched, nor on its length, nor on
 * which key (if any) matched.
 */
export function createKeyMatcher(keys: readonly KeyConfig[]): (presented: string) => KeyConfig | null {
  const entries = keys.map((k) => ({ key: k, hash: digest(k.key) }));
  return (presented) => {
    const hash = digest(presented);
    let found: KeyConfig | null = null;
    for (const e of entries) {
      if (timingSafeEqual(e.hash, hash) && found === null) found = e.key;
    }
    return found;
  };
}

/** Extracts the token from `Authorization: Bearer <token>` (scheme is case-insensitive). */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Requires a valid API key on every /v1/* request, including unknown /v1 paths. */
export function registerAuth(app: FastifyInstance, keys: readonly KeyConfig[]): void {
  const match = createKeyMatcher(keys);
  app.decorateRequest("apiKey", null);
  app.addHook("onRequest", (request, _reply, done) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (path !== "/v1" && !path.startsWith("/v1/")) {
      done();
      return;
    }
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      done(errors.missingApiKey());
      return;
    }
    const key = match(token);
    if (!key) {
      done(errors.invalidApiKey());
      return;
    }
    request.apiKey = key;
    request.log = request.log.child({ key: key.name });
    done();
  });
}
