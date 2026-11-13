"""Conformance checks with the official OpenAI Python SDK.

Run by scripts/smoke/run.ts, which starts the gateway and sets:
  GATEWAY_URL, GATEWAY_KEY, RESTRICTED_KEY, LIMITED_KEY, CHAT_MODEL, EMBED_MODEL
Every check runs; the exit code is non-zero if any failed.
"""

import base64
import os
import struct
import sys
import urllib.error
import urllib.request

import openai
from openai import OpenAI

URL = os.environ["GATEWAY_URL"] + "/v1"
chat_model = os.environ["CHAT_MODEL"]
embed_model = os.environ["EMBED_MODEL"]


def client_for(key):
    return OpenAI(api_key=key, base_url=URL, max_retries=0)


client = client_for(os.environ["GATEWAY_KEY"])
failures = 0


def check(name, fn):
    global failures
    try:
        fn()
        print(f"  ok    python  {name}")
    except Exception as e:  # noqa: BLE001 - report every failure, keep going
        failures += 1
        print(f"  FAIL  python  {name}: {type(e).__name__}: {e}")


def expect_error(error_class, status, code, call):
    try:
        call()
    except error_class as e:
        assert e.status_code == status, e.status_code
        assert e.code == code, e.code
        assert isinstance(e.body, dict) and set(e.body) == {"message", "type", "param", "code"}, e.body
        return
    raise AssertionError(f"expected {error_class.__name__}")


# ---- chat


def chat():
    r = client.chat.completions.create(model=chat_model, messages=[{"role": "user", "content": "Say hello"}], max_tokens=64)
    assert r.object == "chat.completion", r.object
    assert r.id.startswith("chatcmpl-"), r.id
    assert r.model == chat_model, r.model
    assert r.choices[0].message.role == "assistant"
    assert r.choices[0].finish_reason in ("stop", "length"), r.choices[0].finish_reason
    assert r.usage is not None and r.usage.total_tokens == r.usage.prompt_tokens + r.usage.completion_tokens, r.usage


def chat_stream():
    stream = client.chat.completions.create(
        model=chat_model,
        messages=[{"role": "user", "content": "Say hello"}],
        max_tokens=64,
        stream=True,
        stream_options={"include_usage": True},
    )
    roles, finishes, usage, ids = [], [], None, set()
    for c in stream:
        ids.add(c.id)
        if c.choices:
            if c.choices[0].delta.role:
                roles.append(c.choices[0].delta.role)
            if c.choices[0].finish_reason:
                finishes.append(c.choices[0].finish_reason)
        if c.usage:
            usage = c.usage
    assert roles == ["assistant"], roles
    assert len(finishes) == 1 and finishes[0] in ("stop", "length"), finishes
    assert usage is not None and usage.total_tokens > 0, usage
    assert len(ids) == 1, ids


def chat_stream_helper():
    try:
        with client.chat.completions.stream(model=chat_model, messages=[{"role": "user", "content": "Say hello"}], max_tokens=64) as s:
            final = s.get_final_completion()
    except openai.LengthFinishReasonError:
        # The helper raises when finish_reason is "length" (a thinking model can use all 64
        # tokens): the gateway reported the cut-off correctly.
        return
    assert final.choices[0].message is not None


# ---- completions


def completions():
    r = client.completions.create(model=chat_model, prompt="Hello", max_tokens=32)
    assert r.object == "text_completion", r.object
    assert r.choices[0].finish_reason in ("stop", "length")


def completions_stream():
    chunks = list(client.completions.create(model=chat_model, prompt="Hello", max_tokens=32, stream=True))
    assert len(chunks) >= 1
    assert all(c.object == "text_completion" for c in chunks)


# ---- embeddings


def embeddings():
    r = client.embeddings.create(model=embed_model, input=["hello", "world"])
    assert [d.index for d in r.data] == [0, 1]
    assert len(r.data[0].embedding) > 0
    assert all(isinstance(x, float) for x in r.data[0].embedding[:5])


def embeddings_base64():
    floats = client.embeddings.create(model=embed_model, input="hello", encoding_format="float").data[0].embedding
    raw = client.embeddings.with_raw_response.create(model=embed_model, input="hello", encoding_format="base64").http_response.json()
    data = base64.b64decode(raw["data"][0]["embedding"])
    decoded = list(struct.unpack(f"<{len(data) // 4}f", data))
    assert len(decoded) == len(floats)
    assert all(abs(a - b) < 1e-5 for a, b in zip(decoded, floats))


# ---- models


def models():
    ids = [m.id for m in client.models.list()]
    assert chat_model in ids and embed_model in ids, ids
    m = client.models.retrieve(chat_model)
    assert m.id == chat_model and m.object == "model", m


# ---- error classes


def bad_request():
    expect_error(openai.BadRequestError, 400, "invalid_value", lambda: client.chat.completions.create(model=chat_model, messages=[]))


def wrong_key():
    expect_error(openai.AuthenticationError, 401, "invalid_api_key", lambda: client_for("wrong").models.list())


def not_allowed():
    restricted = client_for(os.environ["RESTRICTED_KEY"])
    expect_error(
        openai.PermissionDeniedError, 403, "model_not_allowed", lambda: restricted.embeddings.create(model=embed_model, input="x")
    )


def unknown_model():
    expect_error(
        openai.NotFoundError,
        404,
        "model_not_found",
        lambda: client.chat.completions.create(model="no-such-model", messages=[{"role": "user", "content": "x"}]),
    )


def rate_limited():
    limited = client_for(os.environ["LIMITED_KEY"])
    limited.models.list()  # not limited
    limited.embeddings.create(model=embed_model, input="x")  # uses the one request per minute
    try:
        limited.embeddings.create(model=embed_model, input="x")
    except openai.RateLimitError as e:
        assert e.code == "requests_rate_limit_exceeded", e.code
        assert int(e.response.headers["retry-after"]) >= 1
        return
    raise AssertionError("expected RateLimitError")


def unsupported_media_type():
    req = urllib.request.Request(
        URL + "/chat/completions",
        data=b"hi",
        headers={"authorization": "Bearer " + os.environ["GATEWAY_KEY"], "content-type": "text/plain"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 415, e.code
        import json

        assert json.loads(e.read())["error"]["code"] == "unsupported_media_type"
        return
    raise AssertionError("expected 415")


print(f"openai-python {openai.__version__}")
for name, fn in [
    ("chat", chat),
    ("chat streaming", chat_stream),
    ("chat stream helper", chat_stream_helper),
    ("completions", completions),
    ("completions streaming", completions_stream),
    ("embeddings", embeddings),
    ("embeddings base64 = float", embeddings_base64),
    ("models list and retrieve", models),
    ("400 BadRequestError", bad_request),
    ("401 AuthenticationError", wrong_key),
    ("403 PermissionDeniedError", not_allowed),
    ("404 NotFoundError", unknown_model),
    ("429 RateLimitError with Retry-After", rate_limited),
    ("415 for non-JSON bodies", unsupported_media_type),
]:
    check(name, fn)
sys.exit(1 if failures else 0)
