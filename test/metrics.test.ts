import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { startGateway } from "./gateway.js";

/** Sum of the samples of `name` whose labels include `labels`. */
function metric(text: string, name: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    const m = /^([a-z_:]+)(?:\{(.*)\})? ([0-9.e+-]+|NaN)$/i.exec(line);
    if (m?.[1] !== name) continue;
    const have = new Map([...(m[2] ?? "").matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/gi)].map((x) => [x[1] ?? "", x[2] ?? ""]));
    if (Object.entries(labels).every(([k, v]) => have.get(k) === v)) sum += Number(m[3]);
  }
  return sum;
}

const user = [{ role: "user" as const, content: "hi" }];
const keys = [
  { name: "steady", key: "steady-key-0123456789" },
  { name: "limited", key: "limited-key-0123456789", limits: { requestsPerMinute: 50 } },
];
const aliases = { chat: "ollama/llama3:8b", embed: "ollama/llama3:8b", ghost: "ollama/not-pulled" };

async function start(config: Record<string, unknown> = {}) {
  const gw = await startGateway({ reply: "one two three" }, { keys, aliases, ...config });
  const as = (key: string) => new OpenAI({ apiKey: key, baseURL: `${gw.address}/v1`, maxRetries: 0 });
  const scrape = async (token?: string) => {
    const res = await fetch(`${gw.address}/metrics`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
  };
  return { ...gw, as, scrape, steady: as("steady-key-0123456789"), limited: as("limited-key-0123456789") };
}

describe("GET /metrics", () => {
  it("serves the Prometheus text format with the gateway's metrics", async () => {
    const { scrape } = await start();
    const { status, type, text } = await scrape();
    expect(status).toBe(200);
    expect(type).toMatch(/^text\/plain; version=0\.0\.4/);
    for (const name of [
      "llm_gateway_requests_total",
      "llm_gateway_request_duration_seconds",
      "llm_gateway_time_to_first_chunk_seconds",
      "llm_gateway_tokens_total",
      "llm_gateway_upstream_errors_total",
      "llm_gateway_rate_limited_total",
      "llm_gateway_backend_up",
      "llm_gateway_process_cpu_seconds_total",
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
    expect(metric(text, "llm_gateway_backend_up", { backend: "ollama" })).toBe(1);
  });

  it("can require a bearer token, or be turned off", async () => {
    const guarded = await start({ metrics: { token: "scrape-secret" } });
    expect((await guarded.scrape()).status).toBe(401);
    expect((await guarded.scrape("wrong")).status).toBe(401);
    expect((await guarded.scrape("scrape-secret")).status).toBe(200);

    const off = await start({ metrics: { enabled: false } });
    expect((await off.scrape()).status).toBe(404);
  });

  it("counts requests, durations, tokens and time to first chunk by key and alias", async () => {
    const { steady, scrape } = await start();
    await steady.chat.completions.create({ model: "chat", messages: user });
    const stream = await steady.chat.completions.create({ model: "chat", messages: user, stream: true });
    for await (const _ of stream) {
      // drain
    }
    await steady.embeddings.create({ model: "embed", input: "x" });
    await steady.models.list();
    const { text } = await scrape();

    const base = { key: "steady", model: "chat", endpoint: "chat" };
    expect(metric(text, "llm_gateway_requests_total", { ...base, status: "200" })).toBe(2);
    expect(metric(text, "llm_gateway_requests_total", { key: "steady", model: "embed", endpoint: "embeddings", status: "200" })).toBe(1);
    expect(metric(text, "llm_gateway_requests_total", { key: "steady", endpoint: "models", status: "200" })).toBe(1);
    expect(metric(text, "llm_gateway_request_duration_seconds_count", base)).toBe(2);
    expect(metric(text, "llm_gateway_time_to_first_chunk_seconds_count", base)).toBe(1);
    expect(metric(text, "llm_gateway_tokens_total", { key: "steady", model: "chat", type: "prompt" })).toBe(24);
    expect(metric(text, "llm_gateway_tokens_total", { key: "steady", model: "chat", type: "completion" })).toBe(6);
  });

  it("counts upstream failures by kind, and client errors without a model label", async () => {
    const { steady, scrape, stub, fetch: call } = await start();
    await steady.chat.completions.create({ model: "ghost", messages: user }).catch(() => undefined); // alias whose model is missing upstream
    await steady.chat.completions.create({ model: "random-name-1", messages: user }).catch(() => undefined); // unknown alias: client error
    await call("/v1/chat/completions", { body: { model: "chat" }, key: "steady-key-0123456789" }); // invalid request
    await call("/v1/models", { key: "wrong" }); // unauthenticated
    await stub.stop();
    await steady.chat.completions.create({ model: "chat", messages: user }).catch(() => undefined);
    const { text } = await scrape();

    expect(metric(text, "llm_gateway_upstream_errors_total", { backend: "ollama", model: "ghost", kind: "model_not_found" })).toBe(1);
    expect(metric(text, "llm_gateway_upstream_errors_total", { backend: "ollama", model: "chat", kind: "unavailable" })).toBe(1);
    expect(metric(text, "llm_gateway_upstream_errors_total")).toBe(2);
    expect(metric(text, "llm_gateway_requests_total", { key: "steady", model: "", status: "404" })).toBe(1);
    expect(metric(text, "llm_gateway_requests_total", { key: "steady", status: "400" })).toBe(1);
    expect(metric(text, "llm_gateway_requests_total", { key: "unauthenticated", status: "401" })).toBe(1);
    // Client-supplied model names never become label values.
    expect(text).not.toContain("random-name-1");
  });
});

describe("load test: limits enforced and metrics matching the traffic sent", () => {
  it("agrees with what 300 concurrent requests from two keys observed", async () => {
    const { steady, limited, scrape } = await start();
    type Outcome = { key: string; endpoint: string; status: number; prompt: number; completion: number };
    const outcomes: Outcome[] = [];

    const one = async (i: number): Promise<void> => {
      const key = i % 2 === 0 ? "steady" : "limited";
      const client = key === "steady" ? steady : limited;
      const kind = i % 3;
      try {
        if (kind === 0) {
          const r = await client.chat.completions.create({ model: "chat", messages: user });
          outcomes.push({ key, endpoint: "chat", status: 200, prompt: r.usage?.prompt_tokens ?? 0, completion: r.usage?.completion_tokens ?? 0 });
        } else if (kind === 1) {
          const s = await client.chat.completions.create({ model: "chat", messages: user, stream: true, stream_options: { include_usage: true } });
          let prompt = 0;
          let completion = 0;
          for await (const c of s) {
            prompt = c.usage?.prompt_tokens ?? prompt;
            completion = c.usage?.completion_tokens ?? completion;
          }
          outcomes.push({ key, endpoint: "chat", status: 200, prompt, completion });
        } else {
          const r = await client.embeddings.create({ model: "embed", input: "load test" });
          outcomes.push({ key, endpoint: "embeddings", status: 200, prompt: r.usage.prompt_tokens, completion: 0 });
        }
      } catch (e) {
        outcomes.push({ key, endpoint: kind === 2 ? "embeddings" : "chat", status: (e as InstanceType<typeof OpenAI.APIError>).status ?? 0, prompt: 0, completion: 0 });
      }
    };

    // 300 requests, 25 at a time.
    let next = 0;
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        while (next < 300) await one(next++);
      }),
    );
    const { text } = await scrape();
    const count = (f: (o: Outcome) => boolean) => outcomes.filter(f).length;
    const sum = (key: string, field: "prompt" | "completion") => outcomes.filter((o) => o.key === key).reduce((n, o) => n + o[field], 0);

    expect(outcomes).toHaveLength(300);
    expect(count((o) => ![200, 429].includes(o.status))).toBe(0);

    // The unlimited key was never refused; the limited key got 50 (plus what refilled meanwhile).
    expect(count((o) => o.key === "steady" && o.status === 429)).toBe(0);
    const limitedOk = count((o) => o.key === "limited" && o.status === 200);
    expect(limitedOk).toBeGreaterThanOrEqual(50);
    expect(limitedOk).toBeLessThanOrEqual(55);

    // Metrics match the traffic exactly.
    for (const key of ["steady", "limited"]) {
      for (const endpoint of ["chat", "embeddings"]) {
        for (const status of [200, 429]) {
          expect(metric(text, "llm_gateway_requests_total", { key, endpoint, status: String(status) })).toBe(
            count((o) => o.key === key && o.endpoint === endpoint && o.status === status),
          );
        }
      }
      expect(metric(text, "llm_gateway_tokens_total", { key, type: "prompt" })).toBe(sum(key, "prompt"));
      expect(metric(text, "llm_gateway_tokens_total", { key, type: "completion" })).toBe(sum(key, "completion"));
    }
    expect(metric(text, "llm_gateway_rate_limited_total", { key: "limited", limit: "requests" })).toBe(count((o) => o.status === 429));
    expect(metric(text, "llm_gateway_request_duration_seconds_count")).toBe(300);
  });
});
