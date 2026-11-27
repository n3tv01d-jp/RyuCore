"""RyuCore HTTP API + static UI."""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import re

from . import agent, brain, bus, config, db, hearth, providers, research, skills, tools
from .mcp import manager as mcp

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ryucore")
STATIC = Path(__file__).resolve().parent.parent / "static"
COOKIE = "ryu_session"


# ───────────── auth ─────────────
def _secret() -> bytes:
    if config.SECRET:
        return config.SECRET.encode()
    f = config.DATA / ".secret"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
        f.chmod(0o600)
    return f.read_text().strip().encode()


SECRET = _secret()


def _token() -> str:
    return hmac.new(SECRET, b"ryucore:" + hashlib.sha256(config.PASSWORD.encode()).digest(), hashlib.sha256).hexdigest()


def _authed(req: Request) -> bool:
    return not config.PASSWORD or hmac.compare_digest(req.cookies.get(COOKIE, ""), _token())


@asynccontextmanager
async def lifespan(_app):
    providers.seed_from_env()
    skills.seed()
    hearth.seed_mcp()
    asyncio.create_task(mcp.start_all())
    log.info("RyuCore %s up — data in %s, login %s, shell %s", config.VERSION, config.DATA,
             "on" if config.PASSWORD else "OFF", "on" if config.ALLOW_SHELL else "off")
    yield
    await mcp.stop_all()


app = FastAPI(title="RyuCore", version=config.VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
OPEN = {"/login.html", "/api/login", "/healthz", "/style.css", "/favicon.svg", "/ui.js", "/fx.js"}


@app.middleware("http")
async def guard(req: Request, call_next):
    path = req.url.path
    if not _authed(req) and path not in OPEN:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "login required"}, status_code=401)
        return Response(status_code=303, headers={"Location": "login.html"})
    # browsers never send custom headers cross-site without CORS, so this blocks CSRF
    if req.method not in ("GET", "HEAD", "OPTIONS") and req.headers.get("x-ryu") != "1":
        return JSONResponse({"detail": "missing X-Ryu header"}, status_code=403)
    return await call_next(req)


@app.post("/api/login")
async def login(req: Request):
    body = await req.json()
    if not config.PASSWORD:
        return {"ok": True}
    if not hmac.compare_digest(str(body.get("password", "")), config.PASSWORD):
        await asyncio.sleep(1.0)
        raise HTTPException(401, "wrong password")
    r = JSONResponse({"ok": True})
    r.set_cookie(COOKIE, _token(), max_age=60 * 60 * 24 * 60, httponly=True, samesite="strict",
                 secure=req.url.scheme == "https")
    return r


@app.post("/api/logout")
async def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie(COOKIE)
    return r


@app.get("/healthz")
async def healthz():
    return PlainTextResponse("ok")


@app.get("/api/info")
async def info():
    return {"version": config.VERSION, "auth": bool(config.PASSWORD), "shell": config.ALLOW_SHELL,
            "research_depths": {k: research.depth_cfg(k) for k in research.DEPTHS},
            "searxng": bool(config.SEARXNG_URL), "data": str(config.DATA), "workspace": str(config.WORKSPACE),
            "hearth": config.HEARTH_URL or None}


# ───────────── HEARTH link 炉心 ─────────────
@app.get("/api/hearth/theme")
async def hearth_theme(fresh: int = 0):
    data = await hearth.theme(bool(fresh))
    if data is None:
        raise HTTPException(404 if not hearth.enabled() else 502,
                            "no HEARTH hub linked (RYU_HEARTH_URL)" if not hearth.enabled() else "HEARTH hub unreachable")
    return data


@app.post("/api/hearth/theme")
async def hearth_theme_set(req: Request):
    if not hearth.enabled():
        raise HTTPException(404, "no HEARTH hub linked (RYU_HEARTH_URL)")
    b = await req.json()
    try:
        return await hearth.set_theme(str(b.get("theme") or "")[:32])
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"HEARTH hub unreachable: {e}") from None


