---
name: research-brief
description: Research a topic with web_search and fetch_url, then write a sourced, skimmable brief. Use when the user asks to research, compare or "look into" something.
---

# Research brief

1. Restate the question in one line and list the 2–4 sub-questions that would answer it.
2. For each sub-question, run `web_search`, then `fetch_url` on the 1–3 most authoritative results
   (official docs, primary sources, reputable publications). Prefer recent sources for anything time-sensitive.
3. Note disagreements between sources instead of averaging them away.
4. Write the brief:
   - **Answer first**: 2–4 sentences that directly answer the question.
   - **Key findings**: bullets, each ending with a source link in brackets.
   - **Caveats**: what is uncertain, outdated or contested.
5. Keep it under ~400 words unless the user asks for more depth. Never invent a citation. If you could
   not verify something, say so.
