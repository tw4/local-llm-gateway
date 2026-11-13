// Overhead benchmark: the latency the gateway adds compared with calling the backend directly.
//
//   npm run bench                                   # builds, then 10 s per measurement
//   npm run bench -- --duration 5 --out bench.md    # shorter, and write the table to a file
//
// Three processes: an instant Ollama-compatible backend (scripts/bench/backend.ts), the built
// gateway (dist/, logging at info as in production) and this load generator. Each scenario runs
// against the backend's own API and against the gateway with the same concurrency, and the
// difference of the percentiles is the added latency.

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Pool } from "undici";

const { values: args } = parseArgs({
  options: {
    duration: { type: "string", default: "10" },
    warmup: { type: "string", default: "2" },
    rounds: { type: "string", default: "5" },
    out: { type: "string" },
  },
});
const DURATION_MS = Number(args.duration) * 1000;
const WARMUP_MS = Number(args.warmup) * 1000;
// Each measurement is split into rounds that alternate direct / gateway, so that drift on
// the machine (other load, CPU frequency) affects both sides alike.
const ROUNDS = Math.max(1, Number(args.rounds));
const KEY = "bench-key-0123456789";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
    s.on("error", reject);
  });
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

const children: ChildProcess[] = [];
process.on("exit", () => {
  for (const c of children) c.kill();
});