# ───────────── tool approvals ─────────────
@app.post("/api/approve/{cid}/{call_id}")
async def approve_tool(cid: str, call_id: str, req: Request):
    b = await req.json()
    if not agent.approve(cid, call_id, bool(b.get("ok"))):
        raise HTTPException(404, "nothing is waiting for that approval (it may have timed out)")
    return {"ok": True}


@app.get("/api/events")
async def events(req: Request):
    qu = bus.subscribe()

    async def gen():
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(qu.get(), 20)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                if await req.is_disconnected():
                    break
        finally:
            bus.unsubscribe(qu)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache",
                                                                             "X-Accel-Buffering": "no"})


# ───────────── settings ─────────────
@app.get("/api/settings")
async def get_settings():
    return {k: v for k, v in db.all_settings().items() if not k.startswith("_")}


@app.put("/api/settings")
async def put_settings(req: Request):
    body = await req.json()
    for k, v in body.items():
        if k == "custom_themes":
            v = _clean_themes(v)
        elif k == "web_guard" and v not in ("off", "standard", "strict"):
            raise HTTPException(400, "web_guard must be off, standard or strict")
        if k in db.DEFAULTS:
            db.set_setting(k, v)
    return await get_settings()


HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
THEME_COLOURS = ("a1", "a2", "a3", "bg", "bg2", "surface", "panel", "text", "dim", "faint")
FX = ("embers", "radar", "grid", "petals", "stars", "rain", "bubbles", "dust", "fog", "plexus", "waves", "none")


def _clean_themes(v) -> list[dict]:
    """Custom themes are rendered into styles in every browser: keep only well-formed values."""
    if not isinstance(v, list):
        raise HTTPException(400, "custom_themes must be a list")
    out, ids = [], set()
    for t in v[:60]:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("id") or "")
        if not re.fullmatch(r"x-[a-z0-9-]{1,40}", tid) or tid in ids:
            raise HTTPException(400, f"bad theme id {tid!r}")
        ids.add(tid)
        th = {"id": tid, "name": str(t.get("name") or "CUSTOM")[:24], "jp": str(t.get("jp") or "")[:12]}
        for c in THEME_COLOURS:
            if not HEX.match(str(t.get(c) or "")):
                raise HTTPException(400, f"theme {th['name']}: {c} must be a #rrggbb colour")
            th[c] = str(t[c]).lower()
        th["fx"] = t.get("fx") if t.get("fx") in FX else "plexus"
        for k, lo, hi, d in (("density", 0.2, 3.0, 1.0), ("speed", 0.2, 3.0, 1.0), ("glow", 0.0, 2.0, 1.0)):
            try:
                th[k] = round(max(lo, min(hi, float(t.get(k, d)))), 2)
            except (TypeError, ValueError):
                th[k] = d
        out.append(th)
    return out


# ───────────── providers & models ─────────────
@app.get("/api/presets")
async def presets():
    return [{"id": k, **{x: v[x] for x in ("name", "kind", "base_url")}, "local": bool(v.get("local")),
             "key_env": v.get("key_env", "")} for k, v in providers.PRESETS.items()]


@app.get("/api/providers")
async def list_providers():
    return [providers.public(p) for p in providers.providers()]


