# Install runbook (for the installing agent)

You are installing Agent Orchestra on the user's Windows machine. This file is your complete instruction set; the person who wrote it is not available, so everything you need is here or in the files it names.

## What you are installing and why

Agent Orchestra lets the user talk to one orchestrator chat that runs coding tasks across several projects. The orchestrator writes short briefs; a Node CLI called `orch` hands each brief to a worker agent (pi with a local Qwen model, opencode, or GitHub Copilot CLI), captures a capped result, and checks it. The design goals are low token use and output that is verified, not claimed. `docs/how-it-works.html` shows the flow.

The bundle contains:

| Path | Purpose | Installed to |
| --- | --- | --- |
| `bin/orch.mjs` | dispatcher CLI and importable module | `%USERPROFILE%\.orchestra\app\`, exposed as `orch` through npm's global bin |
| `skills/orch-*` | five Agent Skills for the orchestrator | `%USERPROFILE%\.agents\skills\` |
| `assets/hub-AGENTS.md` | orchestrator instructions | `%USERPROFILE%\.orchestra\hub\AGENTS.md` |
| `assets/worker-contract.md` | rules prepended to every worker brief | `%USERPROFILE%\.orchestra\worker-contract.md` |
| `assets/config.example` | settings | `%USERPROFILE%\.orchestra\config` (never overwritten) |
| `templates/pi-models.*.json` | pi provider entries for a local model server | merged by you into `%USERPROFILE%\.pi\agent\models.json` |

`install.mjs` does the copying. Your job is the parts a script cannot do safely: checking what is already on the machine, configuring the local model, and proving the result works.

## Ground rules

- The user already has pieces of this running, including a Node web server that handles orchestration today. Do not stop, replace or reconfigure anything that exists. This install adds files in the locations above and nothing else. If a step would overwrite a file you did not create, stop and ask.
- Run commands in PowerShell. Paths below use PowerShell syntax (`$HOME`, `$env:USERPROFILE`).
- Do not install harnesses, model servers or models without asking. They are large, some need the user's login, and the user may have chosen versions on purpose. Report what is missing and let them decide.
- You cannot log in for the user. If `copilot` or a cloud provider in `opencode` is not authenticated, tell the user the exact command to run and continue with the rest.
- CLI flags of these tools change between releases. This runbook was written in November 2026. Where a step says "confirm with `--help`", do that instead of trusting the flag as written here; `orch doctor` automates most of it.
- Finish every step you can. Collect questions for the user and ask them together at the points marked **Ask**.

## Step 1: Inventory

Run each and note the result. Missing tools are findings, not failures.

```powershell
node --version          # need 18 or newer; required
npm --version           # required
git --version           # required
pi --version
opencode --version
copilot --version
rg --version            # ripgrep; workers search with it
```

Find the local model server. Try each; the one that answers is the one in use:

```powershell
curl.exe -s http://localhost:11434/v1/models    # Ollama
curl.exe -s http://localhost:8080/v1/models     # llama.cpp llama-server
curl.exe -s http://localhost:1234/v1/models     # LM Studio
```

Note the base URL that answered and the Qwen model id in its response. If the user runs the server on another port or host, ask.

Look at what exists so you do not overwrite it:

```powershell
Test-Path $HOME\.orchestra
Test-Path $HOME\.agents\skills
Get-ChildItem $HOME\.agents\skills -ErrorAction SilentlyContinue | Select-Object Name
Test-Path $HOME\.pi\agent\models.json
```

If `$HOME\.orchestra` exists and was not created by an earlier run of this installer (no `app\bin\orch.mjs` inside), stop and ask the user: it may belong to their existing server.

**Ask** (once, together):

1. Which harness should host the orchestrator chat: `opencode` or `copilot`? (A strong cloud model is recommended for the orchestrator; local Qwen is for workers.)
2. Which model should each cloud worker use by default, if not the harness's own default?
3. Anything from the inventory that is missing and that they want you to install.

If Node 18+, npm or git is missing, stop here: the user must install them first (`winget install OpenJS.NodeJS.LTS`, `winget install Git.Git`).

## Step 2: Run the installer

From the bundle directory:

```powershell
node install.mjs --dry-run
```

Read the output. Every line is `create`, `update` or `keep` plus a path. Confirm each path is under `$HOME\.orchestra` or `$HOME\.agents\skills\orch-*`. Then:

```powershell
node install.mjs
```

The last step runs `npm install -g` on `$HOME\.orchestra\app` to put `orch` on PATH. If it fails (permissions, a managed npm prefix), the files are still installed; tell the user, and use `node $HOME\.orchestra\app\bin\orch.mjs` wherever this runbook says `orch`.

Check:

```powershell
orch --help
```

## Step 3: Point pi at the local Qwen model

Skip this step if `pi --list-models` already shows the user's local Qwen model.

pi reads custom providers from `$HOME\.pi\agent\models.json`. Templates are in `templates\`: `pi-models.ollama.json` for Ollama, `pi-models.llamacpp.json` for llama.cpp (for LM Studio, use the llama.cpp template with base URL `http://localhost:1234/v1`).

