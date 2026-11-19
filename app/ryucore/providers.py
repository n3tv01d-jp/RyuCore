"""Model providers.

Two wire formats cover everything:
  * "openai"    — OpenAI-compatible /chat/completions: Ollama, vLLM, llama.cpp, LM Studio, OpenAI, xAI Grok,
                  Gemini (OpenAI endpoint), OpenRouter, Groq, Mistral, DeepSeek, any custom server.
  * "anthropic" — the native Anthropic Messages API.

Internal message format (OpenAI-like):
  {"role": "system"|"user"|"assistant"|"tool", "content": str,
   "images": [data_url, ...]            (user only)
   "tool_calls": [{"id", "name", "arguments": dict}]   (assistant only)
   "tool_call_id": str}                 (tool only)

stream_chat() yields events: {"type": "text"|"reasoning", "text"} · {"type": "tool_call", "id", "name", "arguments"}
· {"type": "usage", ...}
"""
import asyncio
import json
import os
import time
import uuid

import httpx

from . import db

PRESETS = {
    # local
    "ollama":     {"name": "Ollama",        "kind": "openai", "base_url": "http://host.docker.internal:11434/v1", "local": 1, "env_url": "RYU_OLLAMA_URL"},
    "vllm":       {"name": "vLLM",          "kind": "openai", "base_url": "http://host.docker.internal:8000/v1",  "local": 1, "env_url": "RYU_VLLM_URL"},
    "llamacpp":   {"name": "llama.cpp",     "kind": "openai", "base_url": "http://host.docker.internal:8080/v1",  "local": 1, "env_url": "RYU_LLAMACPP_URL"},
    "lmstudio":   {"name": "LM Studio",     "kind": "openai", "base_url": "http://host.docker.internal:1234/v1",  "local": 1, "env_url": "RYU_LMSTUDIO_URL"},
    # cloud
    "openai":     {"name": "OpenAI",        "kind": "openai",    "base_url": "https://api.openai.com/v1",            "key_env": "OPENAI_API_KEY"},
    "anthropic":  {"name": "Anthropic",     "kind": "anthropic", "base_url": "https://api.anthropic.com",            "key_env": "ANTHROPIC_API_KEY"},
    "xai":        {"name": "xAI Grok",      "kind": "openai",    "base_url": "https://api.x.ai/v1",                  "key_env": "XAI_API_KEY"},
    "gemini":     {"name": "Google Gemini", "kind": "openai",    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "key_env": "GEMINI_API_KEY"},
    "openrouter": {"name": "OpenRouter",    "kind": "openai",    "base_url": "https://openrouter.ai/api/v1",         "key_env": "OPENROUTER_API_KEY"},
    "groq":       {"name": "Groq",          "kind": "openai",    "base_url": "https://api.groq.com/openai/v1",       "key_env": "GROQ_API_KEY"},
    "mistral":    {"name": "Mistral",       "kind": "openai",    "base_url": "https://api.mistral.ai/v1",            "key_env": "MISTRAL_API_KEY"},
    "deepseek":   {"name": "DeepSeek",      "kind": "openai",    "base_url": "https://api.deepseek.com/v1",          "key_env": "DEEPSEEK_API_KEY"},
    "custom":     {"name": "Custom",        "kind": "openai",    "base_url": "http://host.docker.internal:8000/v1",  "local": 1},
}

TIMEOUT = httpx.Timeout(connect=15.0, read=600.0, write=60.0, pool=15.0)
_client: httpx.AsyncClient | None = None
_models_cache: dict[str, tuple[float, list[str], str]] = {}


class ProviderError(Exception):
    pass


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True)
    return _client


# ───────────── registry ─────────────
def seed_from_env() -> None:
    """Create providers for configured local URLs and cloud keys (only if missing, so UI edits stick)."""
    existing = {p["id"] for p in db.q("SELECT id FROM providers")}
    first_boot = not existing and db.setting("_seeded") is None
    for pid, pre in PRESETS.items():
        if pid in existing or pid == "custom":
            continue
        url = os.environ.get(pre.get("env_url", ""), "").strip() if pre.get("env_url") else ""
        has_key = bool(pre.get("key_env") and os.environ.get(pre["key_env"], "").strip())
        if (pre.get("local") and url) or has_key or (pid == "ollama" and first_boot):
            db.insert("providers", {
                "id": pid, "name": pre["name"], "kind": pre["kind"], "base_url": url or pre["base_url"],
                "api_key": "", "key_env": pre.get("key_env", ""), "models": "", "enabled": 1, "preset": pid,
                "local": pre.get("local", 0), "created": db.now()})
    db.set_setting("_seeded", True)