@app.post("/api/providers")
async def save_provider(req: Request):
    b = await req.json()
    pid = b.get("id") or ""
    row = {k: b[k] for k in ("name", "kind", "base_url", "models", "key_env") if k in b}
    if "enabled" in b:
        row["enabled"] = int(bool(b["enabled"]))
    if "local" in b:
        row["local"] = int(bool(b["local"]))
    if b.get("api_key") is not None and b.get("api_key") != "":
        row["api_key"] = str(b["api_key"]).strip()
    if b.get("clear_key"):
        row["api_key"] = ""
    if row.get("kind") not in (None, "openai", "anthropic"):
        raise HTTPException(400, "kind must be openai or anthropic")
    if pid and providers.provider(pid):
        db.update("providers", pid, row)
    else:
        pre = providers.PRESETS.get(b.get("preset") or "", {})
        pid = skills.slugify(b.get("id") or b.get("preset") or b.get("name") or "provider")
        base_pid, n = pid, 2
        while providers.provider(pid):
            pid, n = f"{base_pid}-{n}", n + 1
        db.insert("providers", {"id": pid, "name": row.get("name") or pre.get("name", pid), "kind": row.get("kind") or pre.get("kind", "openai"),
                                "base_url": row.get("base_url") or pre.get("base_url", ""), "api_key": row.get("api_key", ""),
                                "key_env": row.get("key_env", pre.get("key_env", "")), "models": row.get("models", ""),
                                "enabled": row.get("enabled", 1), "preset": b.get("preset", ""),
                                "local": row.get("local", int(bool(pre.get("local")))), "created": db.now()})
    providers._models_cache.pop(pid, None)
    return providers.public(providers.provider(pid))


@app.delete("/api/providers/{pid}")
async def delete_provider(pid: str):
    db.run("DELETE FROM providers WHERE id=?", (pid,))
    providers._models_cache.pop(pid, None)
    return {"ok": True}


@app.post("/api/providers/{pid}/test")
async def test_provider(pid: str):
    p = providers.provider(pid)
    if not p:
        raise HTTPException(404)
    t = time.time()
    names, err = await providers.list_models(p, refresh=True)
    return {"ok": not err, "error": err, "models": names, "ms": round((time.time() - t) * 1000)}


@app.get("/api/models")
async def models(refresh: int = 0):
    return await providers.all_models(bool(refresh))


# ───────────── chats ─────────────
@app.get("/api/chats")
async def list_chats(q: str = ""):
    sql = "SELECT id, title, model, agent, brain, council IS NOT NULL AND council != 'null' AS council, research, pinned, created, updated FROM chats"
    args: tuple = ()
    if q:
        sql += " WHERE title LIKE ? OR id IN (SELECT chat_id FROM messages WHERE content LIKE ?)"
        args = (f"%{q}%", f"%{q}%")
    rows = db.q(sql + " ORDER BY pinned DESC, updated DESC LIMIT 500", args)
    for r in rows:
        r["agent"], r["brain"], r["council"], r["pinned"] = bool(r["agent"]), bool(r["brain"]), bool(r["council"]), bool(r["pinned"])
    return rows


CHAT_FIELDS = ("title", "model", "system", "agent", "brain", "council", "temperature", "pinned", "research")


def _chat_row(b: dict) -> dict:
    row = {}
    for k in CHAT_FIELDS:
        if k not in b:
            continue
        v = b[k]
        if k in ("agent", "brain", "pinned"):
            v = int(bool(v))
        elif k == "council":
            v = json.dumps(v) if v else None
        elif k == "research":
            v = v if v in research.DEPTHS else ""
        elif k == "temperature":
            v = None if v in (None, "") else max(0.0, min(2.0, float(v)))
        row[k] = v
    return row


@app.post("/api/chats")
async def create_chat(req: Request):
    b = await req.json()
    cid = db.new_id()
    row = {"title": "New session", "model": db.setting("default_model") or "", "system": "", "agent": 0, "brain": 1,
           "council": None, "temperature": None, "pinned": 0, "research": ""} | _chat_row(b)
    db.insert("chats", {"id": cid, **row, "created": db.now(), "updated": db.now()})
    return db.chat(cid)


@app.get("/api/chats/{cid}")
async def get_chat(cid: str):
    c = db.chat(cid)
    if not c:
        raise HTTPException(404, "no such chat")
    return {"chat": c, "messages": db.messages(cid)}


@app.patch("/api/chats/{cid}")
async def patch_chat(cid: str, req: Request):
    if not db.chat(cid):
        raise HTTPException(404)
    db.update("chats", cid, _chat_row(await req.json()))
    return db.chat(cid)


