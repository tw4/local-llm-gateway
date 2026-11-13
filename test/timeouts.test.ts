import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { mapFetchError } from "../src/backends/http.js";
import { GatewayError } from "../src/errors.js";
import { startGateway } from "./gateway.js";
import type { OllamaStubOptions } from "./stubs/ollama.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user = [{ role: "user" as const, content: "hi" }];

/** A gateway whose Ollama backend has short timeouts. */
function start(stub: OllamaStubOptions, responseMs = 300) {
  return startGateway(stub, { healthCheck: { intervalMs: 60_000, timeoutMs: 1_000 } }, { timeouts: { connectMs: 1_000, responseMs } });
}

describe("upstream timeouts", () => {
  it("answers 504 when the backend does not start responding in time", async () => {
    const gw = await start({ handle: (_req, body) => body?.model !== undefined /* never answer model calls */ });
    const t0 = Date.now();
    const err = await gw.client.chat.completions.create({ model: "llama3:8b", messages: user }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.InternalServerError);
    expect(err).toMatchObject({ status: 504, code: "upstream_timeout", type: "timeout_error" });
    expect((err as Error).message).toContain("did not start responding within 300 ms");
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("ends a stream with an error event when the backend goes silent mid-stream", async () => {
    const gw = await start({
      handle: (_req, body, res) => {
        if (body?.stream !== true) return false;
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ model: "llama3:8b", message: { role: "assistant", content: "first " }, done: false })}\n`);
        // …and then nothing, without closing the connection.
        return true;
      },
    });
    const stream = await gw.client.chat.completions.create({ model: "llama3:8b", messages: user, stream: true });
    let text = "";
    const err = await (async () => {
      for await (const c of stream) text += c.choices[0]?.delta.content ?? "";
    })().catch((e: unknown) => e);
    expect(text).toBe("first ");
    expect(String(err)).toContain("stopped sending data for 300 ms");
  });

  it("lets a slow but steady stream run longer than the timeout", async () => {
    // 6 chunks, 100 ms apart: 600 ms in total with a 300 ms silence limit.
    const gw = await start({ reply: "a b c d e f", chunkDelayMs: 100 });
    const stream = await gw.client.chat.completions.create({ model: "llama3:8b", messages: user, stream: true });
    let text = "";
    for await (const c of stream) text += c.choices[0]?.delta.content ?? "";
    expect(text).toBe("a b c d e f");
  });

  it("waits through a slow model load before a non-streamed answer", async () => {
    const gw = await start(
      {
        handle: async (_req, body, res) => {
          if (body?.stream !== false) return false;
          await sleep(400); // longer than connectMs would allow if it covered headers
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ model: "llama3:8b", message: { role: "assistant", content: "loaded" }, done: true, done_reason: "stop" }),
          );
          return true;
        },
      },
      1_000,
    );
    const res = await gw.client.chat.completions.create({ model: "llama3:8b", messages: user });
    expect(res.choices[0]?.message.content).toBe("loaded");
  });
});

describe("upstream failures are told apart", () => {
  it("down → 502 upstream_unavailable, missing model → 404, timeout → 504", async () => {
    const gw = await start({});
    const missing = await gw.client.chat.completions.create({ model: "nope", messages: user }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, code: "model_not_found" });
    await gw.stub.stop();
    const down = await gw.client.chat.completions.create({ model: "llama3:8b", messages: user }).catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 502, code: "upstream_unavailable" });
  });

  it("maps connection-level timeouts and errors", () => {
    const fake = (code: string) => Object.assign(new Error("fetch failed"), { cause: { code } });
    const map = (code: string) => {
      try {
        mapFetchError("ollama", fake(code), undefined);
      } catch (e) {
        return e as GatewayError;
      }
      throw new Error("expected an error");
    };
    expect(map("UND_ERR_CONNECT_TIMEOUT")).toMatchObject({ status: 504, code: "upstream_timeout" });
    expect(map("UND_ERR_CONNECT_TIMEOUT").message).toContain("could not be reached in time");
    expect(map("ECONNREFUSED")).toMatchObject({ status: 502, code: "upstream_unavailable" });
    expect(map("ENOTFOUND")).toMatchObject({ status: 502, code: "upstream_unavailable" });
  });

  it("passes the client's own cancellation through untouched", () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    controller.abort(reason);
    const original = new Error("aborted");
    expect(() => mapFetchError("ollama", original, controller.signal)).toThrow(original);
    const timeout = new GatewayError(504, "t", { type: "timeout_error" });
    const timed = new AbortController();
    timed.abort(timeout);
    expect(() => mapFetchError("ollama", original, timed.signal)).toThrow(timeout);
  });
});