def resolve_key(p: dict) -> str:
    if p.get("api_key"):
        return p["api_key"]
    if p.get("key_env"):
        return os.environ.get(p["key_env"], "").strip()
    return ""


def public(p: dict) -> dict:
    """Provider row without the secret."""
    key = p.get("api_key") or ""
    env_key = bool(p.get("key_env") and os.environ.get(p["key_env"], "").strip())
    return {**{k: v for k, v in p.items() if k != "api_key"},
            "enabled": bool(p["enabled"]), "local": bool(p["local"]),
            "key_set": bool(key), "key_hint": (key[:3] + "…" + key[-4:]) if len(key) > 10 else ("set" if key else ""),
            "key_from_env": env_key and not key}


def providers(enabled_only=False) -> list[dict]:
    rows = db.q("SELECT * FROM providers ORDER BY local DESC, created")
    return [p for p in rows if p["enabled"]] if enabled_only else rows


def provider(pid: str) -> dict | None:
    return db.one("SELECT * FROM providers WHERE id=?", (pid,))


def split_model(model_id: str) -> tuple[dict, str]:
    pid, sep, name = (model_id or "").partition("::")
    if not sep or not name:
        raise ProviderError(f"No model selected (got {model_id!r}). Pick one in the model selector.")
    p = provider(pid)
    if not p:
        raise ProviderError(f"Provider '{pid}' no longer exists. Pick another model.")
    if not p["enabled"]:
        raise ProviderError(f"Provider '{p['name']}' is disabled.")
    return p, name


def _oa_headers(p: dict) -> dict:
    h = {"Content-Type": "application/json"}
    key = resolve_key(p)
    if key:
        h["Authorization"] = f"Bearer {key}"
    if p.get("preset") == "openrouter":
        h["X-Title"] = "RyuCore"
    return h


def _an_base(p: dict) -> str:
    b = (p["base_url"] or "https://api.anthropic.com").rstrip("/")
    return b[:-3] if b.endswith("/v1") else b


def _an_headers(p: dict) -> dict:
    return {"x-api-key": resolve_key(p), "anthropic-version": "2023-06-01", "content-type": "application/json"}


async def list_models(p: dict, refresh=False) -> tuple[list[str], str]:
    """Return (model names, error). Manual names from the provider config are always included."""
    manual = [m.strip() for m in (p.get("models") or "").split(",") if m.strip()]
    hit = _models_cache.get(p["id"])
    if hit and not refresh and time.time() - hit[0] < 300:
        return sorted(set(hit[1]) | set(manual)), hit[2]
    names, err = [], ""
    try:
        if p["kind"] == "anthropic":
            r = await client().get(f"{_an_base(p)}/v1/models?limit=1000", headers=_an_headers(p), timeout=12)
        else:
            r = await client().get(p["base_url"].rstrip("/") + "/models", headers=_oa_headers(p), timeout=12)
        if r.status_code >= 400:
            err = f"HTTP {r.status_code}: {r.text[:200]}"
        else:
            data = r.json()
            items = data.get("data") if isinstance(data, dict) else data
            if isinstance(data, dict) and items is None:
                items = data.get("models", [])  # Ollama-native shape
            for m in items or []:
                mid = m.get("id") or m.get("name") or m.get("model") if isinstance(m, dict) else str(m)
                if mid:
                    names.append(mid.removeprefix("models/"))
    except (httpx.HTTPError, ValueError) as e:
        err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
    _models_cache[p["id"]] = (time.time(), names, err)
    return sorted(set(names) | set(manual)), err


async def all_models(refresh=False) -> dict:
    ps = providers(enabled_only=True)
    res = await asyncio.gather(*(list_models(p, refresh) for p in ps))
    models, status = [], {}
    for p, (names, err) in zip(ps, res):
        status[p["id"]] = {"count": len(names), "error": err}
        for n in names:
            models.append({"id": f"{p['id']}::{n}", "name": n, "provider": p["id"],
                           "provider_name": p["name"], "local": bool(p["local"])})
    return {"models": models, "status": status}


# ───────────── SSE helper ─────────────
async def iter_sse(resp: httpx.Response):
    """Yield (event, data) tuples from a text/event-stream response."""
    event, data = "", []
    async for line in resp.aiter_lines():
        if line == "":
            if data:
                yield event or "message", "\n".join(data)
            event, data = "", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        yield event or "message", "\n".join(data)


