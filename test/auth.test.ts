import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { bearerToken, createKeyMatcher } from "../src/auth.js";
import { ConfigError, parseConfig } from "../src/config/load.js";
import { testConfig } from "./helpers.js";

const keys = [
  { name: "alice", key: "alice-secret-0123456789" },
  { name: "bob", key: "bob-secret-9876543210" },
];

let app: FastifyInstance;
let address: string;

beforeAll(async () => {
  app = buildApp(testConfig({ keys }), { fastify: { logger: false } });
  app.get("/v1/whoami", (request) => ({ key: request.apiKey?.name }));
  app.get("/public", () => ({ ok: true }));
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
});

describe("API-key authentication", () => {
  it("accepts every configured key and knows which one was used", async () => {
    for (const k of keys) {
      const res = await app.inject({ url: "/v1/whoami", headers: { authorization: `Bearer ${k.key}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ key: k.name });
    }
  });

  it("accepts the scheme in any case", async () => {
    const res = await app.inject({ url: "/v1/whoami", headers: { authorization: `bearer ${keys[0]?.key ?? ""}` } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a missing header with 401 missing_api_key", async () => {
    const res = await app.inject({ url: "/v1/whoami" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer realm=/);
    expect(res.json()).toMatchObject({ error: { type: "invalid_request_error", code: "missing_api_key" } });
  });

  it.each([
    ["a wrong key", "Bearer wrong"],
    ["a prefix of a key", `Bearer ${keys[0]?.key.slice(0, -1) ?? ""}`],
    ["a key with extra characters", `Bearer ${keys[0]?.key ?? ""}x`],
  ])("rejects %s with 401 invalid_api_key", async (_label, header) => {
    const res = await app.inject({ url: "/v1/whoami", headers: { authorization: header } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    // The key is never echoed back.
    expect(res.body).not.toContain(header.slice(7));
  });

  it.each([["Basic YWxpY2U6c2VjcmV0"], ["Bearer"], ["Bearer a b"], [""]])("treats %j as no key", async (header) => {
    const res = await app.inject({ url: "/v1/whoami", headers: { authorization: header } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "missing_api_key" } });
  });

  it("protects unknown /v1 paths too, so they cannot be probed", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/does-not-exist" });
    expect(res.statusCode).toBe(401);
  });

  it("leaves paths outside /v1 open", async () => {
    expect((await app.inject({ url: "/public" })).statusCode).toBe(200);
  });

  it("works with the openai SDK", async () => {
    const good = new OpenAI({ apiKey: keys[1]?.key, baseURL: `${address}/v1`, maxRetries: 0 });
    await expect(good.get("/whoami")).resolves.toEqual({ key: "bob" });
    const bad = new OpenAI({ apiKey: "nope", baseURL: `${address}/v1`, maxRetries: 0 });
    await expect(bad.get("/whoami")).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
  });
});

describe("createKeyMatcher", () => {
  it("returns the matching key or null", () => {
    const match = createKeyMatcher(keys);
    expect(match("bob-secret-9876543210")?.name).toBe("bob");
    expect(match("")).toBeNull();
    expect(match("x".repeat(10_000))).toBeNull();
  });
});

describe("bearerToken", () => {
  it("extracts the token", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("BEARER   abc  ")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Token abc")).toBeNull();
  });
});

describe("startup", () => {
  it("refuses to run without at least one key", () => {
    const text = "backends:\n  ollama: { type: ollama, url: 'http://localhost:11434' }\n";
    expect(() => parseConfig(text, { env: {} })).toThrow(ConfigError);
    expect(() => parseConfig(text, { env: {} })).toThrow(/keys: define at least one API key/);
    expect(() => parseConfig(`${text}keys: []\n`, { env: {} })).toThrow(/keys: define at least one API key/);
  });
});
