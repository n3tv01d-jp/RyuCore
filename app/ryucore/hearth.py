"""Link to a HEARTH hub (RYU_HEARTH_URL): its MCP server for the agents, and the fleet-wide theme."""
import json
import logging
import time

import httpx

from . import config, db

log = logging.getLogger("ryucore.hearth")
SID = "hearth"  # fixed id of the MCP server row this module manages
_cache: dict = {"t": 0.0, "data": None}


def enabled() -> bool:
    return bool(config.HEARTH_URL)


def seed_mcp() -> bool:
    """Add (or re-point) the `hearth` MCP server when RYU_HEARTH_URL is set. Returns True if it changed.

    Only reacts to a changed URL/token, so deleting or disabling the server in the MCP view sticks.
    """
    if not enabled():
        return False
    want = {"url": config.HEARTH_URL + "/mcp",
            "headers": json.dumps({"Authorization": f"Bearer {config.HEARTH_TOKEN}"} if config.HEARTH_TOKEN else {})}
    stamp = f"{want['url']}|{bool(config.HEARTH_TOKEN)}"
    if db.setting("_hearth_seeded") == stamp:
        return False
    row = db.one("SELECT * FROM mcp_servers WHERE id=?", (SID,))
    if row:
        db.update("mcp_servers", SID, {"transport": "http", **want})
    else:
        db.insert("mcp_servers", {"id": SID, "name": "hearth", "transport": "http", "command": "", "args": "[]",
                                  "env": "{}", "enabled": 1, "created": db.now(), **want})
    db.set_setting("_hearth_seeded", stamp)
    log.info("HEARTH MCP server linked at %s", want["url"])
    return True


async def theme(fresh: bool = False) -> dict | None:
    """The hub's /api/theme (palettes, fleet theme, KAGARI pack), cached for a few seconds."""
    if not enabled():
        return None
    if not fresh and _cache["data"] and time.monotonic() - _cache["t"] < 10:
        return _cache["data"]
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(config.HEARTH_URL + "/api/theme")
            r.raise_for_status()
            data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        log.info("HEARTH theme unavailable: %s", e)
        return _cache["data"]
    _cache.update(t=time.monotonic(), data=data)
    return data


async def set_theme(pid: str) -> dict:
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(config.HEARTH_URL + "/api/theme", json={"theme": pid}, headers={"X-Hearth": "1"})
    if r.status_code >= 400:
        try:
            msg = r.json().get("detail")
        except ValueError:
            msg = None
        raise ValueError(msg or f"HTTP {r.status_code}")
    _cache["t"] = 0.0
    return r.json()