async def _raise_for(r: httpx.Response, who: str):
    if r.status_code >= 400:
        body = (await r.aread()).decode("utf-8", "replace")
        try:
            j = json.loads(body)
            e = j.get("error", j)
            msg = e.get("message") if isinstance(e, dict) else str(e)
        except ValueError:
            msg = body[:400]
        raise ProviderError(f"{who} HTTP {r.status_code}: {msg}")


# ───────────── OpenAI-compatible ─────────────
def _oa_messages(msgs: list[dict]) -> list[dict]:
    out = []
    for m in msgs:
        r = m["role"]
        if r == "tool":
            out.append({"role": "tool", "tool_call_id": m.get("tool_call_id", ""), "content": m.get("content") or ""})
        elif r == "assistant":
            d = {"role": "assistant", "content": m.get("content") or ""}
            if m.get("tool_calls"):
                d["tool_calls"] = [{"id": c["id"], "type": "function",
                                    "function": {"name": c["name"], "arguments": json.dumps(c.get("arguments") or {})}}
                                   for c in m["tool_calls"]]
                if not d["content"]:
                    d["content"] = None
            out.append(d)
        elif r == "user" and m.get("images"):
            parts = [{"type": "text", "text": m.get("content") or ""}]
            parts += [{"type": "image_url", "image_url": {"url": u}} for u in m["images"]]
            out.append({"role": "user", "content": parts})
        else:
            out.append({"role": r, "content": m.get("content") or ""})
    return out


async def _oa_stream(p, name, msgs, tools, temperature):
    body = {"model": name, "messages": _oa_messages(msgs), "stream": True}
    if tools:
        body["tools"] = [{"type": "function", "function": t} for t in tools]
    if temperature is not None:
        body["temperature"] = temperature
    calls: dict[int, dict] = {}
    url = p["base_url"].rstrip("/") + "/chat/completions"
    async with client().stream("POST", url, json=body, headers=_oa_headers(p)) as r:
        await _raise_for(r, p["name"])
        async for _ev, data in iter_sse(r):
            if data.strip() == "[DONE]":
                break
            try:
                j = json.loads(data)
            except ValueError:
                continue
            if j.get("error"):
                e = j["error"]
                raise ProviderError(f"{p['name']}: {e.get('message') if isinstance(e, dict) else e}")
            for ch in j.get("choices") or []:
                d = ch.get("delta") or ch.get("message") or {}
                rc = d.get("reasoning_content") or d.get("reasoning")
                if isinstance(rc, str) and rc:
                    yield {"type": "reasoning", "text": rc}
                if isinstance(d.get("content"), str) and d["content"]:
                    yield {"type": "text", "text": d["content"]}
                for tc in d.get("tool_calls") or []:
                    slot = calls.setdefault(tc.get("index", len(calls)), {"id": "", "name": "", "args": ""})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    f = tc.get("function") or {}
                    if f.get("name") and f["name"] != slot["name"]:
                        slot["name"] += f["name"]
                    a = f.get("arguments")
                    if isinstance(a, dict):
                        slot["args"] = json.dumps(a)
                    elif a:
                        slot["args"] += a
            if j.get("usage"):
                yield {"type": "usage", **j["usage"]}
    for i in sorted(calls):
        c = calls[i]
        try:
            args = json.loads(c["args"]) if c["args"].strip() else {}
        except ValueError:
            args = {"_raw": c["args"]}
        yield {"type": "tool_call", "id": c["id"] or f"call_{uuid.uuid4().hex[:12]}", "name": c["name"],
               "arguments": args if isinstance(args, dict) else {"value": args}}


# ───────────── Anthropic ─────────────
def _data_url(u: str) -> dict:
    head, _, b64 = u.partition(",")
    media = head[5:].split(";")[0] if head.startswith("data:") else "image/png"
    return {"type": "image", "source": {"type": "base64", "media_type": media or "image/png", "data": b64}}


def _an_convert(msgs: list[dict]) -> tuple[str, list[dict]]:
    system = "\n\n".join(m["content"] for m in msgs if m["role"] == "system" and m.get("content"))
    out: list[dict] = []

    def push(role, blocks):
        if not blocks:
            return
        if out and out[-1]["role"] == role:
            out[-1]["content"].extend(blocks)
        else:
            out.append({"role": role, "content": blocks})

    for m in msgs:
        r = m["role"]
        if r == "user":
            blocks = [_data_url(u) for u in m.get("images") or []]
            blocks.append({"type": "text", "text": m.get("content") or "(empty)"})
            push("user", blocks)
        elif r == "assistant":
            blocks = [{"type": "text", "text": m["content"]}] if (m.get("content") or "").strip() else []
            blocks += [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c.get("arguments") or {}}
                       for c in m.get("tool_calls") or []]
            push("assistant", blocks)
        elif r == "tool":
            push("user", [{"type": "tool_result", "tool_use_id": m.get("tool_call_id", ""),
                           "content": m.get("content") or "(no output)"}])
    if out and out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": [{"type": "text", "text": "(conversation start)"}]})
    return system, out


