"""Chat turns: plain chat, agent mode (tool loop) and the council 評議会 (answer → vote → verdict)."""
import asyncio
import datetime as dt
import json
import logging
import random
import re

from . import brain, bus, db, providers, skills, tools

log = logging.getLogger("ryucore.agent")

BASE = """You are RyuCore 竜核, a capable, candid AI assistant running on the user's own server.
Answer directly. Use Markdown for structure when it helps (code blocks with a language tag, short lists, tables).
Current date: {date}."""

AGENT = """## Agent mode
You can call tools to act and look things up. Work step by step: call a tool, read its result, decide the next step.
Prefer acting over asking when the request is clear. When you are done, reply to the user with the result
(not a log of every step). Never invent tool results. If a tool fails, try another approach or explain the blocker.
Files you create live in the workspace (/data/workspace)."""

SKILLS_HINT = """## Skills
Specialised instructions you can load with `load_skill` when a task matches:
{list}"""


def _bg(coro):
    """Fire-and-forget with error logging (keeps a reference so the task isn't GC'd)."""
    t = asyncio.create_task(coro)
    _bg.tasks.add(t)
    t.add_done_callback(_bg.tasks.discard)
    return t


_bg.tasks = set()


def brain_on(chat: dict) -> bool:
    return bool(chat.get("brain"))


def chat_model(chat: dict) -> str:
    return chat.get("model") or db.setting("default_model") or ""


def history(chat_id: str) -> tuple[list[dict], list[dict]]:
    """(rows, messages in provider format), trimmed to the last N rows at a user-message boundary."""
    rows = db.messages(chat_id)
    limit = int(db.setting("history_limit") or 80)
    if len(rows) > limit:
        cut = len(rows) - limit
        while cut < len(rows) and rows[cut]["role"] != "user":
            cut += 1
        rows = rows[cut:]
    msgs = []
    for r in rows:
        m = {"role": r["role"], "content": r["content"]}
        meta = r["meta"] or {}
        if r["role"] == "user" and meta.get("images"):
            m["images"] = meta["images"]
        if r["role"] == "assistant" and meta.get("tool_calls"):
            m["tool_calls"] = meta["tool_calls"]
        if r["role"] == "assistant":
            m["content"] = providers.strip_think(m["content"]) if "<think>" in m["content"] else m["content"]
        if r["role"] == "tool":
            m["tool_call_id"] = meta.get("tool_call_id", "")
        if r["role"] == "assistant" and not m["content"] and not m.get("tool_calls"):
            continue
        msgs.append(m)
    # an assistant tool call with no stored result (stopped mid-turn) breaks most APIs — patch it
    fixed, pending = [], []
    for m in msgs:
        if pending and m["role"] != "tool":
            fixed += [{"role": "tool", "tool_call_id": cid, "content": "(interrupted)"} for cid in pending]
            pending = []
        if m["role"] == "assistant" and m.get("tool_calls"):
            pending = [c["id"] for c in m["tool_calls"]]
        elif m["role"] == "tool" and m.get("tool_call_id") in pending:
            pending.remove(m["tool_call_id"])
        fixed.append(m)
    fixed += [{"role": "tool", "tool_call_id": cid, "content": "(interrupted)"} for cid in pending]
    return rows, fixed


def last_user(rows: list[dict]) -> dict | None:
    return next((r for r in reversed(rows) if r["role"] == "user"), None)


def system_prompt(chat: dict, recalled: list[dict], skill_names: list[str], agent: bool, persona: str = "") -> str:
    parts = [BASE.format(date=dt.date.today().strftime("%A %d %B %Y"))]
    if g := (db.setting("system_prompt") or "").strip():
        parts.append(g)
    if c := (chat.get("system") or "").strip():
        parts.append(c)
    if persona.strip():
        parts.append("## Your role on this council\n" + persona.strip())
    if agent:
        parts.append(AGENT)
        avail = skills.list_skills(True)
        if avail and "load_skill" not in set(db.setting("tools_disabled") or []):
            parts.append(SKILLS_HINT.format(list="\n".join(f"- {s['slug']}: {s['description']}" for s in avail)))
    for name in skill_names or []:
        s = skills.find(name)
        if s and s["enabled"]:
            parts.append(f"## Active skill: {s['name']}\nFollow these instructions for this request:\n\n{s['content']}")
    if recalled:
        parts.append(brain.render(recalled))
    if not brain_on(chat):
        parts.append("(This is a private session: nothing from it will be remembered.)")
    return "\n\n".join(parts)


