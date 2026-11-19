"""Minimal Model Context Protocol client: stdio, Streamable HTTP and legacy HTTP+SSE transports.

Only the client side of tools is implemented (initialize → tools/list → tools/call), which is what agents need.
"""
import asyncio
import json
import os
import re
import shlex
from collections import deque
from urllib.parse import urljoin

import httpx

from . import bus, config, db
from .providers import iter_sse

PROTOCOL = "2025-06-18"
CLIENT_INFO = {"name": "RyuCore", "version": config.VERSION}


def _slug(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", s).strip("_") or "x"


class MCPClient:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.status = "stopped"
        self.error = ""
        self.tools: list[dict] = []
        self.server_info: dict = {}
        self.log: deque[str] = deque(maxlen=300)
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: list[asyncio.Task] = []
        self._http: httpx.AsyncClient | None = None
        self._session_id = ""
        self._post_url = ""
        self._stopping = False

    # ── lifecycle ──
    @property
    def transport(self) -> str:
        return self.cfg.get("transport") or "stdio"

    def _set(self, status, error=""):
        self.status, self.error = status, error
        bus.publish({"type": "mcp", "id": self.cfg["id"], "status": status, "error": error, "tools": len(self.tools)})

    async def start(self):
        self._stopping = False
        self._set("starting")
        try:
            if self.transport == "stdio":
                await self._start_stdio()
            else:
                headers = {k: str(v) for k, v in (db.jload(self.cfg.get("headers"), {}) or {}).items()}
                self._http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=300.0), headers=headers,
                                               follow_redirects=True)
                if self.transport == "sse":
                    await self._start_sse()
            init = await self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                                     "clientInfo": CLIENT_INFO}, timeout=90)
            self.server_info = init.get("serverInfo") or {}
            await self.notify("notifications/initialized")
            await self.refresh_tools()
            self._set("ready")
        except Exception as e:  # noqa: BLE001 — report any startup failure in the UI
            msg = str(e) or type(e).__name__
            self.log.append(f"[ryucore] start failed: {msg}")
            await self.stop()
            self._set("error", msg)

    async def stop(self):
        self._stopping = True
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), 5)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
        self._proc = None
        if self._http:
            if self._session_id and self.transport == "http":
                try:
                    await self._http.delete(self.cfg["url"], headers={"Mcp-Session-Id": self._session_id}, timeout=5)
                except httpx.HTTPError:
                    pass
            await self._http.aclose()
            self._http = None
        self._session_id = ""
        for f in self._pending.values():
            if not f.done():
                f.set_exception(ConnectionError("MCP server stopped"))
        self._pending.clear()
        if self.status != "error":
            self._set("stopped")

    async def refresh_tools(self):
        tools, cursor = [], None
        for _ in range(20):
            res = await self.request("tools/list", {"cursor": cursor} if cursor else {})
            tools += res.get("tools") or []
            cursor = res.get("nextCursor")
            if not cursor:
                break
        self.tools = tools

    async def call_tool(self, name: str, args: dict) -> str:
        if self.status != "ready":
            raise ConnectionError(f"MCP server '{self.cfg['name']}' is {self.status}")
        res = await self.request("tools/call", {"name": name, "arguments": args or {}}, timeout=300)
        parts = []
        for c in res.get("content") or []:
            t = c.get("type")
            if t == "text":
                parts.append(c.get("text", ""))
            elif t == "resource":
                r = c.get("resource") or {}
                parts.append(r.get("text") or f"[resource {r.get('uri', '')}]")
            elif t == "resource_link":
                parts.append(f"[resource {c.get('uri', '')}]")
            else:
                parts.append(f"[{t} content omitted]")
        if not parts and res.get("structuredContent") is not None:
            parts.append(json.dumps(res["structuredContent"], indent=1))
        out = "\n".join(parts) or "(no output)"
        return ("ERROR: " + out) if res.get("isError") else out

    # ── JSON-RPC ──
    async def request(self, method: str, params: dict | None = None, timeout: float = 60):
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}
        if self.transport == "http":
            j = await self._http_post(msg)
            if j is None:
                raise ConnectionError(f"no response to {method}")
            return self._result(j)
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        try:
            await self._send(msg)
            return self._result(await asyncio.wait_for(fut, timeout))
        finally:
            self._pending.pop(msg["id"], None)

    @staticmethod
    def _result(j: dict):
        if "error" in j:
            e = j["error"] or {}
            raise RuntimeError(f"MCP error {e.get('code')}: {e.get('message')}")
        return j.get("result") or {}

    async def notify(self, method: str, params: dict | None = None):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if self.transport == "http":
            await self._http_post(msg)
        else:
            await self._send(msg)

    async def _dispatch(self, j):
        if isinstance(j, list):
            for x in j:
                await self._dispatch(x)
            return
        if not isinstance(j, dict):
            return
        if "id" in j and ("result" in j or "error" in j):
            f = self._pending.get(j["id"])
            if f and not f.done():
                f.set_result(j)
        elif "method" in j and "id" in j:  # server → client request
            m = j["method"]
            if m == "ping":
                reply = {"jsonrpc": "2.0", "id": j["id"], "result": {}}
            elif m == "roots/list":
                reply = {"jsonrpc": "2.0", "id": j["id"], "result": {"roots": [
                    {"uri": config.WORKSPACE.as_uri(), "name": "workspace"}]}}
            else:
                reply = {"jsonrpc": "2.0", "id": j["id"], "error": {"code": -32601, "message": f"{m} not supported"}}
            await (self._http_post(reply) if self.transport == "http" else self._send(reply))
        elif j.get("method") == "notifications/tools/list_changed":
            asyncio.create_task(self._refresh_quiet())
        elif j.get("method") == "notifications/message":
            p = j.get("params") or {}
            self.log.append(f"[{p.get('level', 'log')}] {p.get('data')}")

    async def _refresh_quiet(self):
        try:
            await self.refresh_tools()
            self._set(self.status)
        except Exception as e:  # noqa: BLE001
            self.log.append(f"[ryucore] tool refresh failed: {e}")

    # ── stdio ──
    async def _start_stdio(self):
        cmd = (self.cfg.get("command") or "").strip()
        args = db.jload(self.cfg.get("args"), []) or []
        if not cmd:
            raise ValueError("no command configured")
        if not args and " " in cmd:
            cmd, *args = shlex.split(cmd)
        env = {**os.environ, **{k: str(v) for k, v in (db.jload(self.cfg.get("env"), {}) or {}).items()}}
        self.log.append(f"$ {cmd} {' '.join(shlex.quote(a) for a in args)}")
        self._proc = await asyncio.create_subprocess_exec(
            cmd, *[str(a) for a in args], stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env, cwd=str(config.WORKSPACE), limit=32 * 1024 * 1024)
        self._tasks += [asyncio.create_task(self._read_stdout()), asyncio.create_task(self._read_stderr())]

    async def _send(self, msg: dict):
        if self.transport == "sse":
            if not self._http:
                raise ConnectionError("not connected")
            r = await self._http.post(self._post_url, json=msg)
            if r.status_code >= 400:
                raise ConnectionError(f"HTTP {r.status_code}: {r.text[:200]}")
            return
        if not self._proc or self._proc.returncode is not None:
            raise ConnectionError("process not running")
        self._proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self._proc.stdin.drain()

    async def _read_stdout(self):
        proc = self._proc
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            s = line.decode("utf-8", "replace").strip()
            if not s:
                continue
            try:
                await self._dispatch(json.loads(s))
            except ValueError:
                self.log.append(s[:500])
        code = await proc.wait()
        if not self._stopping:
            self.log.append(f"[ryucore] process exited with code {code}")
            for f in self._pending.values():
                if not f.done():
                    f.set_exception(ConnectionError(f"process exited ({code})"))
            self._set("error", f"process exited with code {code}")

    async def _read_stderr(self):
        while self._proc and (line := await self._proc.stderr.readline()):
            self.log.append(line.decode("utf-8", "replace").rstrip()[:500])

    # ── Streamable HTTP ──
    async def _http_post(self, msg: dict):
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
             "MCP-Protocol-Version": PROTOCOL}
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        async with self._http.stream("POST", self.cfg["url"], json=msg, headers=h) as r:
            if r.headers.get("mcp-session-id"):
                self._session_id = r.headers["mcp-session-id"]
            if r.status_code >= 400:
                body = (await r.aread()).decode("utf-8", "replace")
                raise ConnectionError(f"HTTP {r.status_code}: {body[:300]}")
            if "id" not in msg or "method" not in msg or r.status_code == 202:
                return None
            ctype = r.headers.get("content-type", "")
            if "text/event-stream" in ctype:
                async for _ev, data in iter_sse(r):
                    try:
                        j = json.loads(data)
                    except ValueError:
                        continue
                    if isinstance(j, dict) and j.get("id") == msg["id"] and ("result" in j or "error" in j):
                        return j
                    await self._dispatch(j)
                return None
            j = json.loads(await r.aread() or b"null")
            if isinstance(j, list):
                return next((x for x in j if x.get("id") == msg["id"]), None)
            return j

    # ── legacy HTTP+SSE ──
    async def _start_sse(self):
        ready = asyncio.get_running_loop().create_future()
        self._tasks.append(asyncio.create_task(self._sse_loop(ready)))
        self._post_url = await asyncio.wait_for(ready, 30)

    async def _sse_loop(self, ready: asyncio.Future):
        try:
            async with self._http.stream("GET", self.cfg["url"], headers={"Accept": "text/event-stream"},
                                         timeout=httpx.Timeout(30.0, read=None)) as r:
                if r.status_code >= 400:
                    raise ConnectionError(f"HTTP {r.status_code}")
                async for ev, data in iter_sse(r):
                    if ev == "endpoint":
                        if not ready.done():
                            ready.set_result(urljoin(self.cfg["url"], data.strip()))
                        continue
                    try:
                        await self._dispatch(json.loads(data))
                    except ValueError:
                        pass
        except Exception as e:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(e)
            elif not self._stopping:
                self._set("error", f"SSE stream closed: {e}")
            return
        if not self._stopping:
            self._set("error", "SSE stream closed")


