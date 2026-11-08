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

## License

[MIT](LICENSE) © Mert Türkoğlu · [mertturkoglu.com](https://www.mertturkoglu.com)