async def _recall(chat, rows):
    if not brain_on(chat):
        return []
    u = last_user(rows)
    try:
        return await brain.recall(u["content"] if u else "")
    except Exception as e:  # noqa: BLE001
        log.warning("recall failed: %s", e)
        return []


def _after_turn(chat: dict, model: str, rows: list[dict], answer: str, first_turn: bool):
    u = last_user(rows)
    if brain_on(chat) and u and answer.strip():
        _bg(brain.learn(chat["id"], model, u["content"], answer))
    if first_turn and db.setting("auto_title") and u:
        _bg(make_title(chat["id"], model, u["content"], answer))


async def make_title(chat_id: str, model: str, user_text: str, answer: str):
    try:
        t = await providers.complete(model, [
            {"role": "system", "content": "You write very short titles for chat sessions."},
            {"role": "user", "content": f"Write a 2-6 word title for a conversation that starts with:\n\n{user_text[:1500]}"
                                        f"\n\nReply with the title only: no quotes, no punctuation at the end."}])
        t = re.sub(r"^(title:)\s*", "", t.strip().splitlines()[0] if t.strip() else "", flags=re.I).strip(" \"'*#.")[:80]
    except Exception as e:  # noqa: BLE001
        log.info("title failed: %s", e)
        return
    if t:
        db.update("chats", chat_id, {"title": t})
        bus.publish({"type": "chat_title", "id": chat_id, "title": t})


# ───────────── single model / agent ─────────────
async def run(chat: dict, skill_names: list[str]):
    model = chat_model(chat)
    rows, msgs = history(chat["id"])
    first_turn = sum(1 for r in rows if r["role"] == "user") == 1
    recalled = await _recall(chat, rows)
    if recalled:
        yield {"type": "recall", "memories": [{"id": m["id"], "text": m["text"], "kind": m["kind"]} for m in recalled]}
    agent = bool(chat.get("agent"))
    specs = tools.specs(brain_on(chat)) if agent else []
    msgs = [{"role": "system", "content": system_prompt(chat, recalled, skill_names, agent)}] + msgs
    ctx = {"chat_id": chat["id"], "brain_on": brain_on(chat)}
    max_steps = int(db.setting("max_steps") or 12) if agent else 1
    final = ""
    for step in range(max_steps):
        mid, text, reasoning, calls, usage = db.new_id(), [], [], [], {}
        yield {"type": "step", "id": mid, "step": step, "model": model}
        saved = completed = False

        def save(error=""):
            nonlocal saved
            if saved:
                return
            saved = True
            meta = {"model": model, "step": step}
            if reasoning:
                meta["reasoning"] = "".join(reasoning)
            if calls:
                meta["tool_calls"] = calls
            if step == 0 and recalled:
                meta["recalled"] = [{"id": m["id"], "text": m["text"], "kind": m["kind"]} for m in recalled]
            if skill_names and step == 0:
                meta["skills"] = skill_names
            if usage:
                meta["usage"] = usage
            if error:
                meta["error"] = error
            if text or calls or error or reasoning:
                db.add_message(chat["id"], "assistant", "".join(text), meta, mid)

        try:
            async for ev in providers.stream_chat(model, msgs, specs or None, chat.get("temperature")):
                t = ev["type"]
                if t == "text":
                    text.append(ev["text"])
                elif t == "reasoning":
                    reasoning.append(ev["text"])
                elif t == "tool_call":
                    calls.append({"id": ev["id"], "name": ev["name"], "arguments": ev["arguments"]})
                elif t == "usage":
                    usage = {k: v for k, v in ev.items() if k != "type" and isinstance(v, (int, float))}
                    continue
                yield ev
            completed = True
        except providers.ProviderError as e:
            save(str(e))
            yield {"type": "error", "error": str(e)}
            return
        except Exception as e:  # noqa: BLE001
            log.exception("stream failed")
            save(f"{type(e).__name__}: {e}")
            yield {"type": "error", "error": f"{type(e).__name__}: {e}"}
            return
        finally:
            save("" if completed else "interrupted")
        final = "".join(text)
        if not final and not calls and not reasoning:
            yield {"type": "notice", "text": "The model returned an empty reply."}
        msgs.append({"role": "assistant", "content": final, **({"tool_calls": calls} if calls else {})})
        if not calls:
            break
        for c in calls:
            yield {"type": "tool_start", "id": c["id"], "name": c["name"], "arguments": c["arguments"]}
            res = await tools.execute(c["name"], c["arguments"], ctx)
            db.add_message(chat["id"], "tool", res, {"tool_call_id": c["id"], "name": c["name"]})
            msgs.append({"role": "tool", "tool_call_id": c["id"], "content": res})
            yield {"type": "tool_result", "id": c["id"], "name": c["name"], "content": res[:20000]}
            for ch in ctx.pop("learned", []):
                bus.publish({"type": "brain_learned", "chat_id": chat["id"], "changes": [ch]})
    else:
        yield {"type": "notice", "text": f"Stopped after {max_steps} agent steps (limit)."}
    yield {"type": "done"}
    _after_turn(chat, model, rows, final, first_turn)


