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
    if (path === "/api/chat" && !models.includes(model)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `model '${model}' not found` }));
      return;
    }
    if (path === "/api/chat") return this.chat(body ?? {}, res);
    res.writeHead(404).end("404 page not found");
  }

  private async chat(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const model = String(body.model);
    const reply = this.options.reply ?? "Hello from the stub";
    const options = (body.options ?? {}) as { num_predict?: number };
    const words = reply.split(/(?<= )/);
    const limited = options.num_predict !== undefined ? words.slice(0, options.num_predict) : words;
    const doneReason = limited.length < words.length ? "length" : "stop";
    const usage = { prompt_eval_count: 12, eval_count: limited.length };

    if (body.stream === false) {
      const message: Record<string, unknown> = { role: "assistant", content: this.options.toolCalls ? "" : limited.join("") };
      if (this.options.toolCalls) message.tool_calls = this.options.toolCalls;
      if (this.options.thinking) message.thinking = this.options.thinking;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ model, created_at: new Date().toISOString(), message, done: true, done_reason: doneReason, ...usage }),
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

    if (this.options.thinking) send({ model, message: { role: "assistant", content: "", thinking: this.options.thinking }, done: false });
    if (this.options.toolCalls) {
      send({ model, message: { role: "assistant", content: "", tool_calls: this.options.toolCalls }, done: false });
    } else {
      for (const [i, w] of limited.entries()) {
        if (state.closed) return;
        if (this.options.dieAfterChunks !== undefined && i >= this.options.dieAfterChunks) {
          res.destroy();
          return;
        }
        send({ model, message: { role: "assistant", content: w }, done: false });
        await pause();
      }
    }
    if (state.closed) return;
    send({ model, message: { role: "assistant", content: "" }, done: true, done_reason: doneReason, ...usage });
    res.end();
  }
}
