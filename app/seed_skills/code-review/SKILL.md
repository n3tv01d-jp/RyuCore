---
name: code-review
description: Review code for bugs first, then clarity. Use when the user pastes code or a diff and asks for a review, a second opinion, or "what's wrong with this".
---

# Code review

Review in this order and stop padding once you run out of real findings:

1. **Correctness**: logic errors, off-by-one, unhandled errors or None values, race conditions, resource leaks.
   For each one, give the concrete input or state that triggers it.
2. **Security**: injection, path traversal, secrets in code, unsafe deserialisation, missing auth checks.
3. **Behaviour changes**: anything that silently changes an API, output format or default.
4. **Clarity**: only naming or structure issues that would genuinely confuse the next reader.

Format each finding as:

`[severity] file:line — what's wrong` followed by a short fix (a code snippet when it helps).

Severity is one of `bug`, `risk`, `nit`. Put the findings with the highest severity first. If the code looks correct, say so
plainly. Don't invent problems to have something to report.