# ───────────── council 評議会 ─────────────
VOTE_SYS = """You are a judge on a council of AI models that answered the same request.
Judge the candidate answers impartially on correctness, helpfulness, completeness, clarity and how well they
follow the user's request. Length is not quality. Your own answer is not on the ballot."""

VOTE_USER = """## The request
{question}

## Candidate answers
{answers}

Rank ALL candidates from best to worst. Reply with ONLY a JSON object:
{{"ranking": [{labels}], "reason": "one or two sentences on why your first choice is best"}}"""


def _label(i: int) -> str:
    return chr(ord("A") + i)


def _parse_ballot(text: str, labels: list[str]) -> tuple[list[str], str]:
    text = providers.strip_think(text)
    ranking, reason = [], ""
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            j = json.loads(m.group(0))
            ranking = [str(x).strip().upper().removeprefix("ANSWER ").strip() for x in j.get("ranking") or []]
            reason = str(j.get("reason", ""))[:600]
        except ValueError:
            pass
    if not ranking:  # fall back to letters in the order they appear
        ranking = re.findall(r"\b([A-Z])\b", text.upper())
        reason = text.strip()[:300]
    seen, out = set(), []
    for r in ranking:
        if r in labels and r not in seen:
            seen.add(r)
            out.append(r)
    return out, reason


def tally(n: int, ballots: list[dict]) -> dict:
    """Plurality of first-choice votes; ties broken by Borda count, then by seat order."""
    first = [0] * n
    borda = [0] * n
    for b in ballots:
        rk = b.get("ranking") or []
        if not rk:
            continue
        first[rk[0]] += 1
        for pos, j in enumerate(rk):
            borda[j] += len(rk) - pos
    order = sorted(range(n), key=lambda i: (-first[i], -borda[i], i))
    win = order[0]
    tie = [i for i in range(n) if first[i] == first[win]]
    method = "plurality" if len(tie) == 1 else ("borda" if sum(1 for i in tie if borda[i] == borda[win]) == 1 else "seat order")
    return {"first": first, "borda": borda, "winner": win, "method": method, "order": order}


