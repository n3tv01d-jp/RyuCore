"""In-process pub/sub for the browser's /api/events stream (each realm hears only its own events)."""
import asyncio

from . import realm

_subs: dict[asyncio.Queue, str] = {}
GLOBAL = {"mcp"}  # MCP servers are shared by both realms


def publish(ev: dict) -> None:
    here = realm.current()
    for qu, where in list(_subs.items()):
        if where != here and ev.get("type") not in GLOBAL:
            continue
        try:
            qu.put_nowait(ev)
        except asyncio.QueueFull:
            pass


def subscribe() -> asyncio.Queue:
    qu: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subs[qu] = realm.current()
    return qu


def unsubscribe(qu: asyncio.Queue) -> None:
    _subs.pop(qu, None)
