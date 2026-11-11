#!/usr/bin/env node
// orch — file-backed dispatcher for multi-project agent orchestration.
// Workers: pi (local Qwen), opencode, copilot. State lives in ORCH_HOME.
// Node 18+, no dependencies. Works on Windows, macOS, Linux.
// Usable as a CLI (`orch ...`, add --json for machine output) or as a module:
//   import * as orch from './orch.mjs'

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
export const HOME = process.env.ORCH_HOME || path.join(os.homedir(), '.orchestra');
const SELF = fileURLToPath(import.meta.url);
const TASK_FILE = '.orch/task.md';
const WORKER_PROMPT = `Read the file ${TASK_FILE} in the current directory and follow it exactly.`;

const DEFAULTS = {
  ORCH_DEFAULT_WORKER: 'pi',
  ORCH_HUB_HARNESS: 'opencode',
  ORCH_PI_BIN: 'pi',
  ORCH_OPENCODE_BIN: 'opencode',
  ORCH_COPILOT_BIN: 'copilot',
  ORCH_PI_MODEL: '',
  ORCH_OPENCODE_MODEL: '',
  ORCH_COPILOT_MODEL: '',
  ORCH_OPENCODE_READ_AGENT: 'plan',
  ORCH_LOCAL_URL: 'http://localhost:11434/v1',
  ORCH_TIMEOUT: '1800',
  ORCH_BRIEF_MAX_LINES: '80',
  ORCH_RESULT_MAX_LINES: '60',
};

export class OrchError extends Error {}
const fail = (msg) => { throw new OrchError(msg); };

// ---------- config & storage ----------

export function config() {
  const c = { ...DEFAULTS };
  const f = path.join(HOME, 'config');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m || !(m[1] in c)) continue;
      c[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  for (const k of Object.keys(c)) if (process.env[k] !== undefined) c[k] = process.env[k];
  return c;
}

const regFile = () => path.join(HOME, 'projects.json');
const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const readOr = (f, d = '') => (fs.existsSync(f) ? read(f) : d);

function registry() {
  if (!fs.existsSync(regFile())) fail('not initialised — run: orch init');
  return JSON.parse(read(regFile()));
}

function project(name) {
  const p = registry()[name];
  if (!p) fail(`unknown project: ${name}`);
  return p;
}

function taskDir(id) {
  const i = String(id || '').indexOf('/');
  if (i < 1 || i === id.length - 1) fail('task id must be <project>/<task>');
  const d = path.join(HOME, 'projects', id.slice(0, i), 'tasks', id.slice(i + 1));
  if (!fs.existsSync(d)) fail(`no such task: ${id}`);
  return d;
}

