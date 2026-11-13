import { admitRequest } from "../ratelimit.js";
import { resolveForKey } from "../models.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseChatRequest } from "../openai/validate.js";
import type { ChatCompletion, ChatCompletionChunk, ChatDelta, Usage } from "../openai/types.js";
import { StreamUsage } from "../usage.js";
import { abortOnDisconnect, ClientDisconnected, hideModelName, type RouteContext, usageRecorder } from "./context.js";
import { sendEventStream, SSE_DONE, sseData } from "./sse.js";

const now = () => Math.floor(Date.now() / 1000);

export function registerChatRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    // Every model request counts against the key's limits, even one that turns out invalid.
    request.gw.endpoint = "chat";
    admitRequest(ctx.limiter, request.apiKey, reply);
    const req = parseChatRequest(request.body);
    const target = resolveForKey(ctx.resolveModel, request.apiKey, req.model);
    request.gw.model = target.requested;
    request.gw.backend = target.backend.name;
    const upstream = { ...req, model: target.model };
    const controller = abortOnDisconnect(reply);
    const options = { signal: controller.signal };
    const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
    const created = now();
    const record = usageRecorder(ctx, request, target, "chat");

    if (!req.stream) {
      let result;
      try {
        result = await target.backend.chat(upstream, options);
      } catch (err) {
        throw hideModelName(err, target);
      }
      record(result.usage.prompt_tokens, result.usage.completion_tokens, false);
      const response: ChatCompletion = {
        id,
        object: "chat.completion",
        created,
        model: target.requested,
        system_fingerprint: null,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.content,
              refusal: null,
              ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            },
            logprobs: null,
            finish_reason: result.finishReason,
          },
        ],
        usage: result.usage,
      };
      return response;
    }

    // Wait for the backend to accept the request, so an unknown model or a backend that is
    // down is still a normal HTTP error rather than an error inside a 200 stream.
    let deltas: AsyncIterable<ChatDelta>;
    try {
      deltas = await target.backend.chatStream(upstream, options);
    } catch (err) {
      throw hideModelName(err, target);
    }

    const chunk = (delta: ChatCompletionChunk["choices"][number]["delta"], finish: ChatCompletionChunk["choices"][number]["finish_reason"] = null): ChatCompletionChunk => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: target.requested,
      system_fingerprint: null,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      ...(req.include_usage ? { usage: null } : {}),
    });

    async function* events(): AsyncGenerator<string> {
      yield sseData(chunk({ role: "assistant", content: "" }));
      let usage: Usage | undefined;
      let toolIndex = 0;
      // Exact counts when the backend reports them, an estimate if the stream is cut short.
      const counter = new StreamUsage(record);
      try {
        for await (const d of deltas) {
          if (d.content !== undefined || d.reasoning !== undefined || d.toolCalls) {
            counter.chunk();
            request.gw.firstChunkAt ??= Date.now();
          }
          if (d.usage) counter.final(d.usage.prompt_tokens, d.usage.completion_tokens);
          if (d.content !== undefined || d.reasoning !== undefined) {
            yield sseData(
              chunk({
                ...(d.content !== undefined ? { content: d.content } : {}),
                ...(d.reasoning !== undefined ? { reasoning_content: d.reasoning } : {}),
              }),
            );
          }
          if (d.toolCalls) {
            yield sseData(chunk({ tool_calls: d.toolCalls.map((tc) => ({ index: toolIndex++, ...tc })) }));
          }
          if (d.finishReason) {
            usage = d.usage;
            yield sseData(chunk({}, d.finishReason));
          }
        }
      } catch (err) {
        throw hideModelName(err, target);
      } finally {
        // Runs on completion, on errors and when the client disconnects.
        counter.finish();
      }
      if (req.include_usage) {
        yield sseData({ ...chunk({}), choices: [], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      }
      yield SSE_DONE;
    }

    return sendEventStream(reply, events(), (err) => {
      if (err instanceof ClientDisconnected || controller.signal.aborted) return;
      request.log.warn({ err }, "stream failed after the response started");
    });
  });
}
