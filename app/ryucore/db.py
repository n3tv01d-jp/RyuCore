"""SQLite storage: one connection, serialised with a lock (all queries are short)."""
import json
import sqlite3
import threading
import time
import uuid

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, base_url TEXT, api_key TEXT DEFAULT '', key_env TEXT DEFAULT '',
  models TEXT DEFAULT '', enabled INTEGER DEFAULT 1, preset TEXT DEFAULT '', local INTEGER DEFAULT 0, created REAL);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, title TEXT, model TEXT, system TEXT DEFAULT '', agent INTEGER DEFAULT 0, brain INTEGER DEFAULT 1,
  council TEXT, temperature REAL, pinned INTEGER DEFAULT 0, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, chat_id TEXT, role TEXT, content TEXT, meta TEXT, created REAL);
CREATE INDEX IF NOT EXISTS ix_msg_chat ON messages(chat_id, seq);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, text TEXT, kind TEXT, source TEXT, pinned INTEGER DEFAULT 0, hits INTEGER DEFAULT 0,
  last_used REAL, embedding TEXT, embed_model TEXT, created REAL, updated REAL);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT, transport TEXT, command TEXT DEFAULT '', args TEXT DEFAULT '[]', env TEXT DEFAULT '{}',
  url TEXT DEFAULT '', headers TEXT DEFAULT '{}', enabled INTEGER DEFAULT 1, created REAL);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
"""

DEFAULTS = {
    "default_model": "",
    "system_prompt": "",
    "brain_autolearn": True,
    "brain_model": "",          # empty = use the chat's model
    "brain_embed_model": "",    # empty = lexical recall
    "brain_recall_k": 6,
    "auto_title": True,
    "tools_disabled": [],
    "skills_disabled": [],
    "councils": [],
    "max_steps": config.MAX_STEPS,
    "history_limit": 80,
    "anthropic_max_tokens": 8192,
    "reasoning_max_chars": 60000,   # stop a reply whose reasoning grows past this with no answer; 0 = no cap
    "reasoning_loop_detect": True,  # stop a reply whose reasoning repeats the same passage over and over
}

_lock = threading.RLock()
_conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, isolation_level=None)
_conn.row_factory = sqlite3.Row
with _lock:
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.executescript(SCHEMA)


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    with _lock:
        r = _conn.execute(sql, args).fetchone()
        return dict(r) if r else None


def run(sql: str, args=()) -> int:
    with _lock:
        return _conn.execute(sql, args).rowcount


def insert(table: str, row: dict) -> None:
    cols = ",".join(row)
    with _lock:
        _conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({','.join('?' * len(row))})", tuple(row.values()))


def update(table: str, key: str, row: dict) -> None:
    if not row:
        return
    sets = ",".join(f"{k}=?" for k in row)
    with _lock:
        _conn.execute(f"UPDATE {table} SET {sets} WHERE id=?", (*row.values(), key))


# ── settings ──
def setting(k: str):
    r = one("SELECT v FROM settings WHERE k=?", (k,))
    if r is None:
        return DEFAULTS.get(k)
    try:
        return json.loads(r["v"])
    except ValueError:
        return DEFAULTS.get(k)


def all_settings() -> dict:
    out = dict(DEFAULTS)
    for r in q("SELECT k, v FROM settings"):
        try:
            out[r["k"]] = json.loads(r["v"])
        except ValueError:
            pass
    return out


def set_setting(k: str, v) -> None:
    run("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))


# ── messages ──
def jload(s, default=None):
    if not s:
        return default
    try:
        return json.loads(s)
    except ValueError:
        return default


def add_message(chat_id: str, role: str, content: str, meta: dict | None = None, mid: str | None = None) -> str:
    mid = mid or new_id()
    insert("messages", {"id": mid, "chat_id": chat_id, "role": role, "content": content or "",
                        "meta": json.dumps(meta or {}), "created": now()})
    run("UPDATE chats SET updated=? WHERE id=?", (now(), chat_id))
    return mid


def messages(chat_id: str) -> list[dict]:
    rows = q("SELECT seq, id, role, content, meta, created FROM messages WHERE chat_id=? ORDER BY seq", (chat_id,))
    for r in rows:
        r["meta"] = jload(r["meta"], {})
    return rows


def chat(chat_id: str) -> dict | None:
    c = one("SELECT * FROM chats WHERE id=?", (chat_id,))
    if c:
        c["council"] = jload(c["council"])
        c["agent"] = bool(c["agent"])
        c["brain"] = bool(c["brain"])
        c["pinned"] = bool(c["pinned"])
    return c
