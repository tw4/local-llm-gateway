// A minimal Ollama-compatible backend that answers instantly, so the benchmark measures the
// gateway and not a model. Usage: tsx scripts/bench/backend.ts <port>

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const WORDS = Array.from({ length: 20 }, (_, i) => `word${i} `);

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { model?: string; stream?: boolean; input?: string[] };
    const model = body.model ?? "bench";
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"version":"bench"}');
    } else if (req.url === "/api/embed") {
      const input = body.input ?? [];
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ model, embeddings: input.map(() => Array.from({ length: 384 }, (_, i) => i / 384)), prompt_eval_count: input.length }),
      );
    } else if (req.url === "/api/chat" && body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ model, message: { role: "assistant", content: WORDS.join("") }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 20 }),
      );
    } else if (req.url === "/api/chat") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const w of WORDS) res.write(`${JSON.stringify({ model, message: { role: "assistant", content: w }, done: false })}\n`);
      res.end(`${JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 20 })}\n`);
    } else {
      res.writeHead(404).end();
    }
  });
});

server.keepAliveTimeout = 60_000;
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  // The runner reads the port from the first line.
  console.log(typeof address === "object" && address ? address.port : port);
});
