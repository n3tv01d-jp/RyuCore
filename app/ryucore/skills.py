"""Skills: folders under /data/skills/<slug>/ holding a SKILL.md (YAML-ish front matter + instructions)
plus optional extra files. Agents see name + description and load the full text on demand."""
import io
import re
import shutil
import zipfile
from pathlib import Path

from . import config, db

ROOT = config.SKILLS_DIR
SEED = Path(__file__).resolve().parent.parent / "seed_skills"
MAX_FILE = 256 * 1024


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9-]+", "-", (s or "").lower()).strip("-")[:48] or "skill"


def parse(md: str) -> tuple[dict, str]:
    meta: dict = {}
    body = md
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", md, re.S)
    if m:
        body = md[m.end():]
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith((" ", "\t")):
                k, _, v = line.partition(":")
                meta[k.strip().lower()] = v.strip().strip("'\"")
    return meta, body.strip()


def _dir(slug: str) -> Path:
    d = (ROOT / slugify(slug)).resolve()
    if d.parent != ROOT.resolve():
        raise ValueError("bad skill name")
    return d


def _info(d: Path, disabled: set) -> dict | None:
    f = d / "SKILL.md"
    if not f.is_file():
        return None
    text = f.read_text("utf-8", "replace")
    meta, body = parse(text)
    files = sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file() and p.name != "SKILL.md")
    return {"slug": d.name, "name": meta.get("name") or d.name, "description": meta.get("description", ""),
            "enabled": d.name not in disabled, "files": files[:200], "size": len(text), "body_chars": len(body)}


def list_skills(enabled_only=False) -> list[dict]:
    disabled = set(db.setting("skills_disabled") or [])
    out = [i for d in sorted(ROOT.iterdir()) if d.is_dir() and (i := _info(d, disabled))]
    return [s for s in out if s["enabled"]] if enabled_only else out


def get(slug: str) -> dict | None:
    d = _dir(slug)
    info = _info(d, set(db.setting("skills_disabled") or [])) if d.is_dir() else None
    if info:
        info["content"] = (d / "SKILL.md").read_text("utf-8", "replace")
    return info


def find(name: str) -> dict | None:
    """Look a skill up by slug or display name."""
    s = get(name) if slugify(name) == name.lower() else None
    if s:
        return s
    for i in list_skills():
        if i["name"].lower() == name.lower() or i["slug"] == slugify(name):
            return get(i["slug"])
    return None


def save(slug: str, content: str) -> str:
    meta, _ = parse(content)
    slug = slugify(slug or meta.get("name", ""))
    d = _dir(slug)
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(content, "utf-8")
    return slug


def delete(slug: str) -> None:
    d = _dir(slug)
    if d.is_dir():
        shutil.rmtree(d)


def set_enabled(slug: str, on: bool) -> None:
    dis = set(db.setting("skills_disabled") or [])
    (dis.discard if on else dis.add)(slugify(slug))
    db.set_setting("skills_disabled", sorted(dis))


def read_file(slug: str, rel: str) -> str:
    d = _dir(slug)
    p = (d / rel).resolve()
    if not p.is_relative_to(d) or not p.is_file():
        raise FileNotFoundError(f"{rel} not found in skill {slug}")
    if p.stat().st_size > MAX_FILE:
        return p.read_bytes()[:MAX_FILE].decode("utf-8", "replace") + "\n…(truncated)"
    return p.read_text("utf-8", "replace")


def import_archive(filename: str, data: bytes) -> list[str]:
    """Import a single SKILL.md / .md file, or a .zip holding one or more skill folders."""
    if not filename.lower().endswith(".zip"):
        text = data.decode("utf-8", "replace")
        meta, _ = parse(text)
        return [save(meta.get("name") or Path(filename).stem, text)]
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = [n for n in zf.namelist() if not n.endswith("/") and "__MACOSX" not in n]
    roots = sorted({str(Path(n).parent) for n in names if Path(n).name == "SKILL.md"})
    if not roots:
        raise ValueError("zip contains no SKILL.md")
    total = sum(zf.getinfo(n).file_size for n in names)
    if total > 20 * 1024 * 1024:
        raise ValueError("zip too large (20 MB max unpacked)")
    done = []
    for root in roots:
        meta, _ = parse(zf.read(f"{root}/SKILL.md" if root != "." else "SKILL.md").decode("utf-8", "replace"))
        slug = slugify(meta.get("name") or (Path(root).name if root != "." else Path(filename).stem))
        d = _dir(slug)
        d.mkdir(parents=True, exist_ok=True)
        prefix = "" if root == "." else root + "/"
        for n in names:
            if not n.startswith(prefix):
                continue
            target = (d / n[len(prefix):]).resolve()
            if not target.is_relative_to(d):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(n))
        done.append(slug)
    return done


def seed() -> None:
    if any(ROOT.iterdir()) or not SEED.is_dir():
        return
    for d in SEED.iterdir():
        if (d / "SKILL.md").is_file():
            shutil.copytree(d, ROOT / d.name, dirs_exist_ok=True)
