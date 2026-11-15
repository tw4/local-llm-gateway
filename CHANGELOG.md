# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The section for a version becomes the
notes of its GitHub release.

Releases start with 1.0. The roadmap milestones before it were not tagged separately;
their changes are listed below for reference and ship in the first release.

## [Unreleased]

## [1.0.0] - 2026-11-15

The first release: the gateway is feature-complete for the v1.0 roadmap, reviewed for
security and published as a container image.

### Added

- Container images for `linux/amd64` and `linux/arm64` on Docker Hub
  (`mertturkoglu/local-llm-gateway`) and GitHub Container Registry
  (`ghcr.io/tw4/local-llm-gateway`).
- Documentation: a [configuration reference](https://github.com/tw4/local-llm-gateway/blob/main/docs/configuration.md) and
  [guides](https://github.com/tw4/local-llm-gateway/blob/main/docs/integrations.md) for curl, the OpenAI SDKs, LangChain, Continue, Open WebUI
  and n8n ([#21](https://github.com/tw4/local-llm-gateway/issues/21)).
- Releases: a `v*` tag publishes a multi-arch container image (`linux/amd64`, `linux/arm64`)
  to `ghcr.io/tw4/local-llm-gateway`, with an SBOM and build provenance, and a GitHub
  release with these notes ([#22](https://github.com/tw4/local-llm-gateway/issues/22)).
- `npm run verify`: every local check before a release in one command (lint, typecheck,
  tests, build, production `npm audit`, OpenAI SDK smoke test with Node and Python).
- `server.requestTimeoutMs` (30 s): a client that takes longer to send its request gets
  408 ([#20](https://github.com/tw4/local-llm-gateway/issues/20)).
- Startup warnings for API keys shorter than 24 characters and for `/metrics` without a
  token on a public interface.
- `SECURITY.md`: how to report a vulnerability, the threat model and a hardening checklist.

### Changed

- A backend's 5xx error text is logged instead of being sent to the client, since it can
  name files and hosts. 4xx text (such as "context too long") is still passed on.

### Fixed

- **Security:** percent-encoded paths such as `/%76%31/models` reached `/v1` routes without
  an API key. Authentication now uses the route the router matched.
- `docker-compose.yml` mounted `docker/config.yaml`, which was missing from the repository
  because `.gitignore` excluded every `config.yaml`.

## Milestone v0.3 — Operations (2026-11-13)

Run it for a team and know what is happening.

### Added

- Per-key request and token rate limits, with `Retry-After` (#37).
- Token usage accounting per key and alias, estimated for streams cut short (#36).
- Prometheus metrics on `/metrics`, optionally behind a token (#38).
- One structured JSON log line per request; prompts and completions only with
  `logging.logBodies` (#39).
- Upstream timeouts (connect, and silence between chunks) and distinct 502/504 errors;
  cancelling the upstream request when the client disconnects (#35).
- OpenAI SDK conformance suite covering every endpoint, against both backend types (#40).
- Overhead benchmark (`npm run bench`), with the numbers in the README (#41).

### Changed

- Upstream calls use undici's `request()` instead of `fetch()`, roughly halving the latency
  the gateway adds under load (#41).
- Non-JSON request bodies get 415 instead of a validation error (#40).

## Milestone v0.2 — Backends and aliases (2026-11-13)

One gateway in front of several inference servers.

### Added

- OpenAI-compatible backend for llama.cpp, LM Studio and vLLM (#32).
- Model aliases (`alias → backend/model`), including the `backend/model` short form; real
  model names never reach clients (#33).
- Per-key model allowlists (#34).
- Backend health checks, `/healthz` (readiness) and `/livez` (liveness) (#29).

## Milestone v0.1 — Core proxy (2026-11-13)

An OpenAI client pointed at the gateway can chat with a local Ollama model.

### Added

- Configuration from a YAML file and environment variables, validated at startup (#24).
- API-key authentication with constant-time comparison (#26).
- `/v1/chat/completions` for Ollama, streaming and non-streaming (#27).
- `/v1/completions`, `/v1/embeddings` and `/v1/models` (#28).
- OpenAI-shaped error responses for every failure (#25).
- `Dockerfile` and `docker-compose.yml` with Ollama (#30).
- SDK smoke test with the official Node and Python clients (#31).

[Unreleased]: https://github.com/tw4/local-llm-gateway/compare/v1.0.0...main
[1.0.0]: https://github.com/tw4/local-llm-gateway/releases/tag/v1.0.0
