import { buildApp } from "./app.js";
import { installShutdownHandlers } from "./shutdown.js";

const host = process.env.LLM_GATEWAY_HOST ?? "0.0.0.0";
const port = Number(process.env.LLM_GATEWAY_PORT ?? 8080);

const app = buildApp({ fastify: { logger: true } });

installShutdownHandlers(app, {
  timeoutMs: 10_000,
  log: (m) => {
    app.log.info(m);
  },
});

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
