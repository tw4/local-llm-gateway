# local-llm-gateway

**An OpenAI-compatible gateway for the models you run yourself.**

> **Status: planning.** There is no code yet. This README describes what the project
> will be; the work is tracked in [ROADMAP.md](ROADMAP.md), the
> [milestones](../../milestones) and the [issues](../../issues).

Teams that run models locally (Ollama, llama.cpp, LM Studio, vLLM) end up with the same
problems: every tool expects the OpenAI API, the inference server has no real
authentication, nobody knows which client used how many tokens, and the model name leaks
into every integration. `local-llm-gateway` is a small HTTP service that sits in front of
those servers and fixes exactly that, without becoming an inference engine itself.

```
 OpenAI SDKs, IDE plugins,       ┌────────────────────┐       Ollama
 internal apps, n8n, curl  ───►  │ local-llm-gateway  │ ───►  llama.cpp server
   (Authorization: Bearer)       │ auth · aliases ·   │       LM Studio
                                 │ limits · metrics   │       vLLM
                                 └────────────────────┘
```

## Planned features

| Area | What it does |
|---|---|
| **OpenAI-compatible API** | `/v1/chat/completions` (streaming and non-streaming), `/v1/completions`, `/v1/embeddings`, `/v1/models` |
| **Authentication** | Multiple API keys, constant-time comparison, per-key model allowlist |
| **Model aliases** | Clients ask for `chat-default`; the gateway decides it is `qwen3:8b` today and something else tomorrow |
| **Multiple backends** | Ollama natively, plus any OpenAI-compatible upstream (llama.cpp server, LM Studio, vLLM) |
| **Limits** | Per-key request and token rate limits |
| **Observability** | Token usage per key and model, Prometheus `/metrics`, structured logs with prompts redacted by default |
| **Operations** | Health checks for every backend, clear upstream errors, one `docker compose up` |

### Non-goals

- Running models. Inference stays in Ollama, llama.cpp, vLLM and friends.
- Routing to cloud providers. The point is that data stays on your hardware.
- A UI. Configuration is a file and environment variables.

## Design principles

1. **Conformance over features.** Every endpoint is tested against the official OpenAI
   SDKs, so existing clients work without changes.
2. **Measured overhead.** The gateway publishes its own latency overhead (p50/p95) under
   load, with the benchmark in the repository.
3. **Safe defaults.** No key, no access. Prompts are not logged unless you turn it on.

## Planned stack

TypeScript on Node.js 22, a small HTTP framework (Fastify), Vitest for tests, Docker for
distribution.

## Roadmap at a glance

| Milestone | Outcome |
|---|---|
| **v0.1 — Core proxy** | Chat, completions, embeddings and models against Ollama, with API-key auth and Docker |
| **v0.2 — Backends & aliases** | OpenAI-compatible upstreams, model aliases, per-key model allowlist |
| **v0.3 — Operations** | Rate limits, usage accounting, Prometheus metrics, redacted logs |
| **v1.0 — Release** | SDK conformance suite, overhead benchmark, security review, published image |

Details: [ROADMAP.md](ROADMAP.md).

## Run with Docker

`docker-compose.yml` starts Ollama, pulls a small chat model and an embedding model, and
starts the gateway on port 8080:

```bash
echo "GATEWAY_API_KEY=$(openssl rand -hex 32)" > .env
docker compose up -d

source .env
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "chat-default", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Choose other models with `CHAT_MODEL` and `EMBED_MODEL` in `.env`. The gateway's
configuration is [`docker/config.yaml`](docker/config.yaml). The image runs as a non-root user
with a read-only file system, and its health check uses `/livez`.

## Development

Requires Node.js 22.19 or later.

```bash
npm install
npm run dev      # start with reload (tsx)
npm run check    # lint, type-check and tests: run this before every commit and pull request
npm run build    # compile to dist/
```

### SDK conformance

`npm test` includes a conformance suite (`test/conformance.test.ts`) that runs the official
`openai` Node SDK against the gateway with each backend type: every endpoint (streaming and
not), tool calls, reasoning, the SDK's stream and pagination helpers, streaming edge cases (client
abort, a backend that dies or goes silent mid-stream, multi-byte characters split across network
packets) and every error class with its status, `code` and body shape.

`npm run smoke` does the same with the Python SDK, plus a short Node run, against a gateway it
starts. By default the backend is an Ollama stub, so no model is needed:

```bash
python3 -m venv .venv-smoke && .venv-smoke/bin/pip install -r scripts/smoke/requirements.txt
npm run smoke
# against a real Ollama with small models:
npm run smoke -- --ollama http://localhost:11434 --chat-model qwen3:0.6b --embed-model all-minilm
```

Use `--skip-python` to run the Node SDK only, or `PYTHON=/path/to/python` to pick the interpreter.

## License

[MIT](LICENSE) © Mert Türkoğlu · [mertturkoglu.com](https://www.mertturkoglu.com)
