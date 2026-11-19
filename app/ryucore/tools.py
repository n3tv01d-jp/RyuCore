"""Built-in agent tools. MCP tools are added on top by the agent loop."""
import ast
import asyncio
import datetime as dt
import html
import json
import math
import operator
import re
import sys
from html.parser import HTMLParser
from urllib.parse import unquote

import httpx

from . import brain, config, db, skills
from .mcp import manager as mcp

MAX_OUT = 16000
WS = config.WORKSPACE


def _clip(s: str, n: int = MAX_OUT) -> str:
    return s if len(s) <= n else s[:n] + f"\n…(truncated, {len(s) - n} more chars)"


# ── web ──
class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "form"}

    def __init__(self):
        super().__init__()
        self.out, self._skip, self.title = [], 0, ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag in ("p", "br", "div", "li", "h1", "h2", "h3", "h4", "tr", "section", "article"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.out.append(data)


def html_to_text(s: str) -> tuple[str, str]:
    p = _Text()
    p.feed(s)
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(p.out))
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return p.title.strip(), text.strip()


UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) RyuCore/1.0"}


async def fetch_url(args, ctx):
    url = str(args.get("url", "")).strip()
    if not re.match(r"^https?://", url):
        return "ERROR: url must start with http:// or https://"
    async with httpx.AsyncClient(timeout=25, follow_redirects=True, headers=UA) as c:
        r = await c.get(url)
    ctype = r.headers.get("content-type", "")
    body = r.content[:3_000_000].decode(r.encoding or "utf-8", "replace")
    if "html" in ctype or body.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        title, body = html_to_text(body)
        body = f"# {title}\n\n{body}" if title else body
    return _clip(f"[{r.status_code}] {r.url}\n\n{body}", int(args.get("max_chars") or MAX_OUT))


async def web_search(args, ctx):
    q = str(args.get("query", "")).strip()
    n = min(int(args.get("count") or 8), 15)
    if not q:
        return "ERROR: empty query"
    async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=UA) as c:
        if config.SEARXNG_URL:
            r = await c.get(f"{config.SEARXNG_URL}/search", params={"q": q, "format": "json"})
            res = r.json().get("results", [])[:n]
            items = [(x.get("title", ""), x.get("url", ""), x.get("content", "")) for x in res]
        else:
            r = await c.post("https://html.duckduckgo.com/html/", data={"q": q})
            items = []
            for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)',
                                 r.text, re.S):
                href, title, rest = m.groups()
                um = re.search(r"uddg=([^&]+)", href)
                href = unquote(um.group(1)) if um else href
                sm = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', rest, re.S)
                strip = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()  # noqa: E731
                items.append((strip(title), href, strip(sm.group(1) if sm else "")))
                if len(items) >= n:
                    break
    if not items:
        return f"No results for {q!r}."
    return "\n\n".join(f"{i}. {t}\n   {u}\n   {s}" for i, (t, u, s) in enumerate(items, 1))


# ── maths & time ──
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
        ast.USub: operator.neg, ast.UAdd: operator.pos}
_FN = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")} | {"abs": abs, "round": round, "min": min, "max": max}


def _eval(n):
    if isinstance(n, ast.Expression):
        return _eval(n.body)
    if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
        return n.value
    if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
        a, b = _eval(n.left), _eval(n.right)
        if isinstance(n.op, ast.Pow) and abs(b) > 1000:
            raise ValueError("exponent too large")
        return _OPS[type(n.op)](a, b)
    if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
        return _OPS[type(n.op)](_eval(n.operand))
    if isinstance(n, ast.Name) and n.id in _FN and not callable(_FN[n.id]):
        return _FN[n.id]
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FN:
        return _FN[n.func.id](*[_eval(a) for a in n.args])
    raise ValueError("unsupported expression")


async def calculator(args, ctx):
    expr = str(args.get("expression", "")).replace("^", "**")
    try:
        return str(_eval(ast.parse(expr, mode="eval")))
    except Exception as e:  # noqa: BLE001
        return f"ERROR: {e}"


