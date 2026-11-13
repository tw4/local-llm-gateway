import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { GatewayError } from "../errors.js";

/** Formats one Server-Sent Event the way OpenAI does: `data: <json>\n\n`. */
export const sseData = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
export const SSE_DONE = "data: [DONE]\n\n";

/**
 * Sends an SSE response from an async generator of already formatted events.
 * An error after the first byte cannot change the status any more, so it is sent as an
 * OpenAI error event (the SDKs raise it) and the stream ends without [DONE].
 * If the client disconnects, the generator is closed, which cancels the upstream request.
 */
export function sendEventStream(reply: FastifyReply, events: AsyncGenerator<string>, onError: (err: unknown) => void): FastifyReply {
  async function* guarded(): AsyncGenerator<string> {
    try {
      yield* events;
    } catch (err) {
      onError(err);
      const e =
        err instanceof GatewayError
          ? err
          : new GatewayError(500, "The gateway had an internal error while streaming the response.", { type: "server_error", code: "internal_error" });
      yield sseData(e.toJSON());
    }
  }
  reply.raw.setHeader("x-accel-buffering", "no");
  return reply
    .code(200)
    .header("content-type", "text/event-stream; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("connection", "keep-alive")
    .send(Readable.from(guarded(), { objectMode: false }));
}
