# Roadmap

Each milestone has a definition of done. Issues are linked from the
[milestones page](../../milestones).

## v0.1 — Core proxy

Goal: an OpenAI client pointed at the gateway can chat with a local Ollama model.

- Project skeleton: TypeScript, Fastify, Vitest, lint, CI
- Configuration from a file and environment variables, validated at startup
- API-key authentication (`Authorization: Bearer`), several keys, constant-time compare
- `/v1/chat/completions`, non-streaming and streaming (SSE), mapped to Ollama
- `/v1/completions`, `/v1/embeddings`, `/v1/models`
- OpenAI-shaped error responses
- `Dockerfile` and `docker-compose.yml` with Ollama

**Done when:** the official `openai` npm and Python SDKs can chat (with and without
streaming) and create embeddings through the gateway in CI.

## v0.2 — Backends & aliases

Goal: one gateway in front of several inference servers.

- Backend interface; Ollama and generic OpenAI-compatible upstream implementations
- Model aliases (`alias → backend/model`), real names hidden from `/v1/models`
- Per-key model allowlist
- Backend health checks and a `/healthz` endpoint

**Done when:** one gateway serves an Ollama model and a llama.cpp model under aliases,
and a key restricted to one alias cannot use the other.

## v0.3 — Operations

Goal: you can run it for a team and know what is happening.

- Per-key request and token rate limits
- Token usage accounting per key and model
- Prometheus `/metrics`
- Structured JSON logs; prompt and completion bodies redacted unless enabled
- Timeouts, cancellation when the client disconnects, clear upstream errors

**Done when:** a load test shows limits enforced and metrics matching the traffic sent.

## v1.0 — Release

- Conformance suite against the OpenAI SDKs covering every endpoint
- Overhead benchmark (p50/p95 added latency) with results in the README
- Security review: auth, header handling, request size limits, SSRF on upstream URLs
- Documentation and examples (Continue, Open WebUI, n8n, curl)
- Container image published with tagged releases