function briefField(d, key) {
  const m = read(path.join(d, 'brief.md')).match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

const getStatus = (d) => readOr(path.join(d, 'status'), '?').trim();
const setStatus = (d, s) => write(path.join(d, 'status'), s + '\n');

// ---------- process helpers ----------

// npm-installed CLIs are .cmd shims on Windows and need a shell; quote args ourselves.
const quote = (a) => (/[\s()&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function spawnCli(bin, args, opts) {
  return WIN ? spawn([bin, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawn(bin, args, opts);
}

function runCliSync(bin, args, opts = {}) {
  return WIN
    ? spawnSync([bin, ...args].map(quote).join(' '), { encoding: 'utf8', ...opts, shell: true })
    : spawnSync(bin, args, { encoding: 'utf8', ...opts });
}

function git(dir, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', dir, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), raw: r.stdout || '' };
}

const isGit = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree']).ok;

function killTree(child) {
  if (!child.pid) return;
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

function changedFiles(dir) {
  const r = git(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok || !r.raw.trim()) return [];
  return [...new Set(r.raw.split('\n').filter(Boolean).map((l) => {
    let f = l.slice(3);
    const i = f.indexOf(' -> ');
    if (i >= 0) f = f.slice(i + 4);
    return f.replace(/^"(.*)"$/, '$1');
  }).filter((f) => f && !f.startsWith('.orch/')))].sort();
}

function taskChanges(d, wd) {
  const pre = new Set(readOr(path.join(d, 'pre.files')).split('\n').filter(Boolean));
  const out = new Set(changedFiles(wd).filter((f) => !pre.has(f)));
  const head = readOr(path.join(d, 'pre.head')).trim();
  if (head) {
    const r = git(wd, ['diff', '--name-only', head, 'HEAD']);
    if (r.ok && r.out) r.out.split('\n').forEach((f) => out.add(f));
  }
  return [...out].sort();
}

// ---------- commands ----------

export function init() {
  for (const s of ['projects', 'hub', 'worktrees']) fs.mkdirSync(path.join(HOME, s), { recursive: true });
  if (!fs.existsSync(regFile())) write(regFile(), '{}\n');
  return { home: HOME };
}

export function projectAdd(name, dir, verify = '') {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name || '')) fail('project name must be lowercase kebab-case');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`no such directory: ${dir}`);
  const reg = registry();
  if (reg[name]) fail(`project exists: ${name}`);
  const abs = path.resolve(dir);
  reg[name] = { path: abs, verify };
  write(regFile(), JSON.stringify(reg, null, 2) + '\n');
  fs.mkdirSync(path.join(HOME, 'projects', name, 'tasks'), { recursive: true });
  const card = path.join(HOME, 'projects', name, 'STATE.md');
  if (!fs.existsSync(card)) {
    write(card, [
      `# ${name}`, `path: ${abs}`, `verify: ${verify || '<none>'}`, '',
      '## What it is', '-', '',
      '## Conventions workers must follow', '-', '',
      '## Map (where things live — paths only)', '-', '',
      '## Decisions (dated, newest first)', '-', '',
      '## Next', '-', '',
    ].join('\n'));
  }
  return { name, path: abs, verify, stateCard: card };
}

export function projectList() {
  return Object.entries(registry()).map(([name, p]) => ({ name, ...p }));
}

export function projectShow(name) {
  project(name);
  return {
    name,
    stateCard: readOr(path.join(HOME, 'projects', name, 'STATE.md')),
    openTasks: status(name).filter((t) => t.status !== 'closed'),
  };
}

export function taskNew(proj, slug, { worktree = false } = {}) {
  const p = project(proj);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug || '')) fail('slug must be lowercase kebab-case');
  const tasks = path.join(HOME, 'projects', proj, 'tasks');
  fs.mkdirSync(tasks, { recursive: true });
  const n = fs.readdirSync(tasks, { withFileTypes: true }).filter((e) => e.isDirectory()).length + 1;
  const tid = `${String(n).padStart(3, '0')}-${slug}`;
  const d = path.join(tasks, tid);
  fs.mkdirSync(d);
  let wd = p.path;
  if (worktree) {
    if (!isGit(p.path)) fail(`--worktree needs a git repo: ${p.path}`);
    wd = path.join(HOME, 'worktrees', proj, tid);
    fs.mkdirSync(path.dirname(wd), { recursive: true });
    const r = spawnSync('git', ['-C', p.path, 'worktree', 'add', '-q', '-b', `orch/${tid}`, wd], { encoding: 'utf8' });
    if (r.status !== 0) fail(`git worktree add failed: ${(r.stderr || '').trim()}`);
    write(path.join(d, 'branch'), `orch/${tid}\n`);
  }
  write(path.join(d, 'workdir'), wd + '\n');
  setStatus(d, 'new');
  const brief = path.join(d, 'brief.md');
  write(brief, [
    'goal:', 'scope:', 'verify:', 'role: edit', '---',
    '## Context', '-', '', '## Constraints', '-', '', '## Done when', '-', '',
  ].join('\n'));
  return { id: `${proj}/${tid}`, brief, workdir: wd };
}

export function validateBrief(d) {
  const text = read(path.join(d, 'brief.md'));
  if (!briefField(d, 'goal')) fail('brief: goal is empty');
  const role = briefField(d, 'role') || 'edit';
  if (!['edit', 'read'].includes(role)) fail('brief: role must be edit or read');
  if (role === 'edit' && !briefField(d, 'scope')) {
    fail('brief: scope is empty — list the path prefixes the worker may touch');
  }
  const done = text.split(/^## Done when[^\n]*\n/m)[1];
  if (done === undefined) fail("brief: missing '## Done when' section");
  if (!/[A-Za-z0-9]/.test(done.split(/^## /m)[0])) fail("brief: 'Done when' has no acceptance criteria");
  const max = Number(config().ORCH_BRIEF_MAX_LINES);
  const lines = text.split('\n').length;
  if (lines > max) fail(`brief is ${lines} lines (max ${max}) — point to files, don't paste them`);
  return role;
}

function workerCommand(worker, role, model, c) {
  if (worker === 'pi') {
    const tools = role === 'read' ? 'read,grep,find,ls' : 'read,bash,edit,write,grep,find,ls';
    const args = ['-p', '--no-session', '--no-skills', '--tools', tools];
    if (model) args.push('--model', model);
    return [c.ORCH_PI_BIN, [...args, WORKER_PROMPT]];
  }
  if (worker === 'opencode') {
    const args = ['run'];
    if (model) args.push('--model', model);
    if (role === 'read' && c.ORCH_OPENCODE_READ_AGENT) args.push('--agent', c.ORCH_OPENCODE_READ_AGENT);
    return [c.ORCH_OPENCODE_BIN, [...args, WORKER_PROMPT]];
  }
  const args = ['-p', WORKER_PROMPT, '-s', '--no-ask-user', '--allow-all-tools',
    '--deny-tool=shell(git push)', '--deny-tool=shell(rm)'];
  if (role === 'read') args.push('--deny-tool=write');
  if (model) args.push(`--model=${model}`);
  return [c.ORCH_COPILOT_BIN, args];
}

function excludeOrchDir(wd) {
  const r = git(wd, ['rev-parse', '--git-path', 'info/exclude']);
  if (!r.ok) return;
  const f = path.resolve(wd, r.out);
  const cur = readOr(f);
  if (!/^\.orch\/$/m.test(cur)) write(f, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.orch/\n');
}

export async function dispatch(id, { worker, model, bg = false } = {}) {
  const c = config();
  worker = worker || c.ORCH_DEFAULT_WORKER;
  if (!['pi', 'opencode', 'copilot'].includes(worker)) fail('worker must be pi, opencode or copilot');
  const d = taskDir(id);
  const role = validateBrief(d);
  if (getStatus(d) === 'running' && !process.env.ORCH_BG_CHILD) fail(`${id} is already running`);
  model = model || c[`ORCH_${worker.toUpperCase()}_MODEL`] || '';

  if (bg) {
    setStatus(d, 'running');
    const args = [SELF, 'dispatch', id, '--worker', worker];
    if (model) args.push('--model', model);
    spawn(process.execPath, args, {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ORCH_BG_CHILD: '1' },
    }).unref();
    return { id, status: 'running', worker, background: true };
  }

  const wd = read(path.join(d, 'workdir')).trim();
  if (!fs.existsSync(wd)) fail(`workdir missing: ${wd}`);
  const contract = path.join(HOME, 'worker-contract.md');
  if (!fs.existsSync(contract)) fail(`missing ${contract} (re-run the installer)`);

  let prompt = `${read(contract).trimEnd()}\n\n## BRIEF\nworkdir: ${wd}\n${read(path.join(d, 'brief.md'))}`;
  if (role === 'read') prompt += '\nThis is a READ-ONLY task: do not create, modify or delete any file.\n';
  write(path.join(d, 'prompt.md'), prompt);

  const git_ = isGit(wd);
  if (git_) {
    excludeOrchDir(wd);
    write(path.join(d, 'pre.files'), changedFiles(wd).join('\n'));
    write(path.join(d, 'pre.head'), git(wd, ['rev-parse', 'HEAD']).out);
  }
  write(path.join(wd, TASK_FILE), prompt);
  setStatus(d, 'running');

  const [bin, args] = workerCommand(worker, role, model, c);
  const started = Date.now();
  const logFile = path.join(d, 'log.txt');
  const exit = await new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    let child;
    try {
      child = spawnCli(bin, args, { cwd: wd, stdio: ['ignore', out, out], windowsHide: true });
    } catch (e) {
      fs.closeSync(out);
      fs.appendFileSync(logFile, `spawn failed: ${e.message}\n`);
      return resolve(127);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, Number(c.ORCH_TIMEOUT) * 1000);
    const done = (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* already closed */ }
      if (timedOut) fs.appendFileSync(logFile, `\n[orch] killed after ${c.ORCH_TIMEOUT}s timeout\n`);
      resolve(timedOut ? 124 : code ?? 1);
    };
    child.on('error', (e) => { fs.appendFileSync(logFile, `spawn error: ${e.message}\n`); done(127); });
    child.on('close', done);
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  try { fs.rmSync(path.join(wd, '.orch'), { recursive: true, force: true }); } catch { /* best effort */ }

  // eslint-disable-next-line no-control-regex
  const log = read(logFile).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
  write(logFile, log);
  const lines = log.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (/^\s*### RESULT/.test(l)) at = i; });
  const max = Number(c.ORCH_RESULT_MAX_LINES);
  const block = at >= 0
    ? lines.slice(at, at + max).join('\n').trimEnd()
    : ['### RESULT', 'status: FAILED',
      'summary: worker produced no RESULT block (contract not followed). Last output:',
      ...lines.slice(-20)].join('\n').trimEnd();
  const files = git_ ? taskChanges(d, wd) : null;
  const truth = [
    '### GROUND TRUTH (measured by orch, not the worker)',
    `exit: ${exit}   seconds: ${seconds}   worker: ${worker}/${model || 'default'}`,
    ...(files ? ['files changed:', ...(files.length ? files.slice(0, 30).map((f) => `  ${f}`) : ['  (none)'])]
      : ['files changed: unknown (workdir is not a git repo)']),
  ].join('\n');
  const result = `${block}\n\n${truth}\n`;
  write(path.join(d, 'result.md'), result);
  write(path.join(d, 'meta.json'), JSON.stringify({ worker, model: model || 'default', exit, seconds, role }, null, 2));
  const st = at < 0 || exit !== 0 || /^\s*status:\s*(BLOCKED|FAILED)/m.test(block) ? 'failed' : 'returned';
  setStatus(d, st);
  return { id, status: st, exit, seconds, worker, files, result };
}

export function result(id) {
  const d = taskDir(id);
  const f = path.join(d, 'result.md');
  if (!fs.existsSync(f)) fail(`no result yet (status: ${getStatus(d)})`);
  return { id, status: getStatus(d), result: read(f) };
}

export function verify(id) {
  const d = taskDir(id);
  const proj = id.slice(0, id.indexOf('/'));
  const wd = read(path.join(d, 'workdir')).trim();
  const role = briefField(d, 'role') || 'edit';
  const scope = briefField(d, 'scope').split(/[\s,]+/).filter(Boolean)
    .map((s) => s.replace(/\\/g, '/').replace(/^\.\//, ''));
  const cmd = briefField(d, 'verify') || project(proj).verify || '';
  const res = { id, scope: { checked: false, allowed: scope, outOfScope: [] }, verify: { command: cmd, exit: null, tail: '' } };

  if (isGit(wd)) {
    res.scope.checked = true;
    res.scope.outOfScope = taskChanges(d, wd)
      .filter((f) => role !== 'edit' || !scope.some((s) => f.startsWith(s)));
  }
  if (cmd) {
    const r = spawnSync(cmd, { cwd: wd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    write(path.join(d, 'verify.log'), out);
    res.verify.exit = r.status ?? 1;
    res.verify.tail = out.trimEnd().split('\n').slice(-25).join('\n');
  }
  res.verified = Boolean(cmd) && res.verify.exit === 0 && res.scope.outOfScope.length === 0;
  setStatus(d, res.verified ? 'verified' : 'rejected');
  return res;
}

export function status(filter) {
  registry();
  const root = path.join(HOME, 'projects');
  const rows = [];
  for (const p of fs.readdirSync(root).sort()) {
    if (filter && filter !== p) continue;
    const tasks = path.join(root, p, 'tasks');
    if (!fs.existsSync(tasks)) continue;
    for (const t of fs.readdirSync(tasks).sort()) {
      const d = path.join(tasks, t);
      if (!fs.statSync(d).isDirectory()) continue;
      rows.push({ id: `${p}/${t}`, status: getStatus(d), goal: briefField(d, 'goal').slice(0, 60) });
    }
  }
  return rows;
}

export function close(id) {
  const d = taskDir(id);
  setStatus(d, 'closed');
  const b = path.join(d, 'branch');
  return {
    id, status: 'closed',
    worktree: fs.existsSync(b) ? { path: read(path.join(d, 'workdir')).trim(), branch: read(b).trim() } : null,
  };
}

export async function doctor() {
  const c = config();
  const checks = [];
  const add = (level, label) => checks.push({ level, label });
  const has = (bin) => spawnSync(WIN ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
  const exists = (label, f) => add(fs.existsSync(f) ? 'ok' : 'MISSING', label);
  const flags = (bin, helpArgs, list) => {
    const r = runCliSync(bin, helpArgs, { timeout: 20000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    for (const f of list) {
      add(out.includes(f) ? 'ok' : 'WARN', `${bin} ${helpArgs.join(' ')} lists ${f}${out.includes(f) ? '' : ' — NOT FOUND, check dispatch args in orch.mjs workerCommand()'}`);
    }
  };

  exists('state initialised (orch init)', regFile());
  exists('worker contract installed', path.join(HOME, 'worker-contract.md'));
  exists('hub AGENTS.md installed', path.join(HOME, 'hub', 'AGENTS.md'));
  add(has('git') ? 'ok' : 'MISSING', 'git');
  add(has('rg') ? 'ok' : 'MISSING', 'rg (ripgrep)');
  const harness = [
    [c.ORCH_PI_BIN, ['--help'], ['--print', '--no-session', '--no-skills', '--tools', '--model']],
    [c.ORCH_OPENCODE_BIN, ['run', '--help'], ['--model', '--agent']],
    [c.ORCH_COPILOT_BIN, ['--help'], ['--no-ask-user', '--allow-all-tools', '--deny-tool', '--model']],
  ];
  for (const [bin, helpArgs, list] of harness) {
    const needed = [c[`ORCH_${c.ORCH_DEFAULT_WORKER.toUpperCase()}_BIN`], c[`ORCH_${c.ORCH_HUB_HARNESS.toUpperCase()}_BIN`]].includes(bin);
    if (has(bin)) { add('ok', bin); flags(bin, helpArgs, list); }
    else add(needed ? 'MISSING' : 'WARN', `${bin} (harness)${needed ? ' — configured as default worker or hub harness' : ' — not installed; do not route tasks to it'}`);
  }
  try {
    const r = await fetch(`${c.ORCH_LOCAL_URL}/models`, { signal: AbortSignal.timeout(4000) });
    add(r.ok ? 'ok' : 'MISSING', `local model endpoint ${c.ORCH_LOCAL_URL} (HTTP ${r.status})`);
  } catch {
    add('MISSING', `local model endpoint ${c.ORCH_LOCAL_URL} — start the model server or fix ORCH_LOCAL_URL`);
  }
  if (!c.ORCH_PI_MODEL) add('WARN', 'ORCH_PI_MODEL is empty — pi will use its own default model');
  add(has('ast-grep') ? 'ok' : 'absent', 'ast-grep (optional)');
  const missing = checks.filter((x) => x.level === 'MISSING').length;
  return { home: HOME, checks, missing, ok: missing === 0 };
}

export function chat(harness) {
  const c = config();
  const h = harness || c.ORCH_HUB_HARNESS;
  const bin = { pi: c.ORCH_PI_BIN, opencode: c.ORCH_OPENCODE_BIN, copilot: c.ORCH_COPILOT_BIN }[h];
  if (!bin) fail('harness must be pi, opencode or copilot');
  const hub = path.join(HOME, 'hub');
  if (!fs.existsSync(path.join(hub, 'AGENTS.md'))) fail(`hub not installed: ${hub}`);
  const r = spawnSync(bin, [], { cwd: hub, stdio: 'inherit', shell: WIN });
  return r.status ?? 1;
}

// ---------- CLI ----------

const USAGE = `orch — multi-project agent dispatcher (add --json for machine-readable output)

  orch init                                    create state dir
  orch project add <name> <path> [verify-cmd]  register a project
  orch project list                            name, path, default verify
  orch project show <name>                     state card + open tasks
  orch task new <project> <slug> [--worktree]  create task + brief template
  orch dispatch <project>/<task> [--worker pi|opencode|copilot] [--model M] [--bg]
  orch result <project>/<task>                 capped worker result
  orch verify <project>/<task>                 run verify cmd + scope check
  orch status [project]                        one line per task
  orch close <project>/<task>                  mark closed
  orch chat [pi|opencode|copilot]              open the orchestrator chat in the hub
  orch doctor                                  check tools, flags, local endpoint
`;

const taskLine = (t) => `${t.id.padEnd(38)} ${t.status.padEnd(9)} ${t.goal}`;

async function main(argv) {
  const flags = { json: false, worktree: false, bg: false, worker: undefined, model: undefined };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--worktree') flags.worktree = true;
    else if (a === '--bg') flags.bg = true;
    else if (a === '--worker' || a === '--model') flags[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') pos.unshift('help');
    else if (a.startsWith('--')) fail(`unknown flag: ${a}`);
    else pos.push(a);
  }
  const [cmd, a1, a2, a3, a4] = pos;
  const emit = (obj, text) => console.log(flags.json ? JSON.stringify(obj, null, 2) : text);

  switch (cmd) {
    case 'init': { const r = init(); return emit(r, `orch home: ${r.home}`); }
    case 'project':
      if (a1 === 'add') {
        if (!a2 || !a3) fail('usage: orch project add <name> <path> [verify-cmd]');
        const r = projectAdd(a2, a3, a4 || '');
        return emit(r, `added ${r.name} -> ${r.path}\nstate card: ${r.stateCard} (fill it in; keep under 60 lines)`);
      }
      if (a1 === 'show') {
        if (!a2) fail('usage: orch project show <name>');
        const r = projectShow(a2);
        return emit(r, `${r.stateCard.trimEnd()}\n\n## Open tasks\n${r.openTasks.map(taskLine).join('\n') || '(none)'}`);
      }
      if (!a1 || a1 === 'list') {
        const r = projectList();
        return emit(r, r.map((p) => `${p.name.padEnd(20)} ${p.path}  [verify: ${p.verify || '-'}]`).join('\n') || '(no projects)');
      }
      return fail(`unknown: project ${a1}`);
    case 'task': {
      if (a1 !== 'new' || !a2 || !a3) fail('usage: orch task new <project> <slug> [--worktree]');
      const r = taskNew(a2, a3, { worktree: flags.worktree });
      return emit(r, `task:    ${r.id}\nbrief:   ${r.brief}\nworkdir: ${r.workdir}`);
    }
    case 'dispatch': {
      if (!a1) fail('usage: orch dispatch <project>/<task> [--worker W] [--model M] [--bg]');
      const r = await dispatch(a1, flags);
      return emit(r, r.background
        ? `started ${r.id} (worker=${r.worker}) — poll with: orch status ${r.id.split('/')[0]}`
        : r.result.trimEnd());
    }
    case 'result': { const r = result(a1); return emit(r, r.result.trimEnd()); }
    case 'verify': {
      const r = verify(a1);
      const scope = !r.scope.checked ? 'skipped — workdir is not a git repo'
        : r.scope.outOfScope.length
          ? `OUT OF SCOPE (allowed: ${r.scope.allowed.join(' ') || 'none'}):\n${r.scope.outOfScope.map((f) => `  ${f}`).join('\n')}`
          : `ok — all changes inside: ${r.scope.allowed.join(' ') || '<read-only, no changes>'}`;
      const ver = r.verify.command ? `$ ${r.verify.command} -> exit ${r.verify.exit}\n${r.verify.tail}`
        : "NO VERIFY COMMAND — cannot mark verified. Add 'verify:' to the brief or the project.";
      emit(r, `## scope\n${scope}\n## verify\n${ver}\n## verdict\n${r.verified ? 'VERIFIED' : 'REJECTED'}`);
      if (!r.verified) process.exitCode = 1;
      return undefined;
    }
    case 'status': { const r = status(a1); return emit(r, r.map(taskLine).join('\n') || '(no tasks)'); }
    case 'close': {
      const r = close(a1);
      return emit(r, `closed ${r.id}${r.worktree
        ? `\nworktree: ${r.worktree.path}  branch: ${r.worktree.branch}\nmerge or remove it yourself — orch never merges.` : ''}`);
    }
    case 'doctor': {
      const r = await doctor();
      emit(r, `orch home: ${r.home}\n${r.checks.map((x) => `${x.level.padEnd(8)} ${x.label}`).join('\n')}\n---\n${r.missing} required item(s) missing`);
      if (!r.ok) process.exitCode = 1;
      return undefined;
    }
    case 'chat': process.exitCode = chat(a1); return undefined;
    case 'help': case undefined: console.log(USAGE); return undefined;
    default: console.error(USAGE); process.exitCode = 2; return undefined;
  }
}

const isMain = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    if (e instanceof OrchError) { console.error(`orch: ${e.message}`); process.exitCode = 1; } else throw e;
  });
}