@app.delete("/api/chats/{cid}")
async def delete_chat(cid: str):
    db.run("DELETE FROM messages WHERE chat_id=?", (cid,))
    db.run("DELETE FROM chats WHERE id=?", (cid,))
    return {"ok": True}


@app.post("/api/chats/{cid}/send")
async def send(cid: str, req: Request):
    """Add a user message (or regenerate) and stream the reply as server-sent events."""
    c = db.chat(cid)
    if not c:
        raise HTTPException(404, "no such chat")
    b = await req.json()
    needs_model = c.get("research") or not c["council"]
    if needs_model and not agent.chat_model(c) and not (c.get("research") and db.setting("research_model")):
        raise HTTPException(400, "Pick a model first (MODELS tab → add a provider).")
    mode = b.get("mode", "new")
    if mode == "regenerate":
        rows = db.messages(cid)
        lu = next((r for r in reversed(rows) if r["role"] == "user"), None)
        if not lu:
            raise HTTPException(400, "nothing to regenerate")
        db.run("DELETE FROM messages WHERE chat_id=? AND seq>?", (cid, lu["seq"]))
        skill_names = (lu["meta"] or {}).get("skills") or []
    else:
        content = str(b.get("content", ""))
        images = [u for u in b.get("images") or [] if isinstance(u, str) and u.startswith("data:image/")][:8]
        if not content.strip() and not images:
            raise HTTPException(400, "empty message")
        skill_names = [s for s in b.get("skills") or [] if isinstance(s, str)][:8]
        meta = {k: v for k, v in (("images", images), ("skills", skill_names), ("files", b.get("files") or [])) if v}
        db.add_message(cid, "user", content, meta)
    async def gen():
        runner = research.run if c.get("research") else agent.run_council if c["council"] else agent.run
        try:
            async for ev in runner(c, skill_names):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            log.exception("turn failed")
            yield f"data: {json.dumps({'type': 'error', 'error': f'{type(e).__name__}: {e}'})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache",
                                                                             "X-Accel-Buffering": "no"})


@app.put("/api/messages/{mid}")
async def edit_message(mid: str, req: Request):
    """Edit a user message; everything after it is discarded (the client then regenerates)."""
    m = db.one("SELECT * FROM messages WHERE id=?", (mid,))
    if not m or m["role"] != "user":
        raise HTTPException(400, "only user messages can be edited")
    b = await req.json()
    db.run("UPDATE messages SET content=? WHERE id=?", (str(b.get("content", "")), mid))
    db.run("DELETE FROM messages WHERE chat_id=? AND seq>?", (m["chat_id"], m["seq"]))
    return {"ok": True}


@app.get("/api/chats/{cid}/export")
async def export_chat(cid: str, fmt: str = "md"):
    c = db.chat(cid)
    if not c:
        raise HTTPException(404)
    msgs = db.messages(cid)
    if fmt == "json":
        return JSONResponse({"chat": c, "messages": msgs}, headers={"Content-Disposition": f'attachment; filename="ryucore-{cid}.json"'})
    out = [f"# {c['title']}\n"]
    for m in msgs:
        if m["role"] == "user":
            out.append(f"## You\n\n{m['content']}\n")
        elif m["role"] == "assistant" and (m["content"] or "").strip():
            out.append(f"## {m['meta'].get('model', 'assistant')}\n\n{providers.strip_think(m['content'])}\n")
        elif m["role"] == "tool":
            out.append(f"> tool `{m['meta'].get('name')}` → {len(m['content'])} chars\n")
    return PlainTextResponse("\n".join(out), headers={"Content-Disposition": f'attachment; filename="ryucore-{cid}.md"'})


# ───────────── brain ─────────────
@app.get("/api/brain")
async def brain_list(q: str = "", kind: str = ""):
    return {"memories": brain.all_memories(q, kind), "stats": brain.stats(), "kinds": brain.KINDS}


