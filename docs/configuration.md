# Configuration reference

The gateway reads one YAML (or JSON) file, validates all of it at startup and refuses to
start with a list of every problem it found. Nothing is reloaded at runtime: restart to
apply changes.

- **File:** `$LLM_GATEWAY_CONFIG`, or `./config.yaml`. Start from
  [`config.example.yaml`](../config.example.yaml).
- **Environment variables:** any string value can be `${NAME}` or `${NAME:-default}`, so
  secrets stay out of the file. A `${NAME}` without a default that is not set is an error.
  The result is converted where a number or boolean is expected (`port: ${PORT}` works).
- **`.env`:** a `.env` file in the working directory fills in variables that are not already
  set; the real environment wins.
- **Overrides:** `LLM_GATEWAY_HOST`, `LLM_GATEWAY_PORT` and `LLM_GATEWAY_LOG_LEVEL` take
  precedence over the file.
- **Strict:** unknown keys are errors, so a typo cannot silently disable a setting.

A complete minimal file:

```yaml
backends:
  ollama:
    type: ollama
    url: http://localhost:11434

keys:
  - name: me
    key: ${GATEWAY_KEY}     # openssl rand -hex 32
```

Without `aliases`, clients use the backend's own model names (`qwen3:8b`) and everything goes
to the first backend: enough for one local Ollama.

---

## `server`

| Key | Default | |
|---|---|---|
| `host` | `0.0.0.0` | Interface to listen on. `127.0.0.1` keeps the gateway local to the machine. |
| `port` | `8080` | |
| `bodyLimitBytes` | `4194304` (4 MiB) | Larger request bodies get **413**. Raise it for long contexts or many images. |
| `requestTimeoutMs` | `30000` | A client that takes longer to send its whole request gets **408**. Does not limit how long a response streams. |

## `backends`

A map of name → backend; at least one is required. The name appears in logs, metrics and
upstream error messages (`The backend 'ollama' is unavailable.`), never the URL.

| Key | Default | |
|---|---|---|
| `type` | required | `ollama` for Ollama's native API, `openai` for any OpenAI-compatible server. |
| `url` | required | `http://` or `https://`. For `ollama`, the server root (`http://localhost:11434`); for `openai`, the base URL **including `/v1`**. |
| `apiKey` | none | Sent as `Authorization: Bearer` to the backend (llama.cpp `--api-key`, vLLM `--api-key`). |
| `timeouts.connectMs` | `5000` | TCP/TLS connection setup. Exceeded: **504**. |
| `timeouts.responseMs` | `300000` | Longest **silence** from the backend: before the answer starts (model loading, or a whole non-streamed answer, since Ollama sends nothing until it is done) and between streamed chunks. Every chunk restarts it, so long streams are fine. Exceeded: **504**. |

Typical URLs:

| Server | `type` | `url` |
|---|---|---|
| Ollama | `ollama` | `http://localhost:11434` |
| llama.cpp `llama-server` | `openai` | `http://localhost:8080/v1` |
| LM Studio | `openai` | `http://localhost:1234/v1` |
| vLLM | `openai` | `http://localhost:8000/v1` |
| Ollama's OpenAI API | `openai` | `http://localhost:11434/v1` |

Backends are health-checked every `healthCheck.intervalMs` (Ollama: `/api/version`; OpenAI-
compatible: `/models`). A backend that is down still receives requests; clients get a clear
**502** instead of the gateway guessing.

## `aliases`

A map of the name clients use → where it runs. Two forms:

```yaml
aliases:
  chat-default:
    backend: ollama
    model: qwen3:8b
  embed-default: ollama/nomic-embed-text      # backend/model, split at the first "/"
  coder: llamacpp/hf.co/org/model:Q4_K_M       # so model names with slashes work
```

Once any alias exists, **only aliases are accepted**:

- `/v1/models` lists aliases (only those the key may use), never real model names;
- responses carry the alias in `model`, and errors name the alias;
- asking for a real model name is a **404**, so clients cannot depend on it.

Swap `chat-default` to a new model and every client follows, with no client change.

## `keys`

At least one key is required: the gateway never runs open.

| Key | | |
|---|---|---|
| `name` | required | Shown in logs and metrics instead of the key. Letters, digits, `.`, `_`, `:`, `-`. |
| `key` | required | The bearer secret. Generate with `openssl rand -hex 32`; keys under 24 characters produce a startup warning. Names and values must be unique. |
| `models` | all aliases | Allowlist of aliases. Anything else is **403** (`model_not_allowed`), and `/v1/models` hides it. |
| `limits` | `limits` below | This key's own `requestsPerMinute` / `tokensPerMinute`, overriding the defaults field by field. |

```yaml
keys:
  - name: team
    key: ${GATEWAY_KEY_TEAM}
  - name: ci
    key: ${GATEWAY_KEY_CI}
    models: [chat-default]
    limits: { requestsPerMinute: 30 }
```

Keys are compared in constant time. Clients send them as `Authorization: Bearer <key>`, which
is what every OpenAI client does with its "API key" setting.

## `limits`

Defaults for keys that set none. Omit a field for no limit.

