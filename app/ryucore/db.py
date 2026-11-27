"""SQLite storage: one connection per realm, serialised with a lock (all queries are short).

RyuCore and Companion keep separate databases (chats, messages, memories, settings). Model providers,
MCP servers and the theme forge are machine set-up rather than saved data, so both realms share the
RyuCore copy of those.
"""
import json
import re
import sqlite3
import threading
import time
import uuid

from . import config, realm

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
    # guard 防壁: prompt-injection safety net for web content (off | standard | strict) and an optional checker model
    "web_guard": "standard",
    "web_guard_model": "",
    # deep research 調査
    "research_model": "",       # empty = the session's model
    "research_parallel": 3,     # pages read at the same time
    "research_depths": {},      # overrides of research.DEPTHS, e.g. {"deep": {"rounds": 8}}
    # theme forge 配色工房: the user's own themes
    "custom_themes": [],
    # companion 伴侶 profile (only used in the Companion realm)
    "companion_name": "",
    "companion_avatar": "",     # data: URL of a small square image
    "companion_persona": "",
}
SHARED_SETTINGS = {"custom_themes"}
SHARED_TABLES = re.compile(r"\b(providers|mcp_servers)\b", re.I)

_lock = threading.RLock()


def _open(path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    # migrations: columns added after the first release
    cols = {r[1] for r in conn.execute("PRAGMA table_info(chats)").fetchall()}
    if "research" not in cols:
        conn.execute("ALTER TABLE chats ADD COLUMN research TEXT DEFAULT ''")
    return conn


with _lock:
    _conn = _open(config.DB_PATH)
    _fresh = not config.COMPANION_DB.exists()
    _comp = _open(config.COMPANION_DB)
    if _fresh:  # start the companion on the same default model as RyuCore
        _r = _conn.execute("SELECT v FROM settings WHERE k='default_model'").fetchone()
        if _r:
            _comp.execute("INSERT OR IGNORE INTO settings (k, v) VALUES ('default_model', ?)", (_r[0],))


def _c(sql_or_table: str = "") -> sqlite3.Connection:
    """The connection for this request's realm; shared tables always live in the RyuCore database."""
    if not realm.is_companion() or SHARED_TABLES.search(sql_or_table):
        return _conn
    return _comp


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _c(sql).execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    with _lock:
        r = _c(sql).execute(sql, args).fetchone()
        return dict(r) if r else None


def run(sql: str, args=()) -> int:
    with _lock:
        return _c(sql).execute(sql, args).rowcount


def insert(table: str, row: dict) -> None:
    cols = ",".join(row)
    with _lock:
        _c(table).execute(f"INSERT INTO {table} ({cols}) VALUES ({','.join('?' * len(row))})", tuple(row.values()))


def update(table: str, key: str, row: dict) -> None:
    if not row:
        return
    sets = ",".join(f"{k}=?" for k in row)
    with _lock:
        _c(table).execute(f"UPDATE {table} SET {sets} WHERE id=?", (*row.values(), key))


# ── settings ──
def _sconn(k: str) -> sqlite3.Connection:
    return _conn if k in SHARED_SETTINGS else _c()


def setting(k: str):
    with _lock:
        r = _sconn(k).execute("SELECT v FROM settings WHERE k=?", (k,)).fetchone()
    if r is None:
        return DEFAULTS.get(k)
    try:
        return json.loads(r["v"])
    except ValueError:
        return DEFAULTS.get(k)


def all_settings() -> dict:
    out = dict(DEFAULTS)
    with _lock:
        rows = [(r[0], r[1]) for r in _c().execute("SELECT k, v FROM settings").fetchall() if r[0] not in SHARED_SETTINGS]
        rows += [(r[0], r[1]) for r in _conn.execute("SELECT k, v FROM settings").fetchall() if r[0] in SHARED_SETTINGS]
    for k, v in rows:
        try:
            out[k] = json.loads(v)
        except ValueError:
            pass
    return out


def set_setting(k: str, v) -> None:
    with _lock:
        _sconn(k).execute("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))


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
