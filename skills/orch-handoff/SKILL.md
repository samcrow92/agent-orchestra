---
name: orch-handoff
description: Write a handoff file so the orchestrator chat can restart with a fresh context and lose nothing. Use when the chat is getting long, before switching to a different project, when the user says to wrap up or continue later, or at the start of a session to resume from an existing HANDOFF.md.
---

# Handoff

A long orchestrator chat costs more on every turn and gets less reliable. State lives on disk, so a restart is cheap: the handoff carries only what disk does not already hold.

## Write

Write `HANDOFF.md` in the hub directory (the directory this chat runs in), replacing any previous one. Forty lines or fewer:

```
# Handoff <date and time>

## Active
<project>: <what the user is trying to get done, one or two lines>

## In flight
<project>/<task> — <status> — <what to do next with it>

## Decided this session (not yet in a state card)
- <decision> — <reason>

## Waiting on the user
- <question or approval>

## Next action
<the single next step, as a command or a sentence>
```

Rules:

- Point, do not copy. Task ids and paths stand for their content; the next session reads `orch result <id>` if it needs it.
- Move durable decisions into the project's state card first (skill `orch-projects`), then list here only what is still unsettled.
- Leave out what `orch status` and the state cards already show.
- Record what the user asked for in their words where the wording matters (an exact name, a constraint).

Then tell the user: the handoff is written, and they should start a new chat (`orch chat`) to continue.

## Resume

At the start of a session, if `HANDOFF.md` exists in the hub directory: read it, run `orch status` for the active project, and continue from "Next action". Confirm with the user in one line what you are resuming. Do not re-read results of tasks that are already closed.
