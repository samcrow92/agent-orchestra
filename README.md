# Agent Orchestra

One orchestrator chat for all your projects. It writes short briefs, a Node dispatcher (`orch`) hands them to worker agents, and nothing counts as done until a check passes.

Workers: **pi** with a local Qwen model, **opencode**, **GitHub Copilot CLI**. Runs on Windows, macOS and Linux; needs Node 18+ and git.

Open [docs/how-it-works.html](docs/how-it-works.html) for the diagram.

## Install

Give this folder to a Sonnet-class agent on the target machine and say: "Follow INSTALL.md." The runbook covers inventory, install, local model setup, a doctor check and an end-to-end smoke test.

By hand: `node install.mjs`, edit `~/.orchestra/config`, `orch doctor`.

To connect it to an existing Node orchestration server, have the agent follow [INTEGRATE.md](INTEGRATE.md) afterwards: it reads the server first, proposes how deep to integrate, and builds one adapter module after you agree.

## Use

```
orch chat
```

opens the orchestrator in the hub directory. Talk to it: "register my project at C:\code\shop, tests run with npm test", then "in shop, make the cart total include tax". It does the rest through:

```
orch project add|list|show      orch task new <project> <slug> [--worktree]
orch dispatch <project>/<task> [--worker pi|opencode|copilot] [--model M] [--bg]
orch result | verify | close <project>/<task>      orch status [project]      orch doctor
```

Add `--json` to any command for machine output, or import the module from your own Node server:

```js
import * as orch from '~/.orchestra/app/bin/orch.mjs'; // use the absolute path
const t = orch.taskNew('shop', 'cart-tax');
// write t.brief, then:
const r = await orch.dispatch(t.id, { worker: 'pi' });
const v = orch.verify(t.id);   // v.verified === true only if scope and verify command pass
```

## What is in the bundle

| Piece | What it does |
| --- | --- |
| `bin/orch.mjs` | Dispatcher. Validates briefs, runs one fresh worker per task, caps the result at 60 lines, measures changed files itself, runs the verify gate. No dependencies. |
| `assets/hub-AGENTS.md` | The orchestrator's standing instructions (about 35 lines, the only always-loaded context). |
| `assets/worker-contract.md` | Rules and the fixed `### RESULT` format prepended to every brief. Written for small local models. |
| `skills/orch-brief` | How to write a brief a context-free worker can execute. |
| `skills/orch-route` | Task splitting, worker choice (local vs cloud), parallel worktrees, escalation. |
| `skills/orch-verify` | Reading results against ground truth; what to do on REJECTED, FAILED, BLOCKED. |
| `skills/orch-projects` | Registering projects and keeping the 60-line state card. |
| `skills/orch-handoff` | Restarting a long chat from a 40-line file. |
| `templates/` | pi `models.json` entries for Ollama and llama.cpp. |

Skills follow the Agent Skills standard (`SKILL.md`) and install to `~/.agents/skills`, which pi, opencode and Copilot CLI all read.

## Design choices and where they come from

- **Fresh worker per task, brief as the only context, capped structured result.** Sub-agent isolation is the main lever for keeping an orchestrator's context small; handoff files that point to artifacts instead of copying them are the same idea applied to sessions (Matt Pocock's handoff skill, obra/superpowers' subagent-driven development).
- **Guards for small models.** The worker contract's read-before-edit, edit-not-rewrite, scoped tools and fixed output block follow what [little-coder](https://github.com/itayinbarr/little-coder) found necessary to make Qwen-class models reliable on pi.
- **Evidence measured outside the worker.** Changed files and the verify exit code come from `orch`, never from the worker's own report.
- **No output-compression layer by default.** A July 2026 study (arXiv 2607.12161) found compressing tool output did not reliably reduce billed cost; keeping transcripts out of the orchestrator entirely is the larger and safer saving. RTK also does not auto-rewrite on native Windows.
- **One shared skills directory.** `.agents/skills` is read by all three harnesses, so there is one copy to maintain.

## Limits to know

- The dispatcher's harness flags were checked against the pi 0.81 README, the Copilot CLI programmatic reference and `opencode run --help` in November 2026. `orch doctor` re-checks them against the installed versions and tells you which to update.
- It has been tested end to end with a stub worker on macOS, not yet against real harnesses on Windows. The install runbook's smoke test is that check.
- Read-only tasks are enforced by tool allowlists on pi and deny rules on Copilot; on opencode they rely on the `plan` agent.
- If a file was already modified and uncommitted before a task, further changes to it by the worker are not detected by the scope check. Use `--worktree` or commit first when that matters.
- One local model serves one request at a time on most machines; parallel local workers queue.

## Sources

- pi coding agent README and model docs: https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/README.md , https://cdn.jsdelivr.net/npm/@earendil-works/pi-coding-agent@0.81.1/docs/models.md
- opencode skills: https://opencode.ai/docs/skills/ , CLI: https://opencode.ai/docs/cli/
- Copilot CLI programmatic reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference , skills: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
- little-coder: https://github.com/itayinbarr/little-coder
- Orchestrator landscape: https://github.com/andyrewlee/awesome-agent-orchestrators , https://github.com/standardagents/dmux , https://github.com/jcarlosrodicio/opencode-agent-orchestration-kit
- Skills roundups (handoff, superpowers): https://www.firecrawl.dev/blog/best-opencode-skills
- Token tooling: https://github.com/rtk-ai/rtk , https://www.rtk-ai.app/docs/getting-started/supported-agents/ , https://arxiv.org/pdf/2607.12161