async def _an_stream(p, name, msgs, tools, temperature):
    system, messages = _an_convert(msgs)
    body = {"model": name, "max_tokens": int(db.setting("anthropic_max_tokens") or 8192),
            "messages": messages, "stream": True}
    if system:
        body["system"] = system
    if tools:
        body["tools"] = [{"name": t["name"], "description": t.get("description", ""),
                          "input_schema": t.get("parameters") or {"type": "object", "properties": {}}} for t in tools]
    if temperature is not None:
        body["temperature"] = temperature
    blocks: dict[int, dict] = {}
    async with client().stream("POST", f"{_an_base(p)}/v1/messages", json=body, headers=_an_headers(p)) as r:
        await _raise_for(r, p["name"])
        async for ev, data in iter_sse(r):
            try:
                j = json.loads(data)
            except ValueError:
                continue
            t = j.get("type") or ev
            if t == "content_block_start":
                cb = j.get("content_block") or {}
                blocks[j.get("index", 0)] = {"type": cb.get("type"), "id": cb.get("id"), "name": cb.get("name"), "json": ""}
            elif t == "content_block_delta":
                d = j.get("delta") or {}
                if d.get("type") == "text_delta":
                    yield {"type": "text", "text": d.get("text", "")}
                elif d.get("type") == "thinking_delta":
                    yield {"type": "reasoning", "text": d.get("thinking", "")}
                elif d.get("type") == "input_json_delta":
                    blocks.setdefault(j.get("index", 0), {"type": "tool_use", "json": ""})["json"] += d.get("partial_json", "")
            elif t == "content_block_stop":
                b = blocks.get(j.get("index", 0))
                if b and b.get("type") == "tool_use":
                    try:
                        args = json.loads(b["json"]) if b["json"].strip() else {}
                    except ValueError:
                        args = {"_raw": b["json"]}
                    yield {"type": "tool_call", "id": b["id"], "name": b["name"], "arguments": args}
            elif t == "message_delta" and j.get("usage"):
                yield {"type": "usage", **j["usage"]}
            elif t == "error":
                e = j.get("error") or {}
                raise ProviderError(f"{p['name']}: {e.get('message', e)}")


# ───────────── public API ─────────────
async def stream_chat(model_id: str, msgs: list[dict], tools: list[dict] | None = None, temperature=None):
    p, name = split_model(model_id)
    gen = _an_stream if p["kind"] == "anthropic" else _oa_stream
    try:
        async for ev in gen(p, name, msgs, tools, temperature):
            yield ev
    except httpx.ConnectError as e:
        raise ProviderError(f"Cannot reach {p['name']} at {p['base_url']} ({e}). Is the server running?") from e
    except httpx.TimeoutException as e:
        raise ProviderError(f"{p['name']} timed out.") from e
    except httpx.HTTPError as e:
        raise ProviderError(f"{p['name']}: {type(e).__name__}: {e}") from e


async def complete(model_id: str, msgs: list[dict], temperature=None) -> str:
    """Non-streaming convenience: concatenated text of a streamed reply (reasoning dropped)."""
    out = []
    async for ev in stream_chat(model_id, msgs, None, temperature):
        if ev["type"] == "text":
            out.append(ev["text"])
    return strip_think("".join(out))


def strip_think(s: str) -> str:
    import re
    s = re.sub(r"<think>.*?</think>", "", s, flags=re.S)
    if "<think>" in s:
        s = s.split("<think>")[0]
    return s.strip()


async def embed(model_id: str, texts: list[str]) -> list[list[float]]:
    p, name = split_model(model_id)
    if p["kind"] == "anthropic":
        raise ProviderError("Anthropic has no embeddings endpoint; pick an OpenAI-compatible embedding model.")
    r = await client().post(p["base_url"].rstrip("/") + "/embeddings", json={"model": name, "input": texts},
                            headers=_oa_headers(p), timeout=60)
    if r.status_code >= 400:
        raise ProviderError(f"embeddings HTTP {r.status_code}: {r.text[:200]}")
    data = sorted(r.json().get("data", []), key=lambda d: d.get("index", 0))
    return [d["embedding"] for d in data]
