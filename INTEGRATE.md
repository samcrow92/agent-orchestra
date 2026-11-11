# Integration runbook (for the integrating agent)

You are connecting Agent Orchestra to the user's existing Node web server, which already handles agent orchestration on this Windows machine. Do this after `INSTALL.md` has been completed and its smoke test passed. If it has not, do that first.

The author of this bundle has never seen the user's server. Nothing here assumes its framework, file layout or data model. Your first job is to learn those; the second is to propose a fit; the third, after the user agrees, is to build it.

## What the user wants

One orchestration system, not two. The server keeps doing what it does; Agent Orchestra supplies the parts it is good at: validated briefs, one fresh worker per task across pi (local Qwen), opencode and Copilot CLI, capped results, and a verify gate that does not trust the worker. The priorities are low token use and output that is verified.

## Ground rules

- The server is the user's working system. Read before you change anything, work on a new git branch, and keep every change small enough to review. If the server's directory is not a git repository, tell the user and ask how they want changes tracked before editing.
- Do not restart, stop or redeploy a running server without asking.
- Do not change the server's existing behaviour, routes or stored data format. Add alongside.
- Do not copy `orch.mjs` into the server or rewrite its logic there. Import it or spawn it, so there is one implementation to keep correct.
- Stop and ask when the server already does something Agent Orchestra also does and it is unclear which should win (see Step 2).

## Step 1: Learn the server

Ask the user where the server's code is if you were not told. Then find out, by reading:

1. **Shape.** Entry file, framework (Express, Fastify, plain `http`, something else), module system (`"type": "module"` in `package.json`, or CommonJS), Node version, how it is started (script, service, pm2, a terminal).
2. **What "orchestration" means in it today.** How a task enters (HTTP route, websocket, UI form, chat), how it picks an agent or model, how it launches agents (child process, HTTP to a model server, an SDK), where it keeps task state (memory, files, a database), how results come back to the user.
3. **Projects.** Whether it has a notion of several projects or repositories, and where that list lives.
4. **Context handling.** What it sends to each agent: whole conversation, a summary, files. This is where most of the token cost is.
5. **Checking.** Whether anything verifies agent output before it is shown as done.
6. **Tests.** How the server's own tests run, if it has any.

Read the entry file and the modules that launch agents; search for `spawn`, `exec`, `fetch(`, `pi`, `opencode`, `copilot`, and the local model URL to find them. Do not read the whole codebase.

Write down what you found in ten lines or fewer. You will show it to the user in Step 2.

## Step 2: Map and propose

Compare the server with what Agent Orchestra provides:

| Concern | Agent Orchestra | Decide |
| --- | --- | --- |
| Project list | `projects.json` + a state card per project | If the server has its own list, keep the server's as the source of truth and register each project with `projectAdd` once (a sync step), or ask which should own it. |
| Task record | a directory per task: `brief.md`, `result.md`, `log.txt`, `status` | The server keeps its own task id and stores the orch task id (`<project>/<NNN-slug>`) next to it. |
| Launching agents | `dispatch` | Route the server's agent launches through `dispatch`, or only new ones, per the user's choice. |
| Context sent to agents | the worker contract + one brief, 80 lines at most | If the server sends conversation history to workers, this is the main saving. Say so. |
| Checking | `verify` (scope + command) | Usually new to the server. Surface the verdict in its API and UI. |
| Chat with the user | hub `AGENTS.md` + five skills in a harness | If the server has its own chat with an LLM orchestrator, see "If the server hosts the orchestrator chat" below. |

Then choose the integration depth to recommend. From least to most change:

- **A. Side by side.** The server gains read-only views of orch state (projects, tasks, results, verdicts). The user drives orch from `orch chat`. Smallest change; good first step.
- **B. Server dispatches through orch.** Where the server launches an agent today, it creates an orch task, writes the brief, calls `dispatch` and `verify`, and reports the verdict. The server's own launching code stays for anything not moved yet.
- **C. Server hosts the orchestrator.** The server's own LLM chat takes the orchestrator role, using the hub instructions and skills as its prompt material, and calls orch functions as tools.