class MCPManager:
    def __init__(self):
        self.clients: dict[str, MCPClient] = {}
        self._map: dict[str, tuple[str, str]] = {}

    def rows(self) -> list[dict]:
        return db.q("SELECT * FROM mcp_servers ORDER BY created")

    async def start_all(self):
        await asyncio.gather(*(self.restart(r["id"]) for r in self.rows() if r["enabled"]), return_exceptions=True)

    async def restart(self, sid: str):
        await self.stop(sid)
        row = db.one("SELECT * FROM mcp_servers WHERE id=?", (sid,))
        if not row or not row["enabled"]:
            return
        c = MCPClient(row)
        self.clients[sid] = c
        await c.start()

    async def stop(self, sid: str):
        c = self.clients.pop(sid, None)
        if c:
            await c.stop()

    async def stop_all(self):
        await asyncio.gather(*(c.stop() for c in self.clients.values()), return_exceptions=True)
        self.clients.clear()

    def status(self, sid: str) -> dict:
        c = self.clients.get(sid)
        if not c:
            return {"status": "stopped", "error": "", "tools": [], "server_info": {}}
        return {"status": c.status, "error": c.error, "server_info": c.server_info,
                "tools": [{"name": t.get("name"), "description": (t.get("description") or "")[:300]} for t in c.tools]}

    def tool_specs(self) -> list[dict]:
        """Function specs for every tool of every ready server, with collision-free names."""
        specs, self._map = [], {}
        for sid, c in self.clients.items():
            if c.status != "ready":
                continue
            srv = _slug(c.cfg["name"])[:20]
            for t in c.tools:
                base = f"{srv}__{_slug(t.get('name', ''))}"[:64]
                name, n = base, 2
                while name in self._map:
                    name = f"{base[:60]}_{n}"
                    n += 1
                self._map[name] = (sid, t.get("name"))
                schema = t.get("inputSchema") or {"type": "object", "properties": {}}
                if schema.get("type") != "object":
                    schema = {"type": "object", "properties": {}}
                specs.append({"name": name, "description": f"[MCP · {c.cfg['name']}] {t.get('description') or ''}"[:1024],
                              "parameters": schema})
        return specs

    def owns(self, name: str) -> bool:
        return name in self._map

    async def call(self, name: str, args: dict) -> str:
        sid, tool = self._map[name]
        c = self.clients.get(sid)
        if not c:
            raise ConnectionError("MCP server is not running")
        return await c.call_tool(tool, args)


manager = MCPManager()
