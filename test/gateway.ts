import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { TEST_KEY, testConfig } from "./helpers.js";
import { OllamaStub, type OllamaStubOptions } from "./stubs/ollama.js";

export interface TestGateway {
  app: FastifyInstance;
  address: string;
  client: OpenAI;
  stub: OllamaStub;
  /** POST/GET with the test key, for checks below the SDK. */
  fetch: (path: string, init?: { method?: string; body?: unknown; key?: string }) => Promise<Response>;
}

const running: { app: FastifyInstance; stub: OllamaStub }[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.app.close();
    await r.stub.stop();
  }
});

/** Starts an Ollama stub and a gateway in front of it; both are stopped after the test. */
export async function startGateway(stubOptions: OllamaStubOptions = {}, config: Record<string, unknown> = {}): Promise<TestGateway> {
  const stub = await new OllamaStub(stubOptions).start();
  const app = buildApp(testConfig({ backends: { ollama: { type: "ollama", url: stub.url } }, ...config }), { fastify: { logger: false } });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  running.push({ app, stub });
  const client = new OpenAI({ apiKey: TEST_KEY, baseURL: `${address}/v1`, maxRetries: 0 });
  return {
    app,
    address,
    client,
    stub,
    fetch: (path, init = {}) =>
      fetch(`${address}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${init.key ?? TEST_KEY}`, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
  };
}