Recommend the smallest one that gives the user what they asked for; B is the usual answer when the server already launches agents.

**Ask** the user, in one message: show your ten-line summary of the server, your recommended depth with the reason, the files you expect to touch, and any ownership question from the table. Wait for their answer before editing.

## Step 3: Build the adapter

Put everything in one new module in the server (for example `orchestra.js` next to its other service modules, following its naming and style). The rest of the server talks to that module, never to `orch.mjs` directly, so later changes stay in one file.

### Loading orch

`orch.mjs` is an ES module at `%USERPROFILE%\.orchestra\app\bin\orch.mjs`. On Windows an absolute path must be turned into a file URL before importing:

```js
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORCH_PATH = path.join(process.env.ORCH_HOME ?? path.join(os.homedir(), '.orchestra'), 'app', 'bin', 'orch.mjs');
const orch = await import(pathToFileURL(ORCH_PATH).href);
```

In a CommonJS server, `await import(...)` works inside an async function; top-level `await` does not. Load it once at startup and keep the reference.

`ORCH_HOME` is read when the module is first imported. Set it before that if the server should use a non-default location.

### The API

Every function returns a plain object and throws `orch.OrchError` for bad input (unknown project, invalid brief, task already running). Catch `OrchError` and return its `message` to the caller as a client error; let anything else propagate as a server error.

| Call | Returns |
| --- | --- |
| `projectList()` | `[{ name, path, verify }]` |
| `projectAdd(name, dir, verifyCmd)` | `{ name, path, verify, stateCard }` — `name` must be lowercase kebab-case |
| `projectShow(name)` | `{ name, stateCard, openTasks }` |
| `taskNew(project, slug, { worktree })` | `{ id, brief, workdir }` — `brief` is the path of the brief file to write |
| `await dispatch(id, { worker, model, bg })` | `{ id, status, exit, seconds, worker, files, result }`; with `bg: true` returns at once with `{ id, status: 'running', background: true }` |
| `result(id)` | `{ id, status, result }` |
| `verify(id)` | `{ id, verified, scope: { checked, allowed, outOfScope }, verify: { command, exit, tail } }` |
| `status(project?)` | `[{ id, status, goal }]` |
| `close(id)` | `{ id, status, worktree }` |
| `await doctor()` | `{ ok, missing, checks: [{ level, label }] }` |

Task `status` values: `new`, `running`, `returned`, `failed`, `verified`, `rejected`, `closed`.

### Things that will bite in a server

- **`verify` blocks.** It runs the project's verify command synchronously and can take minutes. Never call it on the request thread. Run it as a child process and parse the JSON:

  ```js
  import { execFile } from 'node:child_process';
  const runOrch = (args) => new Promise((resolve, reject) => {
    execFile(process.execPath, [ORCH_PATH, ...args, '--json'], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { reject(err ?? new Error('orch returned no JSON')); }
    });
  });
  const verdict = await runOrch(['verify', taskId]);   // exits 1 on REJECTED but still prints JSON
  ```

  `orch verify` exits with code 1 when the verdict is REJECTED; that is a result, not an error, which is why the snippet parses stdout before looking at `err`.