@app.post("/api/brain")
async def brain_add(req: Request):
    b = await req.json()
    try:
        return brain.add(b.get("text", ""), b.get("kind", "fact"), source="manual", pinned=bool(b.get("pinned")))
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.patch("/api/brain/{mid}")
async def brain_edit(mid: str, req: Request):
    b = await req.json()
    m = brain.edit(mid, text=b.get("text"), kind=b.get("kind"), pinned=b.get("pinned"))
    if not m:
        raise HTTPException(404)
    return m


@app.delete("/api/brain/{mid}")
async def brain_del(mid: str):
    brain.delete(mid)
    return {"ok": True}


@app.post("/api/brain/wipe")
async def brain_wipe():
    return {"deleted": brain.wipe()}


@app.post("/api/brain/recall")
async def brain_recall(req: Request):
    b = await req.json()
    return {"memories": await brain.recall(str(b.get("q", "")), int(b.get("k") or 0) or None, touch=False)}


@app.post("/api/brain/reembed")
async def brain_reembed():
    db.run("UPDATE memories SET embedding=NULL, embed_model=NULL")
    model = db.setting("brain_embed_model")
    if not model:
        return {"ok": True, "embedded": 0}
    try:
        rows = db.q("SELECT * FROM memories")
        await brain._ensure_embeddings(model, rows)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e)) from e
    return {"ok": True, "embedded": len(rows)}


@app.get("/api/brain/export")
async def brain_export():
    rows = db.q("SELECT id, text, kind, source, pinned, hits, created, updated FROM memories ORDER BY created")
    return JSONResponse({"ryucore_brain": 1, "memories": rows},
                        headers={"Content-Disposition": 'attachment; filename="ryucore-brain.json"'})


@app.post("/api/brain/import")
async def brain_import(req: Request):
    b = await req.json()
    items = b.get("memories") if isinstance(b, dict) else b
    n = 0
    for m in items or []:
        text = m.get("text") if isinstance(m, dict) else str(m)
        if text and str(text).strip():
            brain.add(str(text), m.get("kind", "fact") if isinstance(m, dict) else "fact", source="import",
                      pinned=bool(m.get("pinned")) if isinstance(m, dict) else False)
            n += 1
    return {"imported": n}


# ───────────── skills ─────────────
@app.get("/api/skills")
async def skills_list():
    return skills.list_skills()


@app.get("/api/skills/{slug}")
async def skills_get(slug: str):
    s = skills.get(slug)
    if not s:
        raise HTTPException(404)
    return s


@app.put("/api/skills/{slug}")
async def skills_put(slug: str, req: Request):
    b = await req.json()
    content = str(b.get("content", ""))
    if not content.strip():
        raise HTTPException(400, "empty skill")
    new = skills.save(slug if slug != "_new" else "", content)
    if b.get("rename_from") and b["rename_from"] != new:
        skills.delete(b["rename_from"])
    return skills.get(new)


@app.delete("/api/skills/{slug}")
async def skills_del(slug: str):
    skills.delete(slug)
    return {"ok": True}


@app.post("/api/skills/{slug}/enabled")
async def skills_toggle(slug: str, req: Request):
    skills.set_enabled(slug, bool((await req.json()).get("enabled")))
    return {"ok": True}


@app.post("/api/skills-import")
async def skills_import(req: Request):
    b = await req.json()
    try:
        data = base64.b64decode(b.get("data", ""))
        return {"imported": skills.import_archive(str(b.get("filename", "skill.md")), data)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"import failed: {e}") from e


# ───────────── tools & MCP ─────────────
@app.get("/api/tools")
async def tools_list():
    return {"builtin": tools.catalog(), "shell": config.ALLOW_SHELL}


