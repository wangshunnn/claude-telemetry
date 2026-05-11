#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorCodex, installCodexHooks, uninstallCodexHooks } from '../scripts/codex-hooks.mjs';
import { openDashboard } from '../scripts/open-dashboard.mjs';
import { normalizeAgent } from '../scripts/paths.mjs';

const BIN_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(BIN_DIR, '..');

function usage() {
  return [
    'Usage:',
    '  claude-telemetry install codex',
    '  claude-telemetry uninstall codex',
    '  claude-telemetry doctor codex',
    '  claude-telemetry open [codex|claude]',
    '',
    'Hook entrypoints:',
    '  claude-telemetry hook codex append-event <profile>',
    '  claude-telemetry hook codex on-stop',
  ].join('\n');
}

function readStdinRaw() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function runNodeScript(script, args, input, agent) {
  const result = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts', script), ...args, agent], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_TELEMETRY_AGENT: agent,
    },
    input,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status || 0;
}

function parseOptionValue(args, name, fallback = null) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const [command, target, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }

  if (command === 'install' && target === 'codex') {
    const cliCommand = parseOptionValue(rest, '--command', 'claude-telemetry');
    const result = installCodexHooks({ cliCommand });
    console.log(`Installed Codex hooks in ${result.path}`);
    console.log('Codex project hooks require this project to be trusted and features.codex_hooks = true.');
    return 0;
  }

  if (command === 'uninstall' && target === 'codex') {
    const result = uninstallCodexHooks();
    console.log(result.changed
      ? `Removed ${result.removed} Codex hook command(s) from ${result.path}`
      : `No claude-telemetry Codex hooks found in ${result.path}`);
    return 0;
  }

  if (command === 'doctor' && target === 'codex') {
    const result = doctorCodex();
    console.log(`Codex telemetry doctor for ${result.projectRoot}`);
    for (const check of result.checks) {
      console.log(`${check.ok ? 'OK ' : 'ERR'} ${check.name}: ${check.detail}`);
    }
    return result.ok ? 0 : 1;
  }

  if (command === 'open') {
    const agent = target ? normalizeAgent(target) : null;
    if (target && target !== 'codex' && target !== 'claude') {
      console.error('Unknown telemetry agent. Use codex or claude.');
      return 1;
    }
    return openDashboard(agent);
  }

  if (command === 'hook') {
    const agent = normalizeAgent(target);
    const [hookCommand, profile] = rest;
    const input = readStdinRaw();
    if (agent !== 'codex') return 0;
    if (hookCommand === 'append-event' && profile) {
      return runNodeScript('append-event.mjs', [profile], input, agent);
    }
    if (hookCommand === 'on-stop') {
      return runNodeScript('on-stop.mjs', [], input, agent);
    }
    return 0;
  }

  console.error(usage());
  return 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
