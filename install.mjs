#!/usr/bin/env node
// Installer for agent-orchestra. Node 18+, no dependencies. Idempotent.
//   node install.mjs [--dry-run] [--no-link] [--skills-dir <dir>]
// Honors ORCH_HOME (default ~/.orchestra).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LINK = !argv.includes('--no-link');
const sd = argv.indexOf('--skills-dir');
const SKILLS = sd >= 0 ? path.resolve(argv[sd + 1]) : path.join(os.homedir(), '.agents', 'skills');
const HOME = process.env.ORCH_HOME || path.join(os.homedir(), '.orchestra');

const log = (action, target) => console.log(`${DRY ? '[dry-run] ' : ''}${action.padEnd(10)} ${target}`);

function copyFile(from, to, { keep = false } = {}) {
  if (keep && fs.existsSync(to)) return log('keep', to);
  log(fs.existsSync(to) ? 'update' : 'create', to);
  if (DRY) return undefined;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  return fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else copyFile(a, b);
  }
}

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Node 18 or newer is required.');
  process.exit(1);
}

// 1. skills → shared Agent Skills dir read by pi, opencode and Copilot CLI
for (const e of fs.readdirSync(path.join(SRC, 'skills'), { withFileTypes: true })) {
  if (e.isDirectory()) copyDir(path.join(SRC, 'skills', e.name), path.join(SKILLS, e.name));
}

// 2. state dir
for (const s of ['projects', 'hub', 'worktrees', 'app/bin']) {
  if (!DRY) fs.mkdirSync(path.join(HOME, s), { recursive: true });
}
const reg = path.join(HOME, 'projects.json');
if (!fs.existsSync(reg)) { log('create', reg); if (!DRY) fs.writeFileSync(reg, '{}\n'); } else log('keep', reg);
copyFile(path.join(SRC, 'assets', 'worker-contract.md'), path.join(HOME, 'worker-contract.md'));
copyFile(path.join(SRC, 'assets', 'hub-AGENTS.md'), path.join(HOME, 'hub', 'AGENTS.md'));
copyFile(path.join(SRC, 'assets', 'config.example'), path.join(HOME, 'config'), { keep: true });

// 3. CLI → stable location, then expose `orch` on PATH through npm's global bin
copyFile(path.join(SRC, 'bin', 'orch.mjs'), path.join(HOME, 'app', 'bin', 'orch.mjs'));
copyFile(path.join(SRC, 'package.json'), path.join(HOME, 'app', 'package.json'));
if (LINK) {
  log('npm -g', path.join(HOME, 'app'));
  if (!DRY) {
    const r = spawnSync('npm', ['install', '-g', path.join(HOME, 'app')], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.error('\nnpm global install failed. The files are in place; run the CLI directly with:');
      console.error(`  node "${path.join(HOME, 'app', 'bin', 'orch.mjs')}" doctor`);
      process.exit(1);
    }
  }
}

console.log(`
Installed.
  skills: ${SKILLS}
  state:  ${HOME}
Next: edit ${path.join(HOME, 'config')}, then run: orch doctor`);
