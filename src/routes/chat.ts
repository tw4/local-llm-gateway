import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseChatRequest } from "../openai/validate.js";
import type { ChatCompletion, ChatCompletionChunk, ChatDelta, Usage } from "../openai/types.js";
import { abortOnDisconnect, ClientDisconnected, hideModelName, type RouteContext } from "./context.js";
import { sendEventStream, SSE_DONE, sseData } from "./sse.js";

const now = () => Math.floor(Date.now() / 1000);

export function registerChatRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    const req = parseChatRequest(request.body);
    const target = ctx.resolveModel(req.model);
    const upstream = { ...req, model: target.model };
    const controller = abortOnDisconnect(reply);
    const options = { signal: controller.signal };
    const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
    const created = now();

    if (!req.stream) {
      let result;
      try {
        result = await target.backend.chat(upstream, options);
      } catch (err) {
        throw hideModelName(err, target);
      }
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
      try {
        for await (const d of deltas) {
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
      }
      if (req.include_usage && usage) {
        yield sseData({ ...chunk({}), choices: [], usage });
      }
      yield SSE_DONE;
    }

    return sendEventStream(reply, events(), (err) => {
      if (err instanceof ClientDisconnected || controller.signal.aborted) return;
      request.log.warn({ err }, "stream failed after the response started");
    });
  });
}