- If `models.json` does not exist: copy the matching template there.
- If it exists: merge the template's provider object into the existing `providers` object. Keep everything already in the file. Do not replace the file.

Then set, in the entry you added:

- `id`: the exact model id the server reported in Step 1.
- `contextWindow`: the context size the server actually runs the model with, not the model's theoretical maximum. This matters: Ollama defaults to a small context unless configured, and a mismatch makes the worker lose its instructions silently. For Ollama, check the model's `num_ctx` (`ollama show <id>`) and ask the user to raise it to at least 32768 if it is lower (setting the `OLLAMA_CONTEXT_LENGTH` environment variable for the Ollama service is the usual way; confirm against the current Ollama documentation). For llama.cpp it is the `-c` / `--ctx-size` value the server was started with.
- `maxTokens`: 8192 is a safe default.
- If the model is a thinking variant and pi shows raw thinking text in output, set `"reasoning": true` on the model entry. Leave it `false` otherwise.

Test pi alone before involving `orch`:

```powershell
pi --list-models qwen
pi -p --no-session --model "<provider>/<id>" "Reply with the single word: ready"
```

It must print `ready` (case and punctuation aside). If it errors, fix this before continuing: check the base URL, the id, and that the server is running. Do not proceed with a broken local model; report it instead.

## Step 4: Configure orch

Edit `$HOME\.orchestra\config`. Each line is `KEY=value`.

- `ORCH_DEFAULT_WORKER=pi`
- `ORCH_HUB_HARNESS=` the user's answer from Step 1 (`opencode` or `copilot`).
- `ORCH_PI_MODEL=` the `<provider>/<id>` that worked in Step 3.
- `ORCH_LOCAL_URL=` the base URL that answered in Step 1, ending in `/v1`.
- `ORCH_OPENCODE_MODEL=` and `ORCH_COPILOT_MODEL=` the user's answers, or empty for the harness default.

Leave the limits at their defaults.

## Step 5: Doctor

```powershell
orch doctor
```

Read every line.

- `MISSING` on a harness or the local endpoint: resolve it or report it. A harness the user does not have is reported as `WARN`, which is fine as long as nothing routes to it.
- `WARN ... NOT FOUND` on a flag: that harness's CLI has changed. Run its `--help`, find the current equivalent, and update the matching branch of `workerCommand()` in `$HOME\.orchestra\app\bin\orch.mjs`. The intent of each flag:
  - pi: `-p` print mode; `--no-session` no saved session; `--no-skills` do not load skills (the brief carries everything); `--tools` allowlist (read-only tasks get `read,grep,find,ls`); `--model`.
  - opencode: `run` non-interactive; `--model provider/model`; `--agent plan` for read-only tasks (if the installed version has no read-only built-in agent, set `ORCH_OPENCODE_READ_AGENT=` empty in the config).
  - copilot: `-p` prompt; `-s` response only; `--no-ask-user`; `--allow-all-tools` with `--deny-tool` rules for `git push`, `rm`, and `write` on read-only tasks; `--model=`.
  Tell the user what you changed.
- `MISSING rg`: offer `winget install BurntSushi.ripgrep.MSVC`.

