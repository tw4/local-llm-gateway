import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChatDelta, FinishReason, Usage } from "../openai/types.js";
import { parseCompletionRequest } from "../openai/validate.js";
import { abortOnDisconnect, ClientDisconnected, hideModelName, type RouteContext } from "./context.js";
import { sendEventStream, SSE_DONE, sseData } from "./sse.js";

interface CompletionChoice {
  text: string;
  index: number;
  logprobs: null;
  finish_reason: FinishReason | null;
}

export function registerCompletionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/completions", async (request, reply) => {
    const req = parseCompletionRequest(request.body);
    const target = ctx.resolveModel(req.model);
    const upstream = { ...req, model: target.model };
    const controller = abortOnDisconnect(reply);
    const options = { signal: controller.signal };
    const id = `cmpl-${randomUUID().replace(/-/g, "")}`;
    const created = Math.floor(Date.now() / 1000);
    const envelope = (choices: CompletionChoice[]) => ({
      id,
      object: "text_completion" as const,
      created,
      model: target.requested,
      system_fingerprint: null,
      choices,
    });

    if (!req.stream) {
      const result = await target.backend.complete(upstream, options).catch((err: unknown) => {
        throw hideModelName(err, target);
      });
      return {
        ...envelope([{ text: result.content ?? "", index: 0, logprobs: null, finish_reason: result.finishReason }]),
        usage: result.usage,
      };
    }

    let deltas: AsyncIterable<ChatDelta>;
    try {
      deltas = await target.backend.completeStream(upstream, options);
    } catch (err) {
      throw hideModelName(err, target);
    }

    async function* events(): AsyncGenerator<string> {
      let usage: Usage | undefined;
      try {
        for await (const d of deltas) {
          if (d.content !== undefined || d.finishReason) {
            yield sseData(envelope([{ text: d.content ?? "", index: 0, logprobs: null, finish_reason: d.finishReason ?? null }]));
          }
          if (d.usage) usage = d.usage;
        }
      } catch (err) {
        throw hideModelName(err, target);
      }
      if (req.include_usage && usage) yield sseData({ ...envelope([]), usage });
      yield SSE_DONE;
    }

    return sendEventStream(reply, events(), (err) => {
      if (err instanceof ClientDisconnected || controller.signal.aborted) return;
      request.log.warn({ err }, "stream failed after the response started");
    });
  });
}
