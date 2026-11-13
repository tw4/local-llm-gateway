import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { startGateway } from "./gateway.js";

const keys = [
  { name: "everything", key: "key-all-0123456789" },
  { name: "chat-only", key: "key-chat-0123456789", models: ["chat-small"] },
  { name: "two", key: "key-two-0123456789", models: ["chat-small", "embed"] },
];
const aliases = {
  "chat-small": "ollama/llama3:8b",
  "chat-big": "ollama/llama3:70b",
  embed: "ollama/llama3:8b",
};

async function start() {
  const gw = await startGateway({ models: ["llama3:8b", "llama3:70b"] }, { keys, aliases });
  const as = (key: string) => new OpenAI({ apiKey: key, baseURL: `${gw.address}/v1`, maxRetries: 0 });
  return { ...gw, as };
}

const chat = (client: OpenAI, model: string) => client.chat.completions.create({ model, messages: [{ role: "user", content: "hi" }] });

describe("per-key model allowlist", () => {
  it("lets a key use the aliases on its list", async () => {
    const { as } = await start();
    await expect(chat(as("key-chat-0123456789"), "chat-small")).resolves.toMatchObject({ model: "chat-small" });
  });

  it("answers 403 model_not_allowed for any other alias, on every endpoint, before calling the backend", async () => {
    const { as, stub } = await start();
    const client = as("key-chat-0123456789");
    const attempts = [
      () => chat(client, "chat-big"),
      () => client.chat.completions.create({ model: "chat-big", messages: [{ role: "user", content: "hi" }], stream: true }),
      () => client.completions.create({ model: "chat-big", prompt: "x" }),
      () => client.embeddings.create({ model: "embed", input: "x" }),
    ];
    for (const attempt of attempts) {
      const err = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OpenAI.PermissionDeniedError);
      expect(err).toMatchObject({ status: 403, code: "model_not_allowed", param: "model", type: "permission_error" });
    }
    expect(stub.modelRequests).toHaveLength(0);
  });

  it("still answers 404 for a model that does not exist", async () => {
    const { as } = await start();
    await expect(chat(as("key-chat-0123456789"), "nope")).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("lets a key without a list use every alias", async () => {
    const { as } = await start();
    const client = as("key-all-0123456789");
    await expect(chat(client, "chat-big")).resolves.toBeDefined();
    await expect(chat(client, "chat-small")).resolves.toBeDefined();
  });

  it("shows each key only its own models", async () => {
    const { as } = await start();
    const ids = async (key: string) => (await as(key).models.list()).data.map((m) => m.id);
    expect(await ids("key-all-0123456789")).toEqual(["chat-small", "chat-big", "embed"]);
    expect(await ids("key-chat-0123456789")).toEqual(["chat-small"]);
    expect(await ids("key-two-0123456789")).toEqual(["chat-small", "embed"]);
    // A model outside the list is "not found", so the list cannot be probed through retrieve.
    await expect(as("key-chat-0123456789").models.retrieve("chat-big")).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await expect(as("key-all-0123456789").models.retrieve("chat-big")).resolves.toMatchObject({ id: "chat-big" });
  });
});
