import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface OllamaStubOptions {
  /** Models that exist; others get Ollama's 404. */
  models?: string[];
  /** Text the model answers with (streamed word by word). */
  reply?: string;
  /** Pause between streamed chunks. */
  chunkDelayMs?: number;
  /** Ollama tool calls to return instead of text. */
  toolCalls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  /** Thinking text, for reasoning models. */
  thinking?: string;
  /** Stop the stream after this many chunks without `done` (backend crash). */
  dieAfterChunks?: number;
  /** Models that can embed; other existing models answer /api/embed with 501. Defaults to all. */
  embeddingModels?: string[];
  /** Override any route. Return true if handled. */
  handle?: (req: IncomingMessage, body: Record<string, unknown> | null, res: ServerResponse) => boolean | Promise<boolean>;
}

/** A tiny fake of Ollama's native API, enough to test the gateway's mapping. */
export class OllamaStub {
  readonly requests: RecordedRequest[] = [];
  /** Requests whose connection was closed by the gateway before the stub finished. */
  cancelled = 0;
  url = "";
  private server: Server;

  constructor(public options: OllamaStubOptions = {}) {
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Requests other than the gateway's health checks. */
  get modelRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path !== "/api/version");
  }

  last(path: string): RecordedRequest | undefined {
    return this.requests.filter((r) => r.path === path).at(-1);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const path = (req.url ?? "").split("?")[0] ?? "";
    this.requests.push({ method: req.method ?? "", path, body });

    if (this.options.handle && (await this.options.handle(req, body, res))) return;

    const models = this.options.models ?? ["llama3:8b"];
    const model = typeof body?.model === "string" ? body.model : "";
    const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));

    if (path === "/api/version") {
      json(200, { version: "0.0.0-stub" });
      return;
    }
    if (path === "/api/tags") {
      json(200, { models: models.map((name) => ({ name, model: name, modified_at: "2026-01-02T03:04:05Z" })) });
      return;
    }
    if (["/api/chat", "/api/generate", "/api/embed"].includes(path) && !models.includes(model)) {
      json(404, { error: `model '${model}' not found` });
      return;
    }
    if (path === "/api/chat") return this.generate(body ?? {}, res, "chat");
    if (path === "/api/generate") return this.generate(body ?? {}, res, "generate");
    if (path === "/api/embed") {
      if (this.options.embeddingModels && !this.options.embeddingModels.includes(model)) {
        json(501, { error: "This server does not support embeddings. Start it with `--embeddings`" });
        return;
      }
      const input = typeof body?.input === "string" ? [body.input] : ((body?.input ?? []) as string[]);
      // Deterministic vectors: [length, first char code, 0.5, -0.25].
      json(200, {
        model,
        embeddings: input.map((s) => [s.length, s.charCodeAt(0) || 0, 0.5, -0.25]),
        prompt_eval_count: input.join(" ").split(/\s+/).length,
      });
      return;
    }
    res.writeHead(404).end("404 page not found");
  }

  private async generate(body: Record<string, unknown>, res: ServerResponse, kind: "chat" | "generate"): Promise<void> {
    const model = String(body.model);
    // /api/chat puts text in `message`, /api/generate in `response`.
    const piece = (content: string, extra: Record<string, unknown> = {}) =>
      kind === "chat" ? { message: { role: "assistant", content, ...extra } } : { response: content, ...extra };
    const reply = this.options.reply ?? "Hello from the stub";
    const options = (body.options ?? {}) as { num_predict?: number };
    const words = reply.split(/(?<= )/);
    const limited = options.num_predict !== undefined ? words.slice(0, options.num_predict) : words;
    const doneReason = limited.length < words.length ? "length" : "stop";
    const usage = { prompt_eval_count: 12, eval_count: limited.length };

    if (body.stream === false) {
      const extra: Record<string, unknown> = {};
      if (this.options.toolCalls && kind === "chat") extra.tool_calls = this.options.toolCalls;
      if (this.options.thinking) extra.thinking = this.options.thinking;
      const text = this.options.toolCalls && kind === "chat" ? "" : limited.join("");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ model, created_at: new Date().toISOString(), ...piece(text, extra), done: true, done_reason: doneReason, ...usage }),
      );
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    // Set from the close event, so an object keeps the linter from treating it as constant.
    const state = { closed: false };
    res.on("close", () => {
      if (!res.writableFinished) {
        state.closed = true;
        this.cancelled++;
      }
    });
    const send = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
    const pause = () => new Promise((r) => setTimeout(r, this.options.chunkDelayMs ?? 0));

    if (this.options.thinking) send({ model, ...piece("", { thinking: this.options.thinking }), done: false });
    if (this.options.toolCalls && kind === "chat") {
      send({ model, ...piece("", { tool_calls: this.options.toolCalls }), done: false });
    } else {
      for (const [i, w] of limited.entries()) {
        if (state.closed) return;
        if (this.options.dieAfterChunks !== undefined && i >= this.options.dieAfterChunks) {
          res.destroy();
          return;
        }
        send({ model, ...piece(w), done: false });
        await pause();
      }
    }
    if (state.closed) return;
    send({ model, ...piece(""), done: true, done_reason: doneReason, ...usage });
    res.end();
  }
}