async def current_datetime(args, ctx):
    now = dt.datetime.now().astimezone()
    return now.strftime("%A %Y-%m-%d %H:%M:%S %Z (UTC%z)")


# ── workspace files ──
def _ws(path: str):
    p = (WS / (path or ".").lstrip("/")).resolve()
    if not p.is_relative_to(WS.resolve()):
        raise PermissionError("path escapes the workspace")
    return p


async def list_files(args, ctx):
    p = _ws(args.get("path", "."))
    if not p.exists():
        return "ERROR: no such directory"
    out = []
    for f in sorted(p.rglob("*") if args.get("recursive") else p.iterdir())[:500]:
        rel = f.relative_to(WS.resolve())
        out.append(f"{rel}/" if f.is_dir() else f"{rel}  ({f.stat().st_size} B)")
    return "\n".join(out) or "(empty)"


async def read_file(args, ctx):
    p = _ws(args.get("path", ""))
    if not p.is_file():
        return "ERROR: no such file"
    return _clip(p.read_bytes()[:2_000_000].decode("utf-8", "replace"))


async def write_file(args, ctx):
    p = _ws(args.get("path", ""))
    p.parent.mkdir(parents=True, exist_ok=True)
    content = str(args.get("content", ""))
    if args.get("append"):
        with p.open("a", encoding="utf-8") as f:
            f.write(content)
    else:
        p.write_text(content, "utf-8")
    return f"wrote {len(content)} chars to {p.relative_to(WS.resolve())}"


async def _proc(*cmd, shell=False, timeout=60):
    if shell:
        proc = await asyncio.create_subprocess_shell(cmd[0], cwd=str(WS), stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.STDOUT)
    else:
        proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(WS), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return f"ERROR: timed out after {timeout}s"
    return _clip(f"exit {proc.returncode}\n" + out.decode("utf-8", "replace"))


async def run_shell(args, ctx):
    return await _proc(str(args.get("command", "")), shell=True, timeout=min(int(args.get("timeout") or 60), 300))


async def run_python(args, ctx):
    return await _proc(sys.executable, "-c", str(args.get("code", "")), timeout=min(int(args.get("timeout") or 60), 300))


# ── brain ──
async def remember(args, ctx):
    m = brain.add(str(args.get("text", "")), str(args.get("kind", "fact")), source=ctx["chat_id"])
    ctx.setdefault("learned", []).append({"op": "add", "id": m["id"], "text": m["text"], "kind": m["kind"]})
    return f"Saved memory {m['id']}: {m['text']}"


async def recall_memories(args, ctx):
    mems = await brain.recall(str(args.get("query", "")), int(args.get("count") or 8))
    return "\n".join(f"- ({m['id']}) [{m['kind']}] {m['text']}" for m in mems) or "No matching memories."


async def forget(args, ctx):
    brain.delete(str(args.get("id", "")))
    return "Forgotten."


# ── skills ──
async def load_skill(args, ctx):
    s = skills.find(str(args.get("name", "")))
    if not s or not s["enabled"]:
        return "ERROR: unknown skill. Available: " + ", ".join(i["slug"] for i in skills.list_skills(True))
    extra = f"\n\n(Extra files in this skill, readable with read_skill_file: {', '.join(s['files'])})" if s["files"] else ""
    return s["content"] + extra


async def read_skill_file(args, ctx):
    return _clip(skills.read_file(str(args.get("name", "")), str(args.get("path", ""))))


