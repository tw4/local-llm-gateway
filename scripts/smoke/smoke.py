"""Smoke test with the official OpenAI Python SDK.

Run by scripts/smoke/run.ts, which starts the gateway and sets:
  GATEWAY_URL, GATEWAY_KEY, CHAT_MODEL, EMBED_MODEL
Exits non-zero on the first failed check.
"""

import os
import sys

import openai
from openai import OpenAI

client = OpenAI(api_key=os.environ["GATEWAY_KEY"], base_url=os.environ["GATEWAY_URL"] + "/v1", max_retries=0)
chat_model = os.environ["CHAT_MODEL"]
embed_model = os.environ["EMBED_MODEL"]
failures = 0


def check(name, fn):
    global failures
    try:
        fn()
        print(f"  ok    python  {name}")
    except Exception as e:  # noqa: BLE001 - report every failure, keep going
        failures += 1
        print(f"  FAIL  python  {name}: {type(e).__name__}: {e}")


def chat():
    r = client.chat.completions.create(model=chat_model, messages=[{"role": "user", "content": "Say hello"}], max_tokens=64)
    assert r.object == "chat.completion", r.object
    assert r.model == chat_model, r.model
    assert r.choices[0].finish_reason in ("stop", "length"), r.choices[0].finish_reason
    assert r.usage is not None and r.usage.total_tokens > 0, r.usage


def chat_stream():
    stream = client.chat.completions.create(
        model=chat_model,
        messages=[{"role": "user", "content": "Say hello"}],
        max_tokens=64,
        stream=True,
        stream_options={"include_usage": True},
    )
    finish, usage, chunks = None, None, 0
    for c in stream:
        chunks += 1
        if c.choices and c.choices[0].finish_reason:
            finish = c.choices[0].finish_reason
        if c.usage:
            usage = c.usage
    assert chunks >= 2, chunks
    assert finish in ("stop", "length"), finish
    assert usage is not None and usage.total_tokens > 0, usage


def embeddings():
    r = client.embeddings.create(model=embed_model, input=["hello", "world"])
    assert [d.index for d in r.data] == [0, 1]
    assert len(r.data[0].embedding) > 0
    assert all(isinstance(x, float) for x in r.data[0].embedding[:5])


def models():
    ids = [m.id for m in client.models.list().data]
    assert chat_model in ids, ids


def wrong_key():
    bad = OpenAI(api_key="wrong", base_url=os.environ["GATEWAY_URL"] + "/v1", max_retries=0)
    try:
        bad.models.list()
    except openai.AuthenticationError:
        return
    raise AssertionError("expected AuthenticationError")


def unknown_model():
    try:
        client.chat.completions.create(model="no-such-model", messages=[{"role": "user", "content": "x"}])
    except openai.NotFoundError as e:
        assert e.code == "model_not_found", e.code
        return
    raise AssertionError("expected NotFoundError")


print(f"openai-python {openai.__version__}")
check("chat", chat)
check("chat streaming", chat_stream)
check("embeddings", embeddings)
check("models", models)
check("wrong key -> AuthenticationError", wrong_key)
check("unknown model -> NotFoundError", unknown_model)
sys.exit(1 if failures else 0)
