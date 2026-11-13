import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { StreamUsage, UsageTracker, type UsageEvent } from "../src/usage.js";
import { startGateway } from "./gateway.js";
import { OpenAIStub } from "./stubs/openai.js";

const keys = [
  { name: "alice", key: "alice-key-0123456789" },
  { name: "bob", key: "bob-key-0123456789" },
];
const aliases = { chat: "ollama/llama3:8b", embed: "ollama/llama3:8b" };
const user = [{ role: "user" as const, content: "hi" }];

async function start(stub = {}) {
  const gw = await startGateway({ reply: "one two three", ...stub }, { keys, aliases });
  const events: UsageEvent[] = [];
  gw.app.usage.onRecord((e) => events.push(e));
  const as = (key: string) => new OpenAI({ apiKey: key, baseURL: `${gw.address}/v1`, maxRetries: 0 });
  return { ...gw, events, alice: as("alice-key-0123456789"), bob: as("bob-key-0123456789") };
}

describe("token usage accounting", () => {
  it("records prompt and completion tokens per key and alias", async () => {
    const { app, alice, bob } = await start();
    await alice.chat.completions.create({ model: "chat", messages: user });
    await alice.chat.completions.create({ model: "chat", messages: user });
    await bob.completions.create({ model: "chat", prompt: "x" });
    await bob.embeddings.create({ model: "embed", input: ["a b", "c"] });

    expect(app.usage.snapshot()).toEqual([
      { key: "alice", model: "chat", requests: 2, promptTokens: 24, completionTokens: 6 },
      { key: "bob", model: "chat", requests: 1, promptTokens: 12, completionTokens: 3 },
      { key: "bob", model: "embed", requests: 1, promptTokens: 3, completionTokens: 0 },
    ]);
  });

  it("counts streamed responses with the backend's final numbers", async () => {
    const { alice, events } = await start();
    const stream = await alice.chat.completions.create({ model: "chat", messages: user, stream: true });
    for await (const _ of stream) {
      // drain
    }
    const s2 = await alice.completions.create({ model: "chat", prompt: "x", stream: true });
    for await (const _ of s2) {
      // drain
    }
    expect(events).toEqual([
      { key: "alice", model: "chat", endpoint: "chat", promptTokens: 12, completionTokens: 3, estimated: false },
      { key: "alice", model: "chat", endpoint: "completions", promptTokens: 12, completionTokens: 3, estimated: false },
    ]);
  });

  it("estimates a stream the client cut short, so it cannot escape token limits", async () => {
    const { alice, events } = await start({ reply: "a b c d e f g h i j", chunkDelayMs: 50 });
    const stream = await alice.chat.completions.create({ model: "chat", messages: user, stream: true });
    let seen = 0;
    for await (const c of stream) {
      if (c.choices[0]?.delta.content && ++seen === 3) break;
    }
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ key: "alice", endpoint: "chat", estimated: true, promptTokens: 0 });
    expect(events[0]?.completionTokens).toBeGreaterThanOrEqual(3);
  });

  it("does not record failed requests", async () => {
    const { alice, events, stub } = await start();
    await alice.chat.completions.create({ model: "nope", messages: user }).catch(() => undefined);
    await stub.stop();
    await alice.chat.completions.create({ model: "chat", messages: user }).catch(() => undefined);
    expect(events).toEqual([]);
  });

  it("estimates when an OpenAI-compatible server leaves usage out of the stream", async () => {
    const upstream = await new OpenAIStub({ models: ["m"], reply: "x y z", noStreamUsage: true }).start();
    const gw = await startGateway({}, { aliases: { c: "compat/m" }, backends: { compat: { type: "openai", url: `${upstream.url}/v1` } } });
    const events: UsageEvent[] = [];
    gw.app.usage.onRecord((e) => events.push(e));
    const stream = await gw.client.chat.completions.create({ model: "c", messages: user, stream: true });
    for await (const _ of stream) {
      // drain
    }
    await upstream.stop();
    expect(events).toEqual([{ key: "test", model: "c", endpoint: "chat", promptTokens: 0, completionTokens: 3, estimated: true }]);
  });
});

describe("StreamUsage", () => {
  it("reports exact numbers once, or an estimate, or nothing", () => {
    const report = vi.fn();
    const exact = new StreamUsage(report);
    exact.chunk();
    exact.final(10, 5);
    exact.finish();
    exact.finish();
    expect(report.mock.calls).toEqual([[10, 5, false]]);

    report.mockClear();
    const cut = new StreamUsage(report);
    cut.chunk();
    cut.chunk();
    cut.finish();
    expect(report.mock.calls).toEqual([[0, 2, true]]);

    report.mockClear();
    new StreamUsage(report).finish();
    expect(report).not.toHaveBeenCalled();
  });
});

describe("UsageTracker", () => {
  it("keeps keys and models apart even with unusual names", () => {
    const t = new UsageTracker();
    t.record({ key: "a:b", model: "c", endpoint: "chat", promptTokens: 1, completionTokens: 1, estimated: false });
    t.record({ key: "a", model: "b:c", endpoint: "chat", promptTokens: 1, completionTokens: 1, estimated: false });
    expect(t.snapshot()).toHaveLength(2);
  });
});
