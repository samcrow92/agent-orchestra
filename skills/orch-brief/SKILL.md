---
name: orch-brief
description: Write the brief file for a worker task created with `orch task new`. Use every time you fill in a brief.md before `orch dispatch`, or when a dispatch is refused because the brief is invalid or too long.
---

# Writing a worker brief

The worker starts with an empty context. It sees the worker contract, this brief, and the repository. It does not see this chat, the state card, or earlier tasks. Everything it needs is in the brief or reachable from a path the brief names.

A local Qwen worker follows a brief literally and does not recover well from gaps. Write for that reader; a brief that works for Qwen works for every worker.

## Header (one line each, no line breaks)

- `goal:` one sentence, the outcome, in the imperative. One task, one goal. "Add retry with backoff to `fetchQuote` in src/api/quote.ts".
- `scope:` space-separated path prefixes the worker may change, relative to the project root. As narrow as the task allows: `src/api/quote.ts tests/api/`. `orch verify` rejects any change outside these prefixes.
- `verify:` one shell command that exits 0 only when the task is done, runnable from the project root. Prefer the narrowest check: `npm test -- quote` over `npm test`. Leave empty to use the project default. The project runs on Windows: the command must work in cmd.exe (no `&&`-chains that rely on bash builtins, no `grep`; use the project's own scripts).
- `role:` `edit`, or `read` for a scout that only reports.

## Body

`## Context`: pointers, not content. Paths with line ranges or symbol names, and one clause on why each matters: "`src/api/client.ts:40-88` — existing `withTimeout` wrapper; follow its style." Paste code only when it is a few lines the worker must match exactly (an interface, an error string). State facts the worker cannot find in the repo: the decision already taken, the library version, the thing that was tried and failed.

`## Constraints`: what must not change, and choices already made. "Keep the public signature of `fetchQuote`." "Use the existing `sleep` helper; no new dependency." Give the reason when it is not obvious, so the worker applies it to cases you did not list.

`## Done when`: observable acceptance criteria, two to five bullets. Each is something `verify` or a diff can confirm: "A test covers the 503-then-200 case." Not "works correctly".

## Budget

Dispatch refuses briefs over 80 lines. If yours is longer, the task is too big (split it, skill `orch-route`) or you are pasting what you should point to.

If you cannot name the files, you do not know enough to brief an edit. Dispatch a `role: read` scout first: goal "Report where X is implemented and how Y calls it", done-when "RESULT lists file:line for each".

## Before dispatch, check

- Could a capable engineer who has never seen this chat do the task from the brief alone?
- Is there exactly one way to read the goal?
- Does `verify` fail today and pass when the task is done? If it passes today, it proves nothing.
- Does every name in the brief (file, function, flag) exist? You got them from a scout result or the state card, not from memory.

## Example

```
goal: Make `parseDuration` accept the "1h30m" compound form.
scope: src/util/duration.ts tests/util/duration.test.ts
verify: npm test -- duration
role: edit
---
## Context
- `src/util/duration.ts:12-47` — `parseDuration`; today it handles one unit ("90m", "2h").
- `tests/util/duration.test.ts` — existing cases; add to this file.
- Callers pass user input from the CLI `--timeout` flag, so bad input must throw `DurationError` (same file, line 5), never return NaN.

## Constraints
- Return value stays milliseconds (number).
- Single-unit inputs keep working unchanged.
- Units allowed: h, m, s. Order must be h, then m, then s; "30m1h" throws.

## Done when
- "1h30m" returns 5400000 and "1m30s" returns 90000.
- "30m1h", "1h1h" and "" throw `DurationError`.
- New tests cover the four cases above and all tests in the file pass.
```