| Key | |
|---|---|
| `requestsPerMinute` | Requests per key per minute. |
| `tokensPerMinute` | Prompt + completion tokens per key per minute, charged when a response completes (estimated for a stream cut short). |

Both are token buckets that refill continuously, so a key can burst up to its limit and then
continues at the steady rate. Refused requests get **429** with `Retry-After`, and responses
to a key with limits carry OpenAI's `x-ratelimit-limit-*`, `x-ratelimit-remaining-*` and
`x-ratelimit-reset-*` headers, so clients can pace themselves.

## `logging`

| Key | Default | |
|---|---|---|
| `level` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `logBodies` | `false` | Add prompts and completions to the log line. Keep it off outside debugging: prompts often contain private data. |

At `info`, the gateway writes **one JSON line per request** when it ends (after the whole
stream, for streamed responses):

```json
{"level":30,"time":1794573662561,"reqId":"demo-1","key":"team","method":"POST","path":"/v1/chat/completions","status":200,"durationMs":9386,"endpoint":"chat","model":"chat-default","backend":"ollama","firstChunkMs":5559,"tokens":{"prompt":16,"completion":200},"msg":"request completed"}
```

`reqId` is the client's `X-Request-Id` when it is a safe token (letters, digits, `._:-`, up to
128 characters), otherwise a new UUID; it is also returned in the response header. The
`Authorization` header is always redacted.

## `metrics`

| Key | Default | |
|---|---|---|
| `enabled` | `true` | Serve Prometheus metrics on `GET /metrics`. |
| `token` | none | Require `Authorization: Bearer <token>` on `/metrics`. Set it whenever the port is reachable by others: the output lists key names and aliases. |

| Metric | Labels | |
|---|---|---|
| `llm_gateway_requests_total` | `key`, `model`, `endpoint`, `status` | Requests to `/v1` endpoints. |
| `llm_gateway_request_duration_seconds` | `key`, `model`, `endpoint` | Until the response (or whole stream) ends. |
| `llm_gateway_time_to_first_chunk_seconds` | `key`, `model`, `endpoint` | Time to first token for streamed responses. |
| `llm_gateway_tokens_total` | `key`, `model`, `type` | `type` is `prompt` or `completion`. |
| `llm_gateway_tokens_estimated_requests_total` | `key`, `model` | Streams whose tokens were estimated because they ended early. |
| `llm_gateway_upstream_errors_total` | `backend`, `model`, `kind` | `unavailable`, `timeout`, `model_not_found`, `overloaded`, `rejected`, `error`. |
| `llm_gateway_rate_limited_total` | `key`, `limit` | `limit` is `requests` or `tokens`. |
| `llm_gateway_backend_up` | `backend` | 1 if the last health check succeeded. |

`model` is always the alias. Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: llm-gateway
    authorization: { credentials: <metrics token> }
    static_configs: [{ targets: ["gateway:8080"] }]
```

## `healthCheck`

| Key | Default | |
|---|---|---|
| `intervalMs` | `30000` | How often every backend is checked. The first round finishes before the server accepts connections. |
| `timeoutMs` | `5000` | A check slower than this counts as down. |

## Endpoints

| Path | Auth | |
|---|---|---|
| `POST /v1/chat/completions` | key | Streaming (SSE) and non-streaming; tools, images (inline `data:` URLs), reasoning content. |
| `POST /v1/completions` | key | Legacy completions, streaming and not. |
| `POST /v1/embeddings` | key | Float and base64 encodings. |
| `GET /v1/models`, `GET /v1/models/{id}` | key | Aliases the key may use. |
| `GET /livez` | none | `{"status":"ok"}` while the process serves requests. For container restarts. |
| `GET /healthz` | none | 200 while at least one backend is up (`ok` / `degraded`), 503 otherwise. Reports only counts, no names or URLs. For load balancers. |
| `GET /metrics` | `metrics.token` | Prometheus text format. |

## Errors

Every error has OpenAI's shape, so SDKs raise their usual exception classes:

```json
{"error": {"message": "This API key is not allowed to use the model 'coder'.", "type": "permission_error", "param": "model", "code": "model_not_allowed"}}
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_value`, `missing_required_parameter`, `invalid_json`, `invalid_body` | The body is not valid JSON, or a parameter is missing or invalid (`param` names it). |
| 4xx | `upstream_rejected` | The backend rejected the request (e.g. context too long); its status and reason are passed on. |
| 401 | `missing_api_key`, `invalid_api_key` | |
| 403 | `model_not_allowed` | The key's `models` list does not include the alias. |
| 404 | `model_not_found`, `unknown_url` | |
| 408 | | The request was not received within `server.requestTimeoutMs`. |
| 413 | `request_too_large` | Over `server.bodyLimitBytes`. |
| 415 | `unsupported_media_type` | Body is not JSON. |
| 429 | `rate_limit_exceeded` | With `Retry-After`. |
| 502 | `upstream_unavailable`, `upstream_error` | The backend is unreachable or failed (its own error text is logged, not sent). |
| 503 | `upstream_overloaded` | The backend answered 429; SDKs retry. |
| 504 | `upstream_timeout` | See `timeouts`. |
