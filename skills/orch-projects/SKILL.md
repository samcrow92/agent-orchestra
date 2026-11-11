---
name: orch-projects
description: Register a project with the orchestrator and write or update its state card (STATE.md). Use when the user names a project that `orch project list` does not show, when a state card is empty or stale, or after a task changes a project's conventions, layout, decisions or next steps.
---

# Projects and state cards

Each project has one state card. It is the only thing about the project you load into the orchestrator chat, so it decides how good your briefs are and how many tokens every session costs. Keep it under 60 lines.

## Register

```
orch project add <name> <absolute-path> "<verify-cmd>"
```

`name` is lowercase kebab-case. `verify-cmd` is the project's default check (test or build command), used when a brief has no `verify:` line. Ask the user for the path and the command if they did not give them; do not guess a test command.

The command creates `<orch home>/projects/<name>/STATE.md` and prints its path.

## Fill the card

Do not read the codebase in this chat to fill it. Dispatch a scout:

```
orch task new <name> map-project
```

with `role: read`, goal "Report what this project is, its layout, how to build and test it, and the conventions visible in the code", and done-when "RESULT gives: purpose in two lines; top-level directories with one clause each; build, test and lint commands as they appear in the project's config; five or fewer conventions with a file:line example each."

Write the card from the scout's result, in these sections:

- **What it is**: two lines. Language, framework, what it does.
- **Conventions workers must follow**: the few rules a newcomer would break. You copy the relevant ones into briefs.
- **Map**: where things live, paths only. `src/api/ — HTTP handlers, one file per resource`.
- **Decisions**: dated, newest first, one line each, with the reason. `2026-11-10 retries live in the client wrapper, not per call — one place to tune`.
- **Next**: what is in flight or queued.

## Keep it current

After a verified task, update the card only if a convention, the map, a decision or the next step changed. Replace lines; do not append a history. Task history already lives in the task directories and `orch status`.

When the card and the code disagree, the code is right: fix the card.

## Switching projects

`orch project show <name>` prints the card and open tasks. When you switch projects in a long chat, write a handoff first (skill `orch-handoff`), so the previous project's details stop occupying context.