def _o(props: dict, req: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": req or []}


S, I, B = {"type": "string"}, {"type": "integer"}, {"type": "boolean"}

# name: (fn, description, parameters, group)
BUILTINS = {
    "web_search": (web_search, "Search the web. Returns titles, URLs and snippets.",
                   _o({"query": S | {"description": "search query"}, "count": I}, ["query"]), "web"),
    "fetch_url": (fetch_url, "Fetch a web page or file over HTTP(S) and return its readable text.",
                  _o({"url": S, "max_chars": I}, ["url"]), "web"),
    "calculator": (calculator, "Evaluate a maths expression exactly (supports math functions such as sqrt, log, sin).",
                   _o({"expression": S}, ["expression"]), "util"),
    "current_datetime": (current_datetime, "Get the current local date and time.", _o({}), "util"),
    "list_files": (list_files, "List files in the agent workspace (/data/workspace).",
                   _o({"path": S, "recursive": B}), "files"),
    "read_file": (read_file, "Read a text file from the agent workspace.", _o({"path": S}, ["path"]), "files"),
    "write_file": (write_file, "Create or overwrite (or append to) a text file in the agent workspace.",
                   _o({"path": S, "content": S, "append": B}, ["path", "content"]), "files"),
    "run_shell": (run_shell, "Run a shell command in the workspace inside the RyuCore container. Returns combined output.",
                  _o({"command": S, "timeout": I}, ["command"]), "exec"),
    "run_python": (run_python, "Run a Python 3 script (code passed directly) in the workspace. Print results to see them.",
                   _o({"code": S, "timeout": I}, ["code"]), "exec"),
    "remember": (remember, "Save a durable fact about the user to long-term memory (only things useful in future sessions).",
                 _o({"text": S, "kind": S | {"enum": brain.KINDS}}, ["text"]), "brain"),
    "recall_memories": (recall_memories, "Search long-term memory about the user.", _o({"query": S, "count": I}, ["query"]), "brain"),
    "forget": (forget, "Delete a memory by id when the user says it is wrong or asks you to forget it.",
               _o({"id": S}, ["id"]), "brain"),
    "load_skill": (load_skill, "Load the full instructions of a skill by name before doing a task it covers.",
                   _o({"name": S}, ["name"]), "skills"),
    "read_skill_file": (read_skill_file, "Read an extra file bundled with a skill.",
                        _o({"name": S, "path": S}, ["name", "path"]), "skills"),
}


def catalog() -> list[dict]:
    disabled = set(db.setting("tools_disabled") or [])
    out = []
    for name, (_fn, desc, _params, group) in BUILTINS.items():
        locked = group == "exec" and not config.ALLOW_SHELL
        out.append({"name": name, "description": desc, "group": group, "enabled": name not in disabled and not locked,
                    "locked": locked})
    return out


def specs(brain_on: bool) -> list[dict]:
    """Tool definitions offered to the model for this turn."""
    disabled = set(db.setting("tools_disabled") or [])
    have_skills = bool(skills.list_skills(True))
    out = []
    for name, (_fn, desc, params, group) in BUILTINS.items():
        if name in disabled or (group == "exec" and not config.ALLOW_SHELL) or (group == "brain" and not brain_on):
            continue
        if group == "skills" and not have_skills:
            continue
        out.append({"name": name, "description": desc, "parameters": params})
    return out + mcp.tool_specs()


async def execute(name: str, args: dict, ctx: dict) -> str:
    try:
        if name in BUILTINS:
            group = BUILTINS[name][3]
            if group == "brain" and not ctx.get("brain_on"):
                return "ERROR: the brain is off for this session."
            if group == "exec" and not config.ALLOW_SHELL:
                return "ERROR: shell access is disabled (RYU_ALLOW_SHELL=0)."
            return await asyncio.wait_for(BUILTINS[name][0](args or {}, ctx), 320)
        if mcp.owns(name):
            return _clip(await mcp.call(name, args or {}), 30000)
        return f"ERROR: unknown tool {name!r}"
    except Exception as e:  # noqa: BLE001 — tool errors go back to the model, not the user
        return f"ERROR: {type(e).__name__}: {e}"


def args_preview(args: dict) -> str:
    return json.dumps(args, ensure_ascii=False)[:2000]

