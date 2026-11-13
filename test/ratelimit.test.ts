import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { Bucket, RateLimiter } from "../src/ratelimit.js";
import { startGateway } from "./gateway.js";

const user = [{ role: "user" as const, content: "hi" }];

describe("Bucket", () => {
  it("refills continuously up to its capacity", () => {
    let t = 0;
    const b = new Bucket(60, () => t); // 1 per second
    expect(b.tryTake(60)).toBe(true);
    expect(b.tryTake(1)).toBe(false);
    t = 500;
    expect(b.tryTake(1)).toBe(false);
    t = 1_000;
    expect(b.tryTake(1)).toBe(true);
    t = 1_000_000;
    expect(b.available).toBe(60); // never above capacity
  });

  it("can go into debt and says when it is usable again", () => {
    let t = 0;
    const b = new Bucket(120, () => t); // 2 per second
    b.take(130);
    expect(b.available).toBe(-10);
    expect(b.secondsUntil(1)).toBeCloseTo(5.5);
    t = 5_500;
    expect(b.available).toBeCloseTo(1);
  });
});

describe("RateLimiter", () => {
  const key = (name: string, limits?: object) => ({ name, key: `${name}-secret`, ...(limits ? { limits } : {}) });

  it("uses a key's own limits over the defaults, field by field", () => {
    const limiter = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000 }, () => 0);
    expect(limiter.headers(key("a", { requestsPerMinute: 5 }))).toMatchObject({
      "x-ratelimit-limit-requests": "5",
      "x-ratelimit-limit-tokens": "1000",
    });
  });

  it("does nothing without limits", () => {
    const limiter = new RateLimiter({}, () => 0);
    for (let i = 0; i < 1000; i++) limiter.admit(key("free"));
    expect(limiter.headers(key("free"))).toEqual({});
  });
});

describe("per-key limits through the gateway", () => {
  const keys = [
    { name: "limited", key: "limited-key-0123456789", limits: { requestsPerMinute: 2 } },
    { name: "tokens", key: "tokens-key-0123456789", limits: { tokensPerMinute: 20 } },
    { name: "free", key: "free-key-0123456789" },
  ];
  const start = () => startGateway({ reply: "one two three" }, { keys });
  const as = (address: string, key: string) => new OpenAI({ apiKey: key, baseURL: `${address}/v1`, maxRetries: 0 });

  it("answers 429 with Retry-After once a key's requests per minute are used up", async () => {
    const { address } = await start();
    const client = as(address, "limited-key-0123456789");
    await client.chat.completions.create({ model: "llama3:8b", messages: user });
    await client.embeddings.create({ model: "llama3:8b", input: "x" });

    const { error, response } = await client.chat.completions
      .create({ model: "llama3:8b", messages: user })
      .withResponse()
      .then(
        () => ({ error: null, response: null }),
        (e: unknown) => ({ error: e as InstanceType<typeof OpenAI.APIError>, response: (e as InstanceType<typeof OpenAI.APIError>).headers }),
      );
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    expect(error?.code).toBe("requests_rate_limit_exceeded");
    expect(error?.message).toContain("2 per minute");
    expect(Number(response?.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(response?.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(response?.get("x-ratelimit-remaining-requests")).toBe("0");
  });

  it("limits each key separately", async () => {
    const { address } = await start();
    const limited = as(address, "limited-key-0123456789");
    for (let i = 0; i < 2; i++) await limited.chat.completions.create({ model: "llama3:8b", messages: user });
    await expect(limited.chat.completions.create({ model: "llama3:8b", messages: user })).rejects.toBeInstanceOf(OpenAI.RateLimitError);
    const free = as(address, "free-key-0123456789");
    for (let i = 0; i < 5; i++) await free.chat.completions.create({ model: "llama3:8b", messages: user });
  });

  it("charges the tokens a response used and blocks the key while it is in debt", async () => {
    const { address } = await start();
    const client = as(address, "tokens-key-0123456789");
    // Each request uses 12 prompt + 3 completion = 15 tokens; the limit is 20 per minute.
    await client.chat.completions.create({ model: "llama3:8b", messages: user }); // 20 → 5
    await client.chat.completions.create({ model: "llama3:8b", messages: user }); // admitted at 5, → -10
    const err = await client.chat.completions.create({ model: "llama3:8b", messages: user }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect((err as InstanceType<typeof OpenAI.RateLimitError>).code).toBe("tokens_rate_limit_exceeded");
    // 11 tokens missing at 20 per minute: about 33 seconds.
    const retryAfter = Number((err as InstanceType<typeof OpenAI.RateLimitError>).headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(32);
    expect(retryAfter).toBeLessThanOrEqual(34);
  });

  it("charges streamed responses too", async () => {
    const { address } = await start();
    const client = as(address, "tokens-key-0123456789");
    for (let i = 0; i < 2; i++) {
      const stream = await client.chat.completions.create({ model: "llama3:8b", messages: user, stream: true });
      for await (const _ of stream) {
        // drain
      }
    }
    await expect(client.chat.completions.create({ model: "llama3:8b", messages: user })).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  });

  it("sends x-ratelimit headers on successful responses", async () => {
    const { address } = await start();
    const { response } = await as(address, "limited-key-0123456789").chat.completions.create({ model: "llama3:8b", messages: user }).withResponse();
    expect(response.headers.get("x-ratelimit-limit-requests")).toBe("2");
    expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("1");
    expect(response.headers.get("x-ratelimit-reset-requests")).toMatch(/^\d+s$/);
  });

  it("does not limit /v1/models", async () => {
    const { address } = await start();
    const client = as(address, "limited-key-0123456789");
    for (let i = 0; i < 5; i++) await client.models.list();
  });
});
