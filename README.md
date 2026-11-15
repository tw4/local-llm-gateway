<div align="center">

# local-llm-gateway

**API keys, model aliases, rate limits and metrics for the models you run yourself.**

One small container in front of Ollama, llama.cpp, LM Studio or vLLM that speaks the OpenAI API,<br>
so every tool your team already uses works with your local models: securely, and with numbers.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white)](package.json)
[![OpenAI SDK conformance](https://img.shields.io/badge/OpenAI%20SDKs-conformance%20tested-412991)](test/conformance.test.ts)
[![Overhead](https://img.shields.io/badge/overhead-0.23%20ms%20p50-success)](#how-fast-is-it)

[Quick start](#quick-start) · [Why](#why) · [Works with](#works-with-your-tools) · [Configuration](docs/configuration.md) · [Security](SECURITY.md)

</div>

```
 Continue, Open WebUI, n8n,        ┌──────────────────────┐       Ollama
 LangChain, OpenAI SDKs, curl ───► │  local-llm-gateway   │ ───►  llama.cpp server
     Authorization: Bearer …       │ keys · aliases ·     │       LM Studio
                                   │ limits · metrics     │       vLLM
                                   └──────────────────────┘
```

## Why

You got Ollama running on a GPU box. Then the team wanted to use it, and:

| The problem | What the gateway does |
|---|---|
| Ollama and llama.cpp have **no authentication**: anyone who can reach the port can use your GPU. | **A key per person or app**, compared in constant time. No key, no access. The gateway refuses to start without one. |
| Every tool hard-codes a model name, and switching models means **editing every integration**. | **Aliases**: clients ask for `chat-default`. Point it at a new model in one line and every client follows. Real model names never leak. |
| One runaway script can **monopolize the GPU** for everyone. | **Per-key rate limits** on requests and tokens. Clients get a 429 with `Retry-After`, which the OpenAI SDKs honor when they retry. |
| Nobody knows **who used how many tokens** or why it is slow. | **Prometheus metrics** per key and alias (tokens, latency, time to first token, upstream errors), plus one JSON log line per request, prompts redacted by default. |
| Two servers, two APIs: Ollama here, vLLM there. | **One OpenAI-compatible endpoint** in front of all of them, with health checks. |

It does **not** run models, call cloud providers or ship a UI. It is one Node.js process and a YAML file.

## Quick start

With Docker, Ollama and two small models included:

```bash
git clone https://github.com/tw4/local-llm-gateway && cd local-llm-gateway
echo "GATEWAY_API_KEY=$(openssl rand -hex 32)" > .env
docker compose up -d          # first start pulls qwen3:0.6b and all-minilm

source .env
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"model": "chat-default", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Pick other models with `CHAT_MODEL` and `EMBED_MODEL` in `.env`. Ollama's port is not published:
only the gateway can reach it.

**Already running Ollama?** Run just the gateway (Node.js 22.19+):

```bash
cp config.example.yaml config.yaml      # set your keys and aliases
npm install && npm run build && npm start
```

The container image is published to `ghcr.io/tw4/local-llm-gateway` with every release
(`linux/amd64` and `linux/arm64`).

## Point any OpenAI client at it

Change the base URL and the key. Nothing else:

```python
from openai import OpenAI

client = OpenAI(base_url="http://gpu-box:8080/v1", api_key="<gateway key>")
client.chat.completions.create(model="chat-default", messages=[{"role": "user", "content": "Hi"}])
```

Streaming, tool calls, images, reasoning content, embeddings (float and base64) and the SDKs'
own helpers all work. They are tested against the official **Node and Python SDKs** on every
endpoint, including the edge cases: client aborts, backends dying mid-stream, multi-byte
characters split across network packets, and every error class.

## Works with your tools

| Tool | Setup |
|---|---|
| **Continue** (VS Code, JetBrains) | `provider: openai` + `apiBase` → [guide](docs/integrations.md#continue) |
| **Open WebUI** | `OPENAI_API_BASE_URL` → [guide](docs/integrations.md#open-webui) |
| **n8n** | OpenAI credential with a Base URL → [guide](docs/integrations.md#n8n) |
| **LangChain** | `ChatOpenAI(base_url=…)` → [guide](docs/integrations.md#langchain) |
| **OpenAI SDKs** (Python, Node.js, …) | `base_url` + `api_key`, or `OPENAI_BASE_URL` → [guide](docs/integrations.md#openai-sdks) |
| **curl** and everything else | [examples](docs/integrations.md#curl) |

## Configuration in one screen

```yaml
backends:
  ollama:   { type: ollama, url: http://localhost:11434 }
  llamacpp: { type: openai, url: http://localhost:8081/v1 }     # llama.cpp, LM Studio, vLLM

aliases:
  chat-default: ollama/qwen3:8b
  coder: llamacpp/qwen2.5-coder-7b
  embed-default: ollama/nomic-embed-text

limits:                        # defaults for every key
  requestsPerMinute: 120
  tokensPerMinute: 200000

keys:
  - name: alice
    key: ${KEY_ALICE}          # secrets come from the environment
  - name: ci-bot
    key: ${KEY_CI}
    models: [chat-default]     # this key can use nothing else
    limits: { requestsPerMinute: 30 }

metrics:
  token: ${METRICS_TOKEN}
```

Validated at startup, with every problem listed at once. Every option is in the
[configuration reference](docs/configuration.md).

## How fast is it?

About **a quarter of a millisecond** per request. A local model needs tens to thousands of
milliseconds for the same request, so the gateway's share is well below 1 %.

Measured with `npm run bench`: a backend that answers instantly (so only the gateway is
measured), the built gateway with production logging, and a load generator, each in its own
process, in 5 alternating rounds against the backend directly and through the gateway.

| Scenario | Concurrency | Added by the gateway, p50 / p95 (ms) | Requests/s, direct / gateway |
|---|---:|---:|---:|
| chat | 1 | **0.23 / 0.39** | 7226 / 2465 |
| chat | 16 | **2.39 / 3.31** | 13346 / 4354 |
| chat | 64 | **8.93 / 10.06** | 13720 / 4658 |
| chat, streamed (20 chunks) | 16 | **5.79 / 7.45** | 11570 / 2156 |
| embeddings (8 × 384 floats) | 16 | **2.49 / 3.99** | 4037 / 2408 |

Intel Core i9-12950HX, Windows 11, Node.js 26.5, no errors in any run. One gateway process
becomes the queue at roughly 2,000–4,500 requests per second, far beyond what a set of GPUs
serving real models answers.

## Secure by default

- No key, no access: every `/v1` route, every encoding of its path, constant-time comparison.
- Prompts and completions are not logged unless you turn it on; the `Authorization` header never is.
- Clients cannot make the gateway or a backend fetch URLs; backend error text that could reveal
  internals stays in the log.
- Request size and time limits, a non-root read-only container, no capabilities.

The pre-1.0 review, its findings and a hardening checklist are in [SECURITY.md](SECURITY.md).

## How it compares

| | Exposing Ollama directly | nginx with basic auth | local-llm-gateway |
|---|:-:|:-:|:-:|
| Authentication | – | Basic auth, which OpenAI clients do not send | a Bearer key per person or app |
| Per-key model allowlists and rate limits | – | – | ✓ |
| Model aliases, real names hidden | – | – | ✓ |
| Token usage and latency per key | – | – | ✓ (Prometheus) |
| Ollama and OpenAI-compatible servers behind one API | – | manual | ✓ |
| Errors that OpenAI SDKs understand | – | – | ✓ |

Need cloud providers, budgets or a UI? [LiteLLM](https://github.com/BerriAI/litellm) is the
right tool for that. This project is for when everything runs on your own hardware and you want
a single small process configured by one file.

## Documentation

- [Configuration reference](docs/configuration.md): every option, endpoints, metrics, log format, errors
- [Integrations](docs/integrations.md): Continue, Open WebUI, n8n, LangChain, SDKs, curl
- [Security](SECURITY.md): reporting, threat model, hardening
- [Changelog](CHANGELOG.md) · [Releasing](docs/releasing.md) · [Roadmap](ROADMAP.md)

## Development

```bash
npm install
npm run dev       # start with reload
npm run check     # lint, typecheck, tests
npm run verify    # everything before a release, including the Python SDK smoke test
npm run bench     # overhead benchmark
```

Bug reports, integration guides for more tools and pull requests are welcome.

---

<div align="center">

**If this saved you from writing yet another nginx config, a ⭐ helps others find it.**

[MIT](LICENSE) © Mert Türkoğlu · [mertturkoglu.com](https://www.mertturkoglu.com)

</div>
