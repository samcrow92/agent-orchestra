---
name: orch-route
description: Split a request into worker tasks and choose the worker (local Qwen via pi, opencode, or Copilot CLI) and whether to run tasks in parallel. Use before creating tasks for any request that is more than one obvious small change, or when unsure which worker should take a task.
---

# Splitting work and choosing a worker

## Split

A task is the right size when one worker can finish it in one run and one `verify` command can prove it:

- one goal, a handful of files (about five or fewer), one verify command;
- no decision left open that the user or you should make.

Make the decisions first, then hand out the execution. Design choices, API shapes and naming go into the brief as constraints. A worker that has to choose an architecture will choose one, and the next worker will choose another.

Order tasks so each one leaves the project passing its checks. When task B needs what task A produced, dispatch B after A is verified, and put A's outcome (the new function name, the file it lives in) into B's context section yourself. Workers do not see each other's results.

If you lack the facts to split, dispatch a read-only scout (`role: read`) and split from its result.

## Choose the worker

Default to the cheapest worker that will get it right the first time. A failed local run costs time; a retry on a cloud worker costs money. One retry on local is fine; after that, escalate.

| Task shape | Worker |
| --- | --- |
| Fully specified, one to three files, pattern exists nearby: add a test, apply a known fix, rename, add a field end to end, write docs from code | `pi` (local Qwen) |
| Read-only scouting: where is X, what calls Y, summarise this module | `pi` (local Qwen), `role: read` |
| Several files with judgment needed, unfamiliar library, subtle bug with unknown cause, concurrency, security-sensitive code | `opencode` or `copilot` with a strong model |
| Local worker returned FAILED or was REJECTED twice on the same task | escalate to `opencode` or `copilot`, and say in the brief what was tried |

Between `opencode` and `copilot`, use whichever has the model and quota the user prefers for the job (`--model` overrides the configured default). If the user has stated a preference, it is in the project state card or the hub notes; follow it.

Local Qwen works best when the brief names exact files and line ranges, shows the pattern to copy, and keeps the change small. If you cannot write that brief, the task is not a local task yet.

## Parallel or serial

Run tasks in parallel only when their scopes do not overlap and neither needs the other's result:

```
orch task new <p> <slug> --worktree     # each parallel task gets its own git worktree and branch
orch dispatch <p>/<task> --bg
orch status <p>                         # poll; `returned` or `failed` means it finished
```

Poll at a sensible interval instead of in a tight loop; each poll costs a turn. One local model serves one request at a time on most machines, so parallel `pi` workers queue behind each other. Parallelism pays off across different workers, or across cloud workers.

Worktree tasks leave their changes uncommitted on branch `orch/<task>`. After `VERIFIED`, tell the user which branches are ready. Merging is the user's decision.

Without `--worktree`, tasks share the project directory: run them one at a time.
