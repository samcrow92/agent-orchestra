---
name: orch-verify
description: Judge a worker's result and decide what to do when `orch verify` says REJECTED, a result has status FAILED or BLOCKED, the RESULT block is missing, or the worker's claims do not match the ground-truth section. Use before telling the user a task is done whenever anything about the result is not a clean VERIFIED.
---

# Verifying worker results

A worker's RESULT block is a claim. Two things are evidence: the `GROUND TRUTH` section that `orch` appends (exit code, files actually changed) and the output of `orch verify` (scope check, verify command, verdict). Report a task as done only on `VERIFIED`.

## Reading a result

Compare the worker's `files:` list with `files changed:` under ground truth.

- The worker lists files that ground truth does not: it described work it did not do. Treat as FAILED.
- Ground truth lists files the worker did not mention: read the diff stat for those files before anything else (`git -C <workdir> diff --stat`).
- `status: DONE` with `verify: ... not run`: the claim is unsupported until `orch verify` passes.

## Outcomes

**VERIFIED.** Update the state card if a decision or the next step changed, close the task, report.

**REJECTED, out of scope.** The worker changed files outside `scope`. Decide which is wrong. If the extra file was needed, the brief was too narrow: widen `scope`, and run `orch verify` again without re-dispatching. If it was not needed, ask the user before discarding changes, then dispatch a fix task whose goal is to revert those files.

**REJECTED, verify failed.** Read the tail that `orch verify` printed. Write a new task (do not re-dispatch the same brief unchanged): same scope, goal "Make `<verify>` pass", and put the failing output lines in Context. Say what the previous attempt did. Second rejection on a local worker: escalate (skill `orch-route`).

**No verify command.** `orch verify` refuses to mark the task verified. Add a `verify:` line to the brief, or a default to the project. If no automated check exists, dispatch a `role: read` task on a different worker to review the diff against the brief's "Done when" list, and tell the user the result was reviewed, not tested.

**FAILED, no RESULT block.** The worker ran out of turns, crashed, or ignored the contract. Read the last 40 lines of `log.txt` in the task directory, no more. Common causes: the harness or model is not running (run `orch doctor`), the task was too large for the model's context (split it), a timeout (`exit: 124`).

**BLOCKED.** The worker is telling you the brief is wrong or incomplete. That is the contract working. Fix the brief from its `notes:`, or ask the user if the answer is theirs to give, and dispatch again.

## What to tell the user

The verdict, the evidence in one line (`npm test -- quote -> exit 0`), the files changed, and anything they must decide. If the result is not VERIFIED, say so in the first sentence; a partial result reported as partial is useful, one reported as done is not.