// ---- start the backend and the gateway
const backend = spawn(process.execPath, ["--import", "tsx", join("scripts", "bench", "backend.ts"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
children.push(backend);
const backendPort = await new Promise<number>((resolve) => {
  backend.stdout.once("data", (d: Buffer) => {
    resolve(Number(d.toString().trim()));
  });
});
const backendUrl = `http://127.0.0.1:${backendPort}`;

const gatewayPort = await freePort();
const dir = mkdtempSync(join(tmpdir(), "llm-gw-bench-"));
const configPath = join(dir, "config.yaml");
writeFileSync(
  configPath,
  [
    `server: { host: 127.0.0.1, port: ${gatewayPort} }`,
    "logging: { level: info }",
    `backends: { ollama: { type: ollama, url: "${backendUrl}" } }`,
    "aliases: { bench-chat: ollama/bench, bench-embed: ollama/bench }",
    `keys: [{ name: bench, key: ${KEY} }]`,
  ].join("\n"),
);
// Logs go to /dev/null, but are still produced and written, as in production.
const gateway = spawn(process.execPath, [join("dist", "index.js")], { stdio: "ignore", env: { ...process.env, LLM_GATEWAY_CONFIG: configPath } });
children.push(gateway);
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
await waitFor(`${gatewayUrl}/livez`);

// ---- load generator
interface Target {
  origin: string;
  path: string;
  body: unknown;
  headers?: Record<string, string>;
  stream?: boolean;
}

interface Result {
  latencies: number[];
  firstChunk: number[];
  errors: number;
  seconds: number;
}

async function load(target: Target, concurrency: number, durationMs: number): Promise<Result> {
  const pool = new Pool(target.origin, { connections: concurrency, pipelining: 1 });
  const payload = JSON.stringify(target.body);
  const latencies: number[] = [];
  const firstChunk: number[] = [];
  let errors = 0;
  const start = performance.now();
  const end = start + durationMs;

  const worker = async () => {
    while (performance.now() < end) {
      const t0 = performance.now();
      try {
        const res = await pool.request({
          method: "POST",
          path: target.path,
          headers: { "content-type": "application/json", ...target.headers },
          body: payload,
        });
        let first = true;
        for await (const chunk of res.body) {
          if (first && (chunk as Buffer).length > 0) {
            if (target.stream) firstChunk.push(performance.now() - t0);
            first = false;
          }
        }
        if (res.statusCode !== 200) errors++;
        else latencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - start) / 1000;
  await pool.close();
  return { latencies, firstChunk, errors, seconds };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
}

const auth = { authorization: `Bearer ${KEY}` };
const messages = [{ role: "user", content: "Write twenty words." }];
const scenarios: { name: string; concurrency: number; direct: Target; gateway: Target }[] = [];
for (const concurrency of [1, 16, 64]) {
  scenarios.push({
    name: "chat",
    concurrency,
    direct: { origin: backendUrl, path: "/api/chat", body: { model: "bench", messages, stream: false } },
    gateway: { origin: gatewayUrl, path: "/v1/chat/completions", body: { model: "bench-chat", messages }, headers: auth },
  });
}
scenarios.push({
  name: "chat, streamed (20 chunks)",
  concurrency: 16,
  direct: { origin: backendUrl, path: "/api/chat", body: { model: "bench", messages, stream: true }, stream: true },
  gateway: { origin: gatewayUrl, path: "/v1/chat/completions", body: { model: "bench-chat", messages, stream: true }, headers: auth, stream: true },
});
scenarios.push({
  name: "embeddings (8 × 384)",
  concurrency: 16,
  direct: { origin: backendUrl, path: "/api/embed", body: { model: "bench", input: Array(8).fill("benchmark input") } },
  gateway: {
    origin: gatewayUrl,
    path: "/v1/embeddings",
    body: { model: "bench-embed", input: Array(8).fill("benchmark input"), encoding_format: "float" },
    headers: auth,
  },
});

const ms = (v: number) => (Number.isNaN(v) ? "–" : v.toFixed(2));
const rows: string[] = [];
const ttfbRows: string[] = [];

for (const s of scenarios) {
  process.stderr.write(`${s.name}, concurrency ${s.concurrency}… `);
  await load(s.direct, s.concurrency, WARMUP_MS);
  await load(s.gateway, s.concurrency, WARMUP_MS);
  const direct: Result = { latencies: [], firstChunk: [], errors: 0, seconds: 0 };
  const via: Result = { latencies: [], firstChunk: [], errors: 0, seconds: 0 };
  const add = (into: Result, r: Result) => {
    into.latencies.push(...r.latencies);
    into.firstChunk.push(...r.firstChunk);
    into.errors += r.errors;
    into.seconds += r.seconds;
  };
  for (let round = 0; round < ROUNDS; round++) {
    add(direct, await load(s.direct, s.concurrency, DURATION_MS / ROUNDS));
    add(via, await load(s.gateway, s.concurrency, DURATION_MS / ROUNDS));
  }
  const d = stats(direct.latencies);
  const g = stats(via.latencies);
  rows.push(
    `| ${s.name} | ${s.concurrency} | ${ms(d.p50)} / ${ms(d.p95)} | ${ms(g.p50)} / ${ms(g.p95)} | **${ms(g.p50 - d.p50)} / ${ms(g.p95 - d.p95)}** | ${Math.round(direct.latencies.length / direct.seconds)} / ${Math.round(via.latencies.length / via.seconds)} | ${direct.errors + via.errors} |`,
  );
  if (s.direct.stream) {
    const df = stats(direct.firstChunk);
    const gf = stats(via.firstChunk);
    ttfbRows.push(`| ${s.name} | ${s.concurrency} | ${ms(df.p50)} / ${ms(df.p95)} | ${ms(gf.p50)} / ${ms(gf.p95)} | **${ms(gf.p50 - df.p50)} / ${ms(gf.p95 - df.p95)}** |`);
  }
  process.stderr.write("done\n");
}

const cpu = cpus()[0]?.model.trim() ?? "unknown CPU";
const report = [
  `Machine: ${cpu}, ${cpus().length} logical cores, ${Math.round(totalmem() / 2 ** 30)} GB RAM, ${platform()} ${release()}, Node.js ${process.version}.`,
  `${args.duration} s per measurement in ${ROUNDS} rounds alternating direct and gateway, after ${args.warmup} s warm-up; latencies in milliseconds, p50 / p95.`,
  "",
  "| Scenario | Concurrency | Backend directly | Through the gateway | Added by the gateway | Requests/s (direct / gateway) | Errors |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows,
  "",
  "Time to first chunk for streamed responses:",
  "",
  "| Scenario | Concurrency | Backend directly | Through the gateway | Added by the gateway |",
  "|---|---:|---:|---:|---:|",
  ...ttfbRows,
  "",
].join("\n");

console.log(report);
if (args.out) writeFileSync(args.out, report);
for (const c of children) c.kill();
process.exit(0);
