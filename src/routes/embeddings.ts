import type { FastifyInstance } from "fastify";
import { parseEmbeddingRequest } from "../openai/validate.js";
import { abortOnDisconnect, hideModelName, type RouteContext } from "./context.js";

/** OpenAI's base64 encoding: the vector as little-endian float32, base64-encoded. */
export function toBase64(vector: number[]): string {
  const floats = new Float32Array(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function registerEmbeddingRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post("/v1/embeddings", async (request, reply) => {
    const req = parseEmbeddingRequest(request.body);
    const target = ctx.resolveModel(req.model);
    const controller = abortOnDisconnect(reply);
    const result = await target.backend.embed({ ...req, model: target.model }, { signal: controller.signal }).catch((err: unknown) => {
      throw hideModelName(err, target);
    });
    return {
      object: "list",
      data: result.embeddings.map((embedding, index) => ({
        object: "embedding",
        index,
        // The official Node SDK asks for base64 by default and decodes it.
        embedding: req.encoding_format === "base64" ? toBase64(embedding) : embedding,
      })),
      model: target.requested,
      usage: { prompt_tokens: result.promptTokens, total_tokens: result.promptTokens },
    };
  });
}
