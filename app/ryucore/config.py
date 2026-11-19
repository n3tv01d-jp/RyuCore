"""Environment configuration."""
import os
from pathlib import Path

VERSION = "1.0.0"


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

DB_PATH = DATA / "ryucore.db"
SKILLS_DIR = DATA / "skills"
WORKSPACE = DATA / "workspace"

for _d in (DATA, SKILLS_DIR, WORKSPACE):
    _d.mkdir(parents=True, exist_ok=True)
