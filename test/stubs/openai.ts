import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RecordedRequest } from "./ollama.js";

export interface OpenAIStubOptions {
  models?: string[];
  reply?: string;
  /** Require this bearer key (like a server started with --api-key). */
  apiKey?: string;
  /** Return one tool call, streamed in fragments like llama.cpp and vLLM do. */
  toolCall?: { name: string; arguments: string };
  reasoning?: string;
  /** Leave usage out of streams even when asked (old servers). */
  noStreamUsage?: boolean;
}

/** A fake OpenAI-compatible server (llama.cpp server, LM Studio, vLLM). Base URL: `${url}/v1`. */
export class OpenAIStub {
  readonly requests: RecordedRequest[] = [];
  url = "";
  private server: Server;

  constructor(public options: OpenAIStubOptions = {}) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        const path = (req.url ?? "").split("?")[0] ?? "";
        this.requests.push({ method: req.method ?? "", path, body });
        this.route(path, req.headers.authorization, body, res);
      });
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

  private route(path: string, auth: string | undefined, body: Record<string, unknown> | null, res: ServerResponse): void {
    const json = (status: number, o: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (this.options.apiKey && auth !== `Bearer ${this.options.apiKey}`) {
      json(401, { error: { message: "Invalid API Key", type: "authentication_error" } });
      return;
    }
    const models = this.options.models ?? ["local-model"];
    if (path === "/v1/models") {
      json(200, { object: "list", data: models.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "llamacpp" })) });
      return;
    }
    const model = typeof body?.model === "string" ? body.model : "";
    if (!models.includes(model)) {
      json(404, { error: { message: `model '${model}' not found`, type: "not_found_error", code: 404 } });
      return;
    }
    const reply = this.options.reply ?? "Hello from llama.cpp";
    const usage = { prompt_tokens: 9, completion_tokens: reply.split(" ").length, total_tokens: 9 + reply.split(" ").length };

    if (path === "/v1/embeddings") {
      const input = (Array.isArray(body?.input) ? body.input : [body?.input]) as string[];
      // Return the items out of order: the gateway must sort by index.
      const data = input.map((s, index) => ({ object: "embedding", index, embedding: [s.length, 1, 2] })).reverse();
      json(200, { object: "list", data, model, usage: { prompt_tokens: input.length, total_tokens: input.length } });
      return;
    }

    const chat = path === "/v1/chat/completions";
    if (!chat && path !== "/v1/completions") {
      json(404, { error: { message: "not found" } });
      return;
    }

    if (body?.stream !== true) {
      const finish = this.options.toolCall ? "tool_calls" : "stop";
      const choice = chat
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: this.options.toolCall ? null : reply,
              ...(this.options.reasoning ? { reasoning_content: this.options.reasoning } : {}),
              ...(this.options.toolCall ? { tool_calls: [{ id: "call_abc", type: "function", function: this.options.toolCall }] } : {}),
            },
            finish_reason: finish,
          }
        : { index: 0, text: reply, finish_reason: "stop" };
      json(200, { id: "x", object: chat ? "chat.completion" : "text_completion", created: 1, model, choices: [choice], usage });
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (choices: unknown[], extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id: "x", object: "chunk", created: 1, model, choices, ...extra })}\n\n`);
    const piece = (content: string) => (chat ? { index: 0, delta: { content }, finish_reason: null } : { index: 0, text: content, finish_reason: null });

    if (chat) send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
    if (this.options.reasoning) send([{ index: 0, delta: { reasoning_content: this.options.reasoning }, finish_reason: null }]);
    if (this.options.toolCall && chat) {
      const args = this.options.toolCall.arguments;
      const half = Math.floor(args.length / 2);
      send([{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: this.options.toolCall.name, arguments: "" } }] }, finish_reason: null }]);
      send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, finish_reason: null }]);
      send([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
    } else {
      for (const w of reply.split(/(?<= )/)) send([piece(w)]);
      send([chat ? { index: 0, delta: {}, finish_reason: "stop" } : { index: 0, text: "", finish_reason: "stop" }]);
    }
    const options = body.stream_options as { include_usage?: boolean } | undefined;
    if (options?.include_usage && !this.options.noStreamUsage) send([], { usage });
    res.end("data: [DONE]\n\n");
  }
}
