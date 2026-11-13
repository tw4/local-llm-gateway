import type { FastifyReply } from "fastify";
import type { KeyConfig, Limits } from "./config/schema.js";
import { errors } from "./errors.js";

/**
 * A token bucket that refills continuously: `capacity` per minute, at most `capacity` stored.
 * The level may go below zero (tokens are only known after a response), which blocks new
 * requests until it has refilled.
 */
export class Bucket {
  private level: number;
  private updated: number;

  constructor(
    readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.level = capacity;
    this.updated = now();
  }

  private refill(): void {
    const t = this.now();
    this.level = Math.min(this.capacity, this.level + ((t - this.updated) / 60_000) * this.capacity);
    this.updated = t;
  }

  /** Current level (may be negative). */
  get available(): number {
    this.refill();
    return this.level;
  }

  /** Takes `amount` if at least that much is available. */
  tryTake(amount: number): boolean {
    this.refill();
    if (this.level < amount) return false;
    this.level -= amount;
    return true;
  }

  /** Takes `amount` unconditionally (may go negative). */
  take(amount: number): void {
    this.refill();
    this.level -= amount;
  }

  /** Seconds until at least `amount` is available. */
  secondsUntil(amount: number): number {
    const missing = amount - this.available;
    return missing <= 0 ? 0 : (missing / this.capacity) * 60;
  }

  /** Seconds until the bucket is full again. */
  secondsUntilFull(): number {
    return this.secondsUntil(this.capacity);
  }
}

interface KeyBuckets {
  requests: Bucket | null;
  tokens: Bucket | null;
}

/** Per-key request and token limits (requests per minute, tokens per minute). */
export class RateLimiter {
  private readonly buckets = new Map<string, KeyBuckets>();

  constructor(
    private readonly defaults: Limits,
    private readonly now: () => number = Date.now,
  ) {}

  private for(key: KeyConfig): KeyBuckets {
    let b = this.buckets.get(key.name);
    if (!b) {
      // A key's own limits override the defaults, field by field.
      const rpm = key.limits?.requestsPerMinute ?? this.defaults.requestsPerMinute;
      const tpm = key.limits?.tokensPerMinute ?? this.defaults.tokensPerMinute;
      b = {
        requests: rpm === undefined ? null : new Bucket(rpm, this.now),
        tokens: tpm === undefined ? null : new Bucket(tpm, this.now),
      };
      this.buckets.set(key.name, b);
    }
    return b;
  }

  /**
   * Admits one request or throws a 429 with Retry-After. The token limit only admits a
   * request while the key is not in debt from earlier responses.
   */
  admit(key: KeyConfig): void {
    const b = this.for(key);
    if (b.tokens && b.tokens.available < 1) {
      throw errors.rateLimited(
        `Rate limit reached for tokens: ${b.tokens.capacity} per minute for key '${key.name}'. Try again in ${Math.ceil(b.tokens.secondsUntil(1))} s.`,
        b.tokens.secondsUntil(1),
        "tokens_rate_limit_exceeded",
      );
    }
    if (b.requests && !b.requests.tryTake(1)) {
      throw errors.rateLimited(
        `Rate limit reached for requests: ${b.requests.capacity} per minute for key '${key.name}'. Try again in ${Math.ceil(b.requests.secondsUntil(1))} s.`,
        b.requests.secondsUntil(1),
        "requests_rate_limit_exceeded",
      );
    }
  }

  /** Charges the tokens a response used. */
  charge(keyName: string, tokens: number): void {
    this.buckets.get(keyName)?.tokens?.take(tokens);
  }

  /** OpenAI's x-ratelimit-* headers, so clients can pace themselves. */
  headers(key: KeyConfig): Record<string, string> {
    const b = this.for(key);
    const h: Record<string, string> = {};
    const add = (kind: "requests" | "tokens", bucket: Bucket | null) => {
      if (!bucket) return;
      h[`x-ratelimit-limit-${kind}`] = String(bucket.capacity);
      h[`x-ratelimit-remaining-${kind}`] = String(Math.max(0, Math.floor(bucket.available)));
      h[`x-ratelimit-reset-${kind}`] = `${Math.ceil(bucket.secondsUntilFull())}s`;
    };
    add("requests", b.requests);
    add("tokens", b.tokens);
    return h;
  }
}

/** Admits a request for its key and adds the rate-limit headers to the reply. */
export function admitRequest(limiter: RateLimiter, key: KeyConfig | null, reply: FastifyReply): void {
  if (!key) return;
  try {
    limiter.admit(key);
  } finally {
    reply.headers(limiter.headers(key));
  }
}
