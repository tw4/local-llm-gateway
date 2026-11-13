// SDK smoke test: starts the gateway and runs the official OpenAI SDKs (Node and Python)
// against it for chat, streaming, embeddings, models and error classes.
//
//   npm run smoke                                   # against an Ollama stub (no model needed)
//   npm run smoke -- --ollama http://localhost:11434 --chat-model qwen3:0.6b --embed-model all-minilm
//   npm run smoke -- --skip-python
//
// Python: set PYTHON, or create .venv-smoke (see scripts/smoke/requirements.txt).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { buildApp } from "../../src/app.js";
import { configSchema } from "../../src/config/schema.js";
import { OllamaStub } from "../../test/stubs/ollama.js";

const { values: args } = parseArgs({
  options: {
    ollama: { type: "string" },
    "chat-model": { type: "string" },
    "embed-model": { type: "string" },
    "skip-python": { type: "boolean", default: false },
  },
});

const KEY = "smoke-test-key-0123456789";
const CHAT = "smoke-chat";
const EMBED = "smoke-embed";
const RESTRICTED_KEY = "smoke-restricted-key-0123456789";
const LIMITED_KEY = "smoke-limited-key-0123456789";

let stub: OllamaStub | undefined;
let ollamaUrl = args.ollama;
if (!ollamaUrl) {
  stub = await new OllamaStub({ models: ["stub-chat", "stub-embed"], reply: "Hello from the smoke test" }).start();
  ollamaUrl = stub.url;
} else if (!args["chat-model"] || !args["embed-model"]) {
  console.error("--ollama needs --chat-model and --embed-model");
  process.exit(2);
}

// Aliases as in a real deployment: the SDKs only ever see smoke-chat / smoke-embed.
const config = configSchema.parse({
  backends: { ollama: { type: "ollama", url: ollamaUrl } },
  aliases: {
    [CHAT]: { backend: "ollama", model: args["chat-model"] ?? "stub-chat" },
    [EMBED]: { backend: "ollama", model: args["embed-model"] ?? "stub-embed" },
  },
  keys: [
    { name: "smoke", key: KEY },
    // For the Python error-class checks: a key limited to one alias, and one to 1 request per minute.
    { name: "restricted", key: RESTRICTED_KEY, models: [CHAT] },
    { name: "limited", key: LIMITED_KEY, limits: { requestsPerMinute: 1 } },
  ],
  logging: { level: "warn" },
});
const app = buildApp(config);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(`gateway ${address} → ${stub ? "Ollama stub" : ollamaUrl}`);

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    node    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  node    ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const client = new OpenAI({ apiKey: KEY, baseURL: `${address}/v1`, maxRetries: 0 });
const sdkVersion = (JSON.parse(readFileSync(join("node_modules", "openai", "package.json"), "utf8")) as { version: string }).version;
console.log(`openai-node ${sdkVersion}`);

await check("chat", async () => {
  const r = await client.chat.completions.create({ model: CHAT, messages: [{ role: "user", content: "Say hello" }], max_completion_tokens: 64 });
  assert(r.model === CHAT, `model ${r.model}`);
  assert(["stop", "length"].includes(r.choices[0]?.finish_reason ?? ""), `finish_reason ${String(r.choices[0]?.finish_reason)}`);
  assert((r.usage?.total_tokens ?? 0) > 0, "no usage");
});

await check("chat streaming", async () => {
  const stream = await client.chat.completions.create({
    model: CHAT,
    messages: [{ role: "user", content: "Say hello" }],
    max_completion_tokens: 64,
    stream: true,
    stream_options: { include_usage: true },
  });
  let chunks = 0;
  let finish: string | null = null;
  let total = 0;
  for await (const c of stream) {
    chunks++;
    finish = c.choices[0]?.finish_reason ?? finish;
    total = c.usage?.total_tokens ?? total;
  }
  assert(chunks >= 2, `only ${chunks} chunks`);
  assert(finish === "stop" || finish === "length", `finish_reason ${String(finish)}`);
  assert(total > 0, "no usage chunk");
});

await check("embeddings (SDK default base64)", async () => {
  const r = await client.embeddings.create({ model: EMBED, input: ["hello", "world"] });
  assert(r.data.length === 2 && r.data[1]?.index === 1, "wrong number or order of embeddings");
  assert((r.data[0]?.embedding.length ?? 0) > 0 && r.data[0]?.embedding.every(Number.isFinite), "empty or invalid vector");
});

await check("models", async () => {
  const ids = (await client.models.list()).data.map((m) => m.id);
  assert(ids.includes(CHAT) && ids.includes(EMBED), `models: ${ids.join(", ")}`);
});

await check("wrong key -> AuthenticationError", async () => {
  const bad = new OpenAI({ apiKey: "wrong", baseURL: `${address}/v1`, maxRetries: 0 });
  const err = await bad.models.list().then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof OpenAI.AuthenticationError, `got ${String(err)}`);
});

await check("unknown model -> NotFoundError", async () => {
  const err = await client.chat.completions.create({ model: "no-such-model", messages: [{ role: "user", content: "x" }] }).then(
    () => null,
    (e: unknown) => e,
  );
  assert(err instanceof OpenAI.NotFoundError && err.code === "model_not_found", `got ${String(err)}`);
});

if (!args["skip-python"]) {
  const venv = [join(".venv-smoke", "Scripts", "python.exe"), join(".venv-smoke", "bin", "python")].find((p) => existsSync(p));
  const python = process.env.PYTHON ?? venv ?? (process.platform === "win32" ? "python" : "python3");
  const probe = spawnSync(python, ["-c", "import openai"], { encoding: "utf8" });
  if (probe.status !== 0) {
    failures++;
    console.log(`  FAIL  python  the openai package is not available for ${python}. Install it with:`);
    console.log("        python3 -m venv .venv-smoke && .venv-smoke/bin/pip install -r scripts/smoke/requirements.txt");
    console.log("        (or run with --skip-python)");
  } else {
    // Run in a child process, so this process keeps serving the gateway meanwhile.
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(python, [join("scripts", "smoke", "smoke.py")], {
        stdio: "inherit",
        env: {
          ...process.env,
          GATEWAY_URL: address,
          GATEWAY_KEY: KEY,
          RESTRICTED_KEY,
          LIMITED_KEY,
          CHAT_MODEL: CHAT,
          EMBED_MODEL: EMBED,
        },
      });
      child.on("close", resolve);
    });
    if (code !== 0) failures++;
  }
}

await app.close();
await stub?.stop();
console.log(failures === 0 ? "smoke test passed" : `smoke test failed (${failures})`);
process.exit(failures === 0 ? 0 : 1);
