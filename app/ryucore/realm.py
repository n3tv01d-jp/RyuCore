"""Realms: RyuCore ("core") and Companion 伴侶 ("companion") share one server and code, but not their data.

The realm is set per request from the URL (/companion/… is the Companion app) and travels with the
request through contextvars, including into background tasks it starts (asyncio copies the context).
"""
import contextvars

CORE, COMPANION = "core", "companion"
PREFIX = "/" + COMPANION

_current: contextvars.ContextVar[str] = contextvars.ContextVar("ryu_realm", default=CORE)


def current() -> str:
    return _current.get()


def is_companion() -> bool:
    return _current.get() == COMPANION


def use(name: str) -> contextvars.Token:
    return _current.set(COMPANION if name == COMPANION else CORE)


class Middleware:
    """Pure ASGI: /companion/<path> is served as /<path> with the realm set to companion."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path == PREFIX:  # the page must end in / so its relative URLs (api/…, app.js) stay under the prefix
            qs = scope.get("query_string", b"").decode("latin-1")
            await send({"type": "http.response.start", "status": 308,
                        "headers": [(b"location", (PREFIX + "/" + ("?" + qs if qs else "")).encode("latin-1"))]})
            await send({"type": "http.response.body", "body": b""})
            return
        token = None
        if path.startswith(PREFIX + "/"):
            rest = path[len(PREFIX):]
            scope = dict(scope, path=rest, raw_path=rest.encode("utf-8"))
            token = use(COMPANION)
        else:
            token = use(CORE)
        try:
            await self.app(scope, receive, send)
        finally:
            _current.reset(token)
