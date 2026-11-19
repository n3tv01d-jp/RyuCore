"""The brain 記憶: long-term memories about the user.

* recall()  — picks the memories relevant to a message: cosine similarity when an embedding model is configured,
              otherwise an IDF-weighted keyword score. Pinned memories are always recalled.
* learn()   — after a turn, a model reads the exchange and proposes new / updated / obsolete memories.
Sessions with the brain switched off never call either.
"""
import asyncio
import json
import logging
import math
import re
from collections import Counter

from . import bus, db, providers

log = logging.getLogger("ryucore.brain")
KINDS = ["fact", "preference", "project", "person", "instruction", "other"]
STOP = set("""a an and are as at be but by can do for from has have he her his how i if in into is it its just me my
not of on or our she so that the their them then there these they this to too us was we were what when where which who
why will with you your yours about also been being did does doing had having im ive its lets like more most much need
only other over same should some such than very want would could please really thing things""".split())
_learn_lock = asyncio.Lock()


def _tok(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9][a-z0-9_+#.-]*", (s or "").lower()) if len(w) > 2 and w not in STOP]


def _norm(s: str) -> str:
    return " ".join(_tok(s))


def _row(m: dict) -> dict:
    return {k: m[k] for k in ("id", "text", "kind", "source", "hits", "last_used", "created", "updated")} | {
        "pinned": bool(m["pinned"]), "embedded": bool(m.get("embedding"))}


def all_memories(q: str = "", kind: str = "") -> list[dict]:
    sql, args = "SELECT * FROM memories", []
    conds = []
    if q:
        conds.append("text LIKE ?")
        args.append(f"%{q}%")
    if kind:
        conds.append("kind=?")
        args.append(kind)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    return [_row(m) for m in db.q(sql + " ORDER BY pinned DESC, updated DESC", args)]


def stats() -> dict:
    rows = db.q("SELECT kind, COUNT(*) n, SUM(embedding IS NOT NULL AND embedding != '') e, SUM(pinned) p FROM memories GROUP BY kind")
    return {"total": sum(r["n"] for r in rows), "embedded": sum(r["e"] or 0 for r in rows),
            "pinned": sum(r["p"] or 0 for r in rows), "kinds": {r["kind"]: r["n"] for r in rows}}


def _similar(text: str) -> dict | None:
    """An existing memory that says (nearly) the same thing."""
    a = set(_tok(text))
    if not a:
        return None
    best, score = None, 0.0
    for m in db.q("SELECT * FROM memories"):
        b = set(_tok(m["text"]))
        if not b:
            continue
        j = len(a & b) / len(a | b)
        if j > score:
            best, score = m, j
    return best if score >= 0.8 else None


def add(text: str, kind: str = "fact", source: str = "", pinned=False) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("empty memory")
    kind = kind if kind in KINDS else "other"
    dup = _similar(text)
    t = db.now()
    if dup:
        db.update("memories", dup["id"], {"text": text, "updated": t, "embedding": None})
        return _row(db.one("SELECT * FROM memories WHERE id=?", (dup["id"],)))
    mid = db.new_id()
    db.insert("memories", {"id": mid, "text": text[:1000], "kind": kind, "source": source, "pinned": int(pinned),
                           "hits": 0, "last_used": None, "embedding": None, "embed_model": None,
                           "created": t, "updated": t})
    return _row(db.one("SELECT * FROM memories WHERE id=?", (mid,)))


def edit(mid: str, **fields) -> dict | None:
    row = {}
    if "text" in fields and fields["text"] is not None:
        row["text"], row["embedding"] = str(fields["text"]).strip()[:1000], None
    if fields.get("kind") in KINDS:
        row["kind"] = fields["kind"]
    if "pinned" in fields and fields["pinned"] is not None:
        row["pinned"] = int(bool(fields["pinned"]))
    if row:
        row["updated"] = db.now()
        db.update("memories", mid, row)
    m = db.one("SELECT * FROM memories WHERE id=?", (mid,))
    return _row(m) if m else None


def delete(mid: str) -> None:
    db.run("DELETE FROM memories WHERE id=?", (mid,))


def wipe() -> int:
    return db.run("DELETE FROM memories")


# ───────────── recall ─────────────
async def _ensure_embeddings(model: str, rows: list[dict]) -> None:
    todo = [m for m in rows if not m.get("embedding") or m.get("embed_model") != model]
    for i in range(0, len(todo), 64):
        batch = todo[i:i + 64]
        vecs = await providers.embed(model, [m["text"] for m in batch])
        for m, v in zip(batch, vecs):
            m["embedding"], m["embed_model"] = json.dumps(v), model
            db.update("memories", m["id"], {"embedding": m["embedding"], "embed_model": model})


def _cos(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _lexical(query: str, rows: list[dict]) -> list[tuple[float, dict]]:
    qt = set(_tok(query))
    if not qt:
        return []
    docs = [Counter(_tok(m["text"])) for m in rows]
    n = len(docs)
    df = Counter(w for d in docs for w in set(d))
    out = []
    for m, d in zip(rows, docs):
        s = sum(math.log(1 + n / df[w]) for w in qt if w in d)
        # light prefix matching so "docker" hits "dockerfile", "python" hits "python3"
        s += 0.5 * sum(1 for w in qt for t in d if w != t and (t.startswith(w) or w.startswith(t)) and min(len(w), len(t)) > 3)
        if s > 0:
            out.append((s / math.sqrt(1 + len(d)), m))
    return out


async def recall(query: str, k: int | None = None, touch: bool = True) -> list[dict]:
    k = int(k or db.setting("brain_recall_k") or 6)
    rows = db.q("SELECT * FROM memories")
    if not rows:
        return []
    pinned = [m for m in rows if m["pinned"]]
    rest = [m for m in rows if not m["pinned"]]
    scored: list[tuple[float, dict]] = []
    model = db.setting("brain_embed_model") or ""
    if model and rest and query.strip():
        try:
            await _ensure_embeddings(model, rest)
            qv = (await providers.embed(model, [query]))[0]
            scored = [(s, m) for m in rest if (s := _cos(qv, json.loads(m["embedding"]))) >= 0.35]
        except Exception as e:  # noqa: BLE001 — fall back to keywords if the embedding server is down
            log.warning("embedding recall failed, using lexical: %s", e)
            scored = _lexical(query, rest)
    else:
        scored = _lexical(query, rest)
    scored.sort(key=lambda x: -x[0])
    picked = pinned + [m | {"score": round(s, 3)} for s, m in scored[:k]]
    if touch and picked:
        t = db.now()
        for m in picked:
            db.run("UPDATE memories SET hits=hits+1, last_used=? WHERE id=?", (t, m["id"]))
    return [_row(m) | {"score": m.get("score")} for m in picked]


def render(mems: list[dict]) -> str:
    if not mems:
        return ""
    lines = "\n".join(f"- [{m['kind']}] {m['text']}" for m in mems)
    return ("## Memory (what you know about the user from earlier sessions)\n"
            "Use these naturally when relevant. Don't recite them or mention having a memory unless asked. "
            "If the user contradicts one, trust the user.\n" + lines)


# ───────────── learning ─────────────
EXTRACT = """You maintain the long-term memory of an AI assistant about its user.
Read the latest exchange and decide what is worth remembering for FUTURE conversations.

Remember: stable facts about the user (name, job, location, skills, hardware/software setup), preferences
(style, tools, likes/dislikes), ongoing projects and goals, important people, and explicit instructions
("always…", "never…", "remember that…").
Do NOT remember: the task itself, one-off questions, things the assistant said, general knowledge, temporary
states, or secrets (passwords, API keys, tokens, financial or medical identifiers).

Each memory is ONE short self-contained sentence in third person ("The user prefers…").
If an existing memory is now wrong or more specific information arrived, update it instead of adding a new one.
If the user says an existing memory is no longer true, forget it.

Existing related memories:
{existing}

Reply with ONLY a JSON object, no prose:
{{"add": [{{"text": "...", "kind": "fact|preference|project|person|instruction|other"}}],
 "update": [{{"id": "...", "text": "..."}}],
 "forget": ["id", ...]}}
Use empty lists when nothing is worth saving. That is the usual answer."""


def _json_obj(s: str) -> dict:
    s = providers.strip_think(s)
    m = re.search(r"\{.*\}", s, re.S)
    if not m:
        return {}
    try:
        return json.loads(m.group(0))
    except ValueError:
        return {}


async def learn(chat_id: str, model: str, user_text: str, assistant_text: str) -> None:
    if not db.setting("brain_autolearn") or not user_text.strip():
        return
    model = db.setting("brain_model") or model
    if not model:
        return
    async with _learn_lock:
        try:
            related = await recall(user_text, 12, touch=False)
            existing = "\n".join(f"- id={m['id']} [{m['kind']}] {m['text']}" for m in related) or "(none)"
            msgs = [{"role": "system", "content": EXTRACT.format(existing=existing)},
                    {"role": "user", "content": f"USER:\n{user_text[:6000]}\n\nASSISTANT:\n{assistant_text[:3000]}"}]
            plan = _json_obj(await providers.complete(model, msgs))
        except Exception as e:  # noqa: BLE001
            log.warning("brain learn failed: %s", e)
            bus.publish({"type": "brain_error", "error": str(e)[:300]})
            return
        changes = []
        known = {m["id"] for m in related}
        for a in (plan.get("add") or [])[:6]:
            if isinstance(a, dict) and str(a.get("text", "")).strip():
                m = add(a["text"], a.get("kind", "fact"), source=chat_id)
                changes.append({"op": "add", "id": m["id"], "text": m["text"], "kind": m["kind"]})
        for u in (plan.get("update") or [])[:6]:
            if isinstance(u, dict) and u.get("id") in known and str(u.get("text", "")).strip():
                m = edit(u["id"], text=u["text"])
                if m:
                    changes.append({"op": "update", "id": m["id"], "text": m["text"], "kind": m["kind"]})
        for fid in (plan.get("forget") or [])[:6]:
            if fid in known:
                old = db.one("SELECT text FROM memories WHERE id=?", (fid,))
                delete(fid)
                changes.append({"op": "forget", "id": fid, "text": old["text"] if old else ""})
        if changes:
            bus.publish({"type": "brain_learned", "chat_id": chat_id, "changes": changes})
