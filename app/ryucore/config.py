"""Environment configuration."""
import os
from pathlib import Path

VERSION = "1.0.2"


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


DATA = Path(os.environ.get("RYU_DATA", str(Path(__file__).resolve().parent.parent.parent / "data")))
PORT = int(os.environ.get("RYU_PORT", "8090"))
BIND = os.environ.get("RYU_BIND", "0.0.0.0")
PASSWORD = os.environ.get("RYU_PASSWORD", "")
SECRET = os.environ.get("RYU_SECRET", "")
ALLOW_SHELL = _flag("RYU_ALLOW_SHELL")
SEARXNG_URL = os.environ.get("RYU_SEARXNG_URL", "").rstrip("/")
MAX_STEPS = max(1, int(os.environ.get("RYU_MAX_STEPS", "12") or 12))
# HEARTH hub link: fleet tools over MCP + the fleet-wide theme
HEARTH_URL = os.environ.get("RYU_HEARTH_URL", "").strip().rstrip("/")
if HEARTH_URL and "://" not in HEARTH_URL:
    HEARTH_URL = "http://" + HEARTH_URL
HEARTH_TOKEN = os.environ.get("RYU_HEARTH_TOKEN", "").strip()  # = the hub's HEARTH_MCP_TOKEN, if it has one

DB_PATH = DATA / "ryucore.db"
SKILLS_DIR = DATA / "skills"
WORKSPACE = DATA / "workspace"
# Companion 伴侶: its own database and workspace, beside RyuCore's
COMPANION_DATA = DATA / "companion"
COMPANION_DB = COMPANION_DATA / "companion.db"
COMPANION_WORKSPACE = COMPANION_DATA / "workspace"

for _d in (DATA, SKILLS_DIR, WORKSPACE, COMPANION_DATA, COMPANION_WORKSPACE):
    _d.mkdir(parents=True, exist_ok=True)