async def run_council(chat: dict, skill_names: list[str]):
    council = chat.get("council") or {}
    members = [m for m in council.get("members") or [] if m.get("model")]
    if len(members) < 2:
        yield {"type": "error", "error": "A council needs at least 2 members. Configure it with ⚖ COUNCIL."}
        return
    rows, msgs = history(chat["id"])
    first_turn = sum(1 for r in rows if r["role"] == "user") == 1
    # council answers use plain history: user turns + previous verdicts
    msgs = [m for m in msgs if m["role"] == "user" or (m["role"] == "assistant" and not m.get("tool_calls"))]
    recalled = await _recall(chat, rows)
    if recalled:
        yield {"type": "recall", "memories": [{"id": m["id"], "text": m["text"], "kind": m["kind"]} for m in recalled]}
    seats = [{"i": i, "name": m.get("name") or m["model"].split("::")[-1], "model": m["model"],
              "persona": m.get("persona", "")} for i, m in enumerate(members)]
    yield {"type": "council_start", "members": seats}

    # phase 1 — everyone answers in parallel, streamed
    answers = [""] * len(seats)
    errors = [""] * len(seats)
    qu: asyncio.Queue = asyncio.Queue()

    async def answer(s):
        sys = system_prompt(chat, recalled, skill_names, False, s["persona"])
        buf = []
        try:
            async for ev in providers.stream_chat(s["model"], [{"role": "system", "content": sys}] + msgs, None,
                                                  chat.get("temperature")):
                if ev["type"] == "text":
                    buf.append(ev["text"])
                    await qu.put({"type": "member_text", "i": s["i"], "text": ev["text"]})
        except Exception as e:  # noqa: BLE001
            errors[s["i"]] = str(e)[:500]
        answers[s["i"]] = providers.strip_think("".join(buf))
        await qu.put({"type": "member_done", "i": s["i"], "error": errors[s["i"]], "chars": len(answers[s["i"]])})

    tasks = [asyncio.create_task(answer(s)) for s in seats]
    try:
        done = 0
        while done < len(seats):
            ev = await qu.get()
            if ev["type"] == "member_done":
                done += 1
            yield ev
    finally:
        for t in tasks:
            t.cancel()

    valid = [s["i"] for s in seats if answers[s["i"]].strip() and not errors[s["i"]]]
    question = (last_user(rows) or {}).get("content", "")
    ballots: list[dict] = []
    if len(valid) >= 2:
        # phase 2 — each member ranks the others' anonymised answers
        yield {"type": "phase", "phase": "vote"}

        async def vote(voter):
            cands = [i for i in valid if i != voter["i"]]
            random.shuffle(cands)
            labels = [_label(k) for k in range(len(cands))]
            body = "\n\n".join(f"### Answer {lab}\n{answers[i][:7000]}" for lab, i in zip(labels, cands))
            prompt = VOTE_USER.format(question=question[:6000], answers=body, labels=", ".join(f'"{x}"' for x in labels))
            try:
                out = await providers.complete(voter["model"], [{"role": "system", "content": VOTE_SYS},
                                                                {"role": "user", "content": prompt}])
                rk, reason = _parse_ballot(out, labels)
            except Exception as e:  # noqa: BLE001
                rk, reason = [], f"abstained ({str(e)[:200]})"
            ranking = [cands[labels.index(x)] for x in rk]
            return {"voter": voter["i"], "ranking": ranking, "reason": reason or ("abstained" if not ranking else "")}

        vtasks = [asyncio.create_task(vote(seats[i])) for i in valid]
        try:
            for fut in asyncio.as_completed(vtasks):
                b = await fut
                ballots.append(b)
                yield {"type": "ballot", **b}
        finally:
            for t in vtasks:
                t.cancel()
        result = tally(len(seats), ballots)
        if result["winner"] not in valid:
            result["winner"] = valid[0]
    elif valid:
        result = {"first": [0] * len(seats), "borda": [0] * len(seats), "winner": valid[0], "method": "only valid answer",
                  "order": valid}
    else:
        msg = "Every council member failed: " + "; ".join(f"{s['name']}: {errors[s['i']] or 'empty answer'}" for s in seats)
        db.add_message(chat["id"], "assistant", "", {"error": msg, "council": {"members": seats, "answers": answers,
                                                                               "errors": errors, "ballots": []}})
        yield {"type": "error", "error": msg}
        return

    win = result["winner"]
    verdict = {"members": seats, "answers": answers, "errors": errors, "ballots": ballots, **result}
    yield {"type": "verdict", **{k: v for k, v in verdict.items() if k != "answers"}}
    meta = {"model": seats[win]["model"], "council": verdict}
    if recalled:
        meta["recalled"] = [{"id": m["id"], "text": m["text"], "kind": m["kind"]} for m in recalled]
    db.add_message(chat["id"], "assistant", answers[win], meta)
    yield {"type": "done"}
    _after_turn(chat, seats[win]["model"], rows, answers[win], first_turn)