- **`dispatch` is long.** A worker run takes seconds to many minutes. Do not hold an HTTP request open for it. Either `await dispatch(...)` in a background job the server already has, or call it with `bg: true` and poll `status()` (or read the task's `status` file) on a timer of a few seconds. Report progress through whatever the server uses now (polling route, websocket, server-sent events).
- **A background run that dies leaves `running`.** If the machine reboots or the child is killed, the status file is never updated. Treat a task that has been `running` longer than `ORCH_TIMEOUT` (default 1800 s) plus a margin as failed, and show it that way.
- **One task per working directory at a time.** Two workers in the same repository overwrite each other. Queue per project, or create tasks with `{ worktree: true }` when running in parallel.
- **One local model, one request.** Parallel `pi` workers queue on the model server. Cap local concurrency at 1 unless the user's server is configured otherwise.
- **Briefs are validated.** `dispatch` throws if the brief has no goal, no scope (for edit tasks), no "Done when" criteria, or exceeds 80 lines. Surface that message; do not work around it by padding the brief.

### Writing briefs from the server

`taskNew` creates `brief.md` with empty fields. The server (or its LLM) writes the file at the returned `brief` path in this format:

```
goal: <one sentence>
scope: <space-separated path prefixes the worker may change>
verify: <command that exits 0 only when done; empty to use the project default>
role: edit            (or: read)
---
## Context
- <path:lines — why it matters>

## Constraints
- <what must not change; decisions already made>

## Done when
- <observable acceptance criterion>
```

`skills/orch-brief/SKILL.md` in this bundle is the full guide to writing a good one. If an LLM in the server writes briefs, give it that file's body as instructions. If briefs come from a form in the UI, make goal, scope and done-when required fields.

The verify command runs through `cmd.exe` on Windows. Use the project's own scripts (`npm test -- name`), not Unix tools.

### If the server hosts the orchestrator chat (depth C)

- Use `assets/hub-AGENTS.md` as the base of the orchestrator's system prompt. Replace the "Commands" section with the names of the tools you expose.
- Expose these as tools, each a thin wrapper over the adapter: `project_list`, `project_show`, `task_new` (returns the brief path and takes the brief text to write), `dispatch`, `result`, `verify`, `status`, `close`.
- Give the model the five skills on demand, not all at once: put each skill's `description` line in the system prompt and add a `load_skill(name)` tool that returns the body of `skills/<name>/SKILL.md`. Loading all five up front costs about 240 lines of context on every turn.
- Keep tool results small. Return the `result` string and the verify verdict; never return `log.txt` or file contents.
- Do not send the chat history to workers. The brief is the whole handoff.

## Step 4: Expose it

Follow the server's existing route and response conventions. If it has none to follow, this is a reasonable minimum:

```
GET  /orchestra/projects                      -> projectList()
GET  /orchestra/projects/:name                -> projectShow(name)
GET  /orchestra/tasks?project=                -> status(project)
POST /orchestra/tasks        {project, slug, brief, worktree?}  -> taskNew + write brief
POST /orchestra/tasks/:id/dispatch  {worker?, model?}           -> dispatch(bg: true)
GET  /orchestra/tasks/:id/result              -> result(id)
POST /orchestra/tasks/:id/verify              -> verify (child process)
POST /orchestra/tasks/:id/close               -> close(id)
```

The task id contains a slash (`shop/003-cart-tax`); URL-encode it or split it into two route parameters.

Dispatch runs code-editing agents on the user's machine. If the server listens on anything other than localhost, or has no authentication, tell the user before adding the write routes, and put them behind whatever access control the server already has.

In the UI, show for each task: goal, worker, status, the verdict, the files changed and the verify output tail. A task that is `returned` but not `verified` must not look finished.

## Step 5: Prove it

1. Run the server's existing tests, if any, before and after. Nothing that passed before may fail after.
2. Start the server the way the user does (ask first if that means restarting a running one).
3. Repeat the smoke test from `INSTALL.md` Step 6 through the server's new routes instead of the CLI: register a throwaway repository, create a task with the `greeting.txt` brief, dispatch, poll until the status leaves `running`, verify. Expect `verified: true`.
4. Send one invalid brief (empty goal) and confirm the server returns the validation message as a client error, not a crash.
5. Confirm an existing feature of the server still works end to end, the one the user uses most.
6. Remove the throwaway project and task data.

If a step fails, fix the adapter, not `orch.mjs`. If you believe `orch.mjs` itself is wrong, show the user the evidence and the change you propose before editing it; a change there must be made in `%USERPROFILE%\.orchestra\app\bin\orch.mjs` and in the bundle copy so a reinstall does not undo it.

## Report to the user

Lead with whether the smoke test passed through the server. Then:

- the integration depth built and what the server can now do that it could not;
- the files added or changed, on which branch, with nothing committed or merged unless they asked;
- what was left on the server's old path and why;
- anything that needs their decision: project-list ownership, exposure of write routes, restart of a running service;
- what you could not verify.
