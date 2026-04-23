#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTelemetryPaths } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = resolve(HERE, 'build.mjs');

const paths = resolveTelemetryPaths();

if (!existsSync(paths.events)) {
  console.error(`[claude-telemetry] no events yet at ${paths.events}`);
  console.error('[claude-telemetry] hooks will populate this file as you use Claude Code in this project. Try again after at least one turn.');
  process.exit(1);
}

const build = spawnSync(process.execPath, [BUILD_SCRIPT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_PROJECT_DIR: paths.projectRoot },
  encoding: 'utf8',
});
if (build.status !== 0) {
  if (build.stdout) process.stderr.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  console.error('[claude-telemetry] build failed');
  process.exit(build.status || 1);
}

if (!existsSync(paths.html)) {
  console.error(`[claude-telemetry] expected output not found: ${paths.html}`);
  process.exit(1);
}

const [opener, openerArgs] =
  process.platform === 'darwin' ? ['open', []]
  : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']]
  : ['xdg-open', []];

const openRes = spawnSync(opener, [...openerArgs, paths.html], {
  stdio: 'inherit',
  shell: false,
});

if (openRes.error || (openRes.status != null && openRes.status !== 0)) {
  console.error(`[claude-telemetry] failed to launch browser (${opener}): ${openRes.error?.message || 'exit ' + openRes.status}`);
  console.error(`[claude-telemetry] open manually: ${paths.html}`);
  process.exit(1);
}

console.log(`✓ dashboard opened — ${paths.html}`);
