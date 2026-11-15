# Using the gateway from your tools

Anything that talks to the OpenAI API works with the gateway. It needs two settings:

| Setting | Value |
|---|---|
| **Base URL** (`base_url`, `apiBase`, "OpenAI API URL") | `http://<gateway-host>:8080/v1` |
| **API key** | a key from the gateway's `keys:` (not an OpenAI key) |

Use the **alias** as the model name (`chat-default`, `embed-default`, …). `GET /v1/models`
lists the aliases your key may use. The examples below assume

```sh
export GATEWAY_URL=http://localhost:8080/v1
export GATEWAY_KEY=...        # one of the keys in your config
```

- [curl](#curl)
- [OpenAI SDKs: Python and Node.js](#openai-sdks)
- [LangChain](#langchain)
- [Continue (VS Code, JetBrains)](#continue)
- [Open WebUI](#open-webui)
- [n8n](#n8n)

---

## curl

```sh
# Which models can this key use?
curl -s $GATEWAY_URL/models -H "Authorization: Bearer $GATEWAY_KEY"

# Chat
curl -s $GATEWAY_URL/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model": "chat-default", "messages": [{"role": "user", "content": "Why is the sky blue?"}]}'

# Streamed: Server-Sent Events, one "data:" line per chunk, then "data: [DONE]"
curl -N -s $GATEWAY_URL/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model": "chat-default", "stream": true, "messages": [{"role": "user", "content": "Count to five."}]}'

# Embeddings
curl -s $GATEWAY_URL/embeddings \
  -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model": "embed-default", "input": ["first text", "second text"]}'
```

Errors come back in OpenAI's format with a `code` you can act on, e.g.
`{"error": {"code": "model_not_allowed", ...}}` with status 403. The full list is in the
[configuration reference](configuration.md#errors).

## OpenAI SDKs

The official SDKs are tested against the gateway on every endpoint ([conformance suite](../test/conformance.test.ts)).

**Python** (`pip install openai`):

```python
import os
from openai import OpenAI

client = OpenAI(base_url=os.environ["GATEWAY_URL"], api_key=os.environ["GATEWAY_KEY"])

reply = client.chat.completions.create(
    model="chat-default",
    messages=[{"role": "user", "content": "Write a haiku about GPUs."}],
)
print(reply.choices[0].message.content)

for chunk in client.chat.completions.create(
    model="chat-default", stream=True,
    messages=[{"role": "user", "content": "Count to five."}],
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
print()

vectors = client.embeddings.create(model="embed-default", input=["hello", "world"])
print(len(vectors.data[0].embedding))
```

**Node.js** (`npm install openai`):

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: process.env.GATEWAY_URL, apiKey: process.env.GATEWAY_KEY });

const reply = await client.chat.completions.create({
  model: "chat-default",
  messages: [{ role: "user", content: "Write a haiku about GPUs." }],
});
console.log(reply.choices[0].message.content);

const stream = await client.chat.completions.create({
  model: "chat-default",
  stream: true,
  messages: [{ role: "user", content: "Count to five." }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

Both SDKs read `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment, so an existing
tool built on them can often be pointed at the gateway without code changes:

```sh
OPENAI_BASE_URL=$GATEWAY_URL OPENAI_API_KEY=$GATEWAY_KEY your-tool
```

The SDKs also retry automatically on 429 (respecting `Retry-After`), 503 and 504.

## LangChain

```python
# pip install langchain-openai
import os
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

llm = ChatOpenAI(model="chat-default", base_url=os.environ["GATEWAY_URL"], api_key=os.environ["GATEWAY_KEY"])
print(llm.invoke("Explain RAG in one sentence.").content)

embeddings = OpenAIEmbeddings(
    model="embed-default",
    base_url=os.environ["GATEWAY_URL"],
    api_key=os.environ["GATEWAY_KEY"],
    check_embedding_ctx_length=False,   # send text, not token IDs (local backends embed text)
)
print(len(embeddings.embed_query("hello")))
```

## Continue

[Continue](https://continue.dev) (VS Code and JetBrains) uses `provider: openai` with an
`apiBase` for any OpenAI-compatible server. Edit `~/.continue/config.yaml`
(`%USERPROFILE%\.continue\config.yaml` on Windows):

```yaml
name: Local models
version: 1.0.0
schema: v1
models:
  - name: Chat (local)
    provider: openai
    apiBase: http://localhost:8080/v1
    apiKey: <your gateway key>
    model: chat-default
    roles: [chat, edit, apply]
  - name: Autocomplete (local)
    provider: openai
    apiBase: http://localhost:8080/v1
    apiKey: <your gateway key>
    model: coder            # a small, fast model works best for autocomplete
    roles: [autocomplete]
  - name: Embeddings (local)
    provider: openai
    apiBase: http://localhost:8080/v1
    apiKey: <your gateway key>
    model: embed-default
    roles: [embed]
```

Give each developer their own key: their usage shows up separately in the metrics, and one key
can be revoked without touching the others.

## Open WebUI

[Open WebUI](https://openwebui.com) connects to OpenAI-compatible servers. Run it next to the
gateway, for example by adding a service to the gateway's `docker-compose.yml`:

```yaml
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "3000:8080"
    environment:
      OPENAI_API_BASE_URL: http://gateway:8080/v1
      OPENAI_API_KEY: ${GATEWAY_API_KEY}
      ENABLE_OLLAMA_API: "false"     # talk to the gateway only, not to Ollama directly
    volumes:
      - open-webui:/app/backend/data
    depends_on: [gateway]
```

(and `open-webui:` under `volumes:`). Open <http://localhost:3000>; the model picker shows the
gateway's aliases.

These variables only seed the settings on Open WebUI's **first start**. Later, change the
connection in **Admin Panel → Settings → Connections** (URL `http://gateway:8080/v1`, the key
as API key).

With Open WebUI running outside Docker, use `http://localhost:8080/v1`. From a container to a
gateway on the host, use `http://host.docker.internal:8080/v1` (add
`--add-host=host.docker.internal:host-gateway` on Linux).

## n8n

In [n8n](https://n8n.io), create an **OpenAI** credential:

| Field | Value |
|---|---|
| API Key | your gateway key |
| Base URL | `http://<gateway-host>:8080/v1`, including `/v1` |

Use it in the **OpenAI Chat Model** node (for the AI Agent and chain nodes) or the
**Embeddings OpenAI** node, and pick or type the alias as the model. n8n warns that a custom
Base URL may not support every OpenAI feature; chat, streaming, tool calls and embeddings
all work through the gateway, as far as the model behind the alias supports them.

If n8n runs in Docker and the gateway on the host, use `http://host.docker.internal:8080/v1`.

---

Something missing or not working with your tool? [Open an issue](https://github.com/tw4/local-llm-gateway/issues):
the gateway aims to work with every OpenAI client unchanged.
