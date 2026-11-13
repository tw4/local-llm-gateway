import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { errors } from "../src/errors.js";
import { testConfig } from "./helpers.js";

let app: FastifyInstance;
let client: OpenAI;

beforeAll(async () => {
  app = buildApp(testConfig({ server: { bodyLimitBytes: 1024 } }), { fastify: { logger: false } });
  app.get("/v1/throw/:kind", (request) => {
    const { kind } = request.params as { kind: string };
    switch (kind) {
      case "bad":
        throw errors.badRequest("'messages' is required.", "messages");
      case "auth":
        throw errors.invalidApiKey();
      case "forbidden":
        throw errors.modelNotAllowed("chat-big");
      case "model":
        throw errors.modelNotFound("nope");
      case "rate":
        throw errors.rateLimited("Too many requests.", 2.2);
      case "down":
        throw errors.upstreamUnavailable("ollama");
      case "timeout":
        throw errors.upstreamTimeout("ollama");
      default:
        throw new Error("secret internal detail");
    }
  });
  app.post("/v1/echo", (request) => request.body);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  client = new OpenAI({ apiKey: "x", baseURL: `${address}/v1`, maxRetries: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("OpenAI-shaped errors", () => {
  it("has the OpenAI body: message, type, param, code", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/throw/bad" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({
      error: { message: "'messages' is required.", type: "invalid_request_error", param: "messages", code: null },
    });
  });

  it.each([
    ["bad", 400, OpenAI.BadRequestError],
    ["auth", 401, OpenAI.AuthenticationError],
    ["forbidden", 403, OpenAI.PermissionDeniedError],
    ["model", 404, OpenAI.NotFoundError],
    ["rate", 429, OpenAI.RateLimitError],
    ["down", 502, OpenAI.InternalServerError],
    ["timeout", 504, OpenAI.InternalServerError],
    ["crash", 500, OpenAI.InternalServerError],
  ])("the openai SDK raises the right error for %s", async (kind, status, ErrorClass) => {
    const err: unknown = await client.get(`/throw/${kind}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ErrorClass);
    const apiError = err as InstanceType<typeof OpenAI.APIError>;
    expect(apiError.status).toBe(status);
    // The SDK shows the gateway's message, not a generic one.
    expect(apiError.message).toContain(String(status));
    expect(apiError.error).toMatchObject({ type: expect.any(String) as unknown, message: expect.any(String) as unknown });
  });

  it("sets Retry-After on 429 and WWW-Authenticate on 401", async () => {
    expect((await app.inject({ url: "/v1/throw/rate" })).headers["retry-after"]).toBe("3");
    expect((await app.inject({ url: "/v1/throw/auth" })).headers["www-authenticate"]).toMatch(/^Bearer /);
  });

  it("never leaks the message of an unexpected error", async () => {
    const res = await app.inject({ url: "/v1/throw/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret internal detail");
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "internal_error" } });
  });

  it("answers unknown routes with a 404 in the same shape", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/nothing?x=1" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { message: "Invalid URL (POST /v1/nothing)", type: "invalid_request_error", param: null, code: "unknown_url" },
    });
  });

  it("explains invalid JSON, oversized bodies and wrong content types", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/echo", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { type: "invalid_request_error", code: "invalid_json" } });

    const big = await app.inject({
      method: "POST",
      url: "/v1/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ x: "a".repeat(2048) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: "request_too_large" } });

    const media = await app.inject({ method: "POST", url: "/v1/echo", headers: { "content-type": "application/xml" }, payload: "<a/>" });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toMatchObject({ error: { code: "unsupported_media_type" } });
  });

  it("maps upstream error statuses to what the client can act on", () => {
    expect(errors.upstreamError("ollama", 400, "context too long").status).toBe(400);
    expect(errors.upstreamError("ollama", 401, "bad key").status).toBe(502);
    expect(errors.upstreamError("ollama", 429, "busy").status).toBe(503);
    expect(errors.upstreamError("ollama", 500, "boom").status).toBe(502);
  });
});