## Step 6: Prove it end to end

Use a throwaway repository so nothing of the user's is touched.

```powershell
$t = Join-Path $env:TEMP "orch-smoke"
Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $t | Out-Null
Set-Location $t
git init -q
"hello" | Set-Content greeting.txt
git add .; git -c user.email=smoke@test -c user.name=smoke commit -qm init
orch project add smoke $t "node -e `"process.exit(require('fs').readFileSync('greeting.txt','utf8').includes('world')?0:1)`""
orch task new smoke add-world
```

Write this into the brief file that `task new` printed (replace its contents):

```
goal: Change the text in greeting.txt from "hello" to "hello world".
scope: greeting.txt
verify:
role: edit
---
## Context
- greeting.txt — one line of text.

## Constraints
- Change only that line.

## Done when
- greeting.txt contains "hello world".
```

Then:

```powershell
orch dispatch smoke/001-add-world
orch verify smoke/001-add-world
```

Expected: the dispatch output ends with a `### RESULT` block with `status: DONE` and a `GROUND TRUTH` section listing `greeting.txt`; verify prints `VERIFIED`.

If it does not:

- No RESULT block and `exit: 127`: the harness binary was not found from Node. Check `ORCH_PI_BIN` (set it to the full path of `pi.cmd` if needed).
- No RESULT block, exit 0: read the last 40 lines of `log.txt` in the task directory. The local model probably lost the contract: recheck `contextWindow` and the server's real context size from Step 3.
- `exit: 124`: timeout. The model is too slow or stuck; note the model and hardware for the user.
- RESULT present but `REJECTED`: the worker did something else. Read `orch result smoke/001-add-world` and report it; do not keep retrying.

Run the same smoke task once with each other installed harness (`orch task new smoke again`, same brief with goal and criteria changed to append " again", then `orch dispatch smoke/002-again --worker opencode`). A harness that is not logged in will fail here: give the user the login command and move on.

Clean up: remove the `smoke` entry from `$HOME\.orchestra\projects.json`, delete `$HOME\.orchestra\projects\smoke` and the temp directory.

## Step 7: Check the skills are visible

In each installed harness, confirm the five `orch-*` skills are found:

- Copilot CLI: `copilot skill list`
- opencode and pi: start the harness in `$HOME\.orchestra\hub` and ask "which skills whose name starts with orch- do you have?" or use the harness's skills listing command.

All three read `%USERPROFILE%\.agents\skills`. If one does not, copy the five `orch-*` directories into that harness's own skills directory (`%USERPROFILE%\.config\opencode\skills`, `%USERPROFILE%\.pi\agent\skills`, `%USERPROFILE%\.copilot\skills`) and say so in your report.

## Step 8: The user's Node web server

The user's existing server handles orchestration today. Do not modify it as part of the install. Connecting it to Agent Orchestra is a separate job with its own runbook: `INTEGRATE.md`. When the smoke test above has passed, tell the user the install is done and ask whether they want you to continue with `INTEGRATE.md` now.

## Optional tools (ask before installing)

- `ast-grep` (`npm install -g @ast-grep/cli`): structural code search; cheaper and more exact than regex for "find all callers of X".
- RTK (shell-output compression for agents): its automatic command rewriting is reported not to work on native Windows, only under WSL. Skip it unless the user runs the harnesses in WSL.

## Report to the user

Lead with whether the end-to-end smoke test passed, and with which workers. Then:

- what was installed and where;
- what you changed outside the install script (models.json entries, config values, any edit to `workerCommand()`);
- what is missing or needs their action (logins, a context-size setting, a harness to install), each with the exact command;
- how to start: `orch chat`, then tell the orchestrator about a project ("register my project at C:\code\foo, tests run with npm test").

If something failed and you could not fix it, say that plainly with the output you saw.

## Uninstall

```powershell
npm uninstall -g agent-orchestra
Remove-Item $HOME\.agents\skills\orch-* -Recurse
Remove-Item $HOME\.orchestra -Recurse      # also deletes project state cards and task history: ask first
```

Remove the provider entry you added to `$HOME\.pi\agent\models.json` by hand.