def _mcp_out(r: dict) -> dict:
    env = db.jload(r["env"], {}) or {}
    headers = db.jload(r["headers"], {}) or {}
    return {**r, "enabled": bool(r["enabled"]), "args": db.jload(r["args"], []),
            # values may be secrets: show keys only
            "env": {k: "••••" for k in env}, "headers": {k: "••••" for k in headers}, **mcp.status(r["id"])}


@app.get("/api/mcp")
async def mcp_list():
    return [_mcp_out(r) for r in mcp.rows()]


def _mcp_row(b: dict, old: dict | None) -> dict:
    row = {}
    for k in ("name", "transport", "command", "url"):
        if k in b:
            row[k] = str(b[k] or "").strip()
    if "args" in b:
        a = b["args"]
        row["args"] = json.dumps(a if isinstance(a, list) else [x for x in str(a).split("\n") if x.strip()])
    for k in ("env", "headers"):
        if k in b and isinstance(b[k], dict):
            prev = db.jload(old[k], {}) if old else {}
            row[k] = json.dumps({kk: (prev.get(kk, "") if vv == "••••" else vv) for kk, vv in b[k].items() if kk})
    if "enabled" in b:
        row["enabled"] = int(bool(b["enabled"]))
    if row.get("transport") not in (None, "stdio", "http", "sse"):
        raise HTTPException(400, "transport must be stdio, http or sse")
    return row


@app.post("/api/mcp")
async def mcp_save(req: Request):
    b = await req.json()
    sid = b.get("id")
    old = db.one("SELECT * FROM mcp_servers WHERE id=?", (sid,)) if sid else None
    row = _mcp_row(b, old)
    if old:
        db.update("mcp_servers", sid, row)
    else:
        sid = db.new_id()
        db.insert("mcp_servers", {"id": sid, "name": row.get("name") or "server", "transport": row.get("transport", "stdio"),
                                  "command": row.get("command", ""), "args": row.get("args", "[]"), "env": row.get("env", "{}"),
                                  "url": row.get("url", ""), "headers": row.get("headers", "{}"),
                                  "enabled": row.get("enabled", 1), "created": db.now()})
    asyncio.create_task(mcp.restart(sid))
    return _mcp_out(db.one("SELECT * FROM mcp_servers WHERE id=?", (sid,)))


@app.post("/api/mcp/import")
async def mcp_import(req: Request):
    """Import Claude Desktop / Cursor style JSON: {"mcpServers": {"name": {"command", "args", "env"} | {"url"}}}."""
    b = await req.json()
    servers = b.get("mcpServers") or b.get("servers") or b
    if not isinstance(servers, dict):
        raise HTTPException(400, "expected an mcpServers object")
    made = []
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url") or cfg.get("serverUrl") or ""
        transport = "stdio" if cfg.get("command") else ("sse" if cfg.get("type") == "sse" or url.rstrip("/").endswith("/sse") else "http")
        sid = db.new_id()
        db.insert("mcp_servers", {"id": sid, "name": name, "transport": transport, "command": cfg.get("command", ""),
                                  "args": json.dumps(cfg.get("args") or []), "env": json.dumps(cfg.get("env") or {}),
                                  "url": url, "headers": json.dumps(cfg.get("headers") or {}),
                                  "enabled": 0 if cfg.get("disabled") else 1, "created": db.now()})
        made.append(sid)
        asyncio.create_task(mcp.restart(sid))
    return {"imported": len(made)}


@app.post("/api/mcp/{sid}/restart")
async def mcp_restart(sid: str):
    await mcp.restart(sid)
    return _mcp_out(db.one("SELECT * FROM mcp_servers WHERE id=?", (sid,)))


@app.get("/api/mcp/{sid}/log")
async def mcp_log(sid: str):
    c = mcp.clients.get(sid)
    return {"log": list(c.log) if c else []}


@app.delete("/api/mcp/{sid}")
async def mcp_delete(sid: str):
    await mcp.stop(sid)
    db.run("DELETE FROM mcp_servers WHERE id=?", (sid,))
    return {"ok": True}


# ───────────── static ─────────────
@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
