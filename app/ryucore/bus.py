"""In-process pub/sub for the browser's /api/events stream."""
import asyncio

_subs: set[asyncio.Queue] = set()


def publish(ev: dict) -> None:
    for qu in list(_subs):
        try:
            qu.put_nowait(ev)
        except asyncio.QueueFull:
            pass


def subscribe() -> asyncio.Queue:
    qu: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subs.add(qu)
    return qu


def unsubscribe(qu: asyncio.Queue) -> None:
    _subs.discard(qu)
