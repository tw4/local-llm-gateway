import type { FastifyInstance } from "fastify";
import type { KeyConfig } from "../config/schema.js";
import { errors } from "../errors.js";
import { isAllowed } from "../models.js";
import type { ModelInfo } from "../openai/types.js";
import { abortOnDisconnect, type RouteContext } from "./context.js";

interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

const OWNER = "local-llm-gateway";

export function registerModelRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const startedAt = Math.floor(Date.now() / 1000);
  const aliases = Object.keys(ctx.config.aliases);

  /**
   * With aliases, the list is the aliases the key may use (real names stay hidden).
   * Without, it is every model the backends report.
   */
  async function list(signal: AbortSignal, key: KeyConfig | null): Promise<OpenAIModel[]> {
    let models: ModelInfo[];
    if (aliases.length > 0) {
      models = aliases.filter((id) => isAllowed(key, id)).map((id) => ({ id, created: startedAt }));
    } else {
      const lists = await Promise.all([...ctx.backends.values()].map((b) => b.listModels({ signal })));
      const seen = new Set<string>();
      models = lists.flat().filter((m) => !seen.has(m.id) && seen.add(m.id));
    }
    return models.map((m) => ({ id: m.id, object: "model", created: m.created, owned_by: OWNER }));
  }

  app.get("/v1/models", async (request, reply) => {
    request.gw.endpoint = "models";
    const controller = abortOnDisconnect(reply);
    return { object: "list", data: await list(controller.signal, request.apiKey) };
  });

  // Model ids can contain slashes (hf.co/org/model), so match the rest of the path.
  // A model the key may not use is "not found" here, like in the list.
  app.get("/v1/models/*", async (request, reply) => {
    request.gw.endpoint = "models";
    const id = decodeURIComponent((request.params as { "*": string })["*"]);
    const controller = abortOnDisconnect(reply);
    const model = (await list(controller.signal, request.apiKey)).find((m) => m.id === id);
    if (!model) throw errors.modelNotFound(id);
    return model;
  });
}
