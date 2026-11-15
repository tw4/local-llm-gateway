# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/tw4/local-llm-gateway/security/advisories/new)
with the version or commit, your configuration (keys removed) and the steps to reproduce.
You should get an answer within a week. Fixes are released as soon as they are ready and
credited in the changelog unless you prefer otherwise.

Only the latest release is supported; before 1.0, that is the latest release or `main`.

## Threat model

The gateway sits between **untrusted clients** and **inference servers that trust anyone
who can reach them** (Ollama and llama.cpp have no authentication of their own).

| Trusted | Untrusted |
|---|---|
| The configuration file and environment: backend URLs, keys, aliases | Every HTTP request: path, headers, body, connection behaviour |
| The machine and network the gateway runs on | Response bodies from backends (parsed defensively, never forwarded raw on errors) |

What it guarantees:

- **No request reaches a backend without a valid key.** Every `/v1` route requires
  `Authorization: Bearer`, decided on the route the router actually matched, so encoded
  paths such as `/%76%31/models` cannot slip past. Keys are compared in constant time
  (SHA-256 digests with `timingSafeEqual`), every configured key on every request.
- **A key cannot reach models outside its allowlist**, and real model names never appear
  in responses, lists or error messages.
- **Clients cannot make the gateway or a backend fetch URLs.** Backend URLs come only from
  the configuration; redirects from backends are not followed; image inputs must be inline
  `data:` URLs, so a backend that fetches remote images (vLLM) is never asked to.
- **Bounded requests:** bodies over `server.bodyLimitBytes` (4 MiB) get 413, a client that
  takes longer than `server.requestTimeoutMs` (30 s) to send its request is dropped with
  408, non-JSON bodies get 415, and `__proto__` keys in JSON are rejected.
- **No secrets in logs or responses:** the `Authorization` header is redacted, keys are
  logged by name, prompts and completions are not logged unless `logging.logBodies` is on,
  unexpected errors return a generic 500, and a backend's own failure text (which can name
  files and hosts) is logged but not sent to the client.

What it does **not** do:

- **TLS.** Run it behind a reverse proxy (Caddy, nginx, Traefik) for HTTPS. Keys travel
  in a header, so plain HTTP is only acceptable on a trusted network.
- **Lock out failed logins.** There is no per-IP limit on wrong keys; long random keys make
  guessing impractical. If the gateway is on the internet, limit 401s at the proxy.
- **Protect the backends from direct access.** If a client can reach Ollama's port, the
  gateway is bypassed. Keep backends on a private network (the bundled `docker-compose.yml`
  does not publish Ollama's port).

## Hardening checklist

- Generate keys with `openssl rand -hex 32`. The gateway warns at startup about keys shorter
  than 24 characters.
- Give each person or application its own key, with `models:` and `limits:` where it makes sense.
- Set `metrics.token`, or keep `/metrics` off the public interface: it lists key names and
  aliases. The gateway warns when it is open on a public interface.
- Leave `logging.logBodies` off unless you are debugging; prompts often contain private data.
- Run the container as shipped: non-root user, read-only file system, no capabilities,
  `no-new-privileges` (see `docker-compose.yml`).

## Security review (v1.0)

A review of the code before 1.0 ([#20](https://github.com/tw4/local-llm-gateway/issues/20)) covered
authentication, header handling, request limits, upstream URL handling and dependencies.
Every finding has a regression test in [`test/security.test.ts`](test/security.test.ts).

| Area | Finding | Fixed |
|---|---|---|
| Authentication | `/v1` was detected on the raw URL while the router decodes it: `GET /%76%31/models` and `POST /v%31/chat/completions` worked **without a key** | Decided on the matched route; no key is allowed any model as a second check |
| Request limits | Fastify's `requestTimeout` was not effective: Node ignores it while `headersTimeout` (60 s) is longer, and checks only every 30 s, so slow clients could hold connections open indefinitely | `server.requestTimeoutMs` (30 s) passed to Node correctly; 408 within the limit |
| Information disclosure | Backend 5xx error text (file paths, hosts) was forwarded to clients | Logged, not sent; 4xx text (e.g. context too long) is still passed on so clients can fix the request |
| Configuration | Short keys and an unauthenticated `/metrics` on a public interface were silently accepted | Startup warnings |
| Dependencies | `npm audit`: `minimatch` ReDoS (moderate, lint tooling only) | Pinned to a patched version; `npm audit` is clean |
| SSRF | Remote `image_url`s, backend redirects | Already safe; now covered by tests |
| Headers | `X-Request-Id` (validated before logging), `Authorization` (redacted), upstream response headers (never forwarded) | Already safe |
