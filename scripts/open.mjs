#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTelemetryPaths } from './paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_SCRIPT = resolve(HERE, 'build.mjs');

function compactMessage(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function childFailureDetail(result, fallbackLabel) {
  return compactMessage(
    result?.error?.message ||
    result?.stderr ||
    result?.stdout ||
    fallbackLabel
  );
}

function info(line) {
  console.log(`[claude-telemetry] ${line}`);
}

function fail(line) {
  console.error(`[claude-telemetry] ${line}`);
}

const paths = resolveTelemetryPaths();

if (!existsSync(paths.events)) {
  info('status=no-events');
  info(`no events yet at ${paths.events}`);
  info('hooks will populate this file as you use Claude Code in this project. Try again after at least one turn.');
  process.exit(0);
}

const build = spawnSync(process.execPath, [BUILD_SCRIPT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_PROJECT_DIR: paths.projectRoot },
  encoding: 'utf8',
});
if (build.status !== 0) {
  if (build.stdout) process.stderr.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  fail('status=build-failed');
  fail('build failed');
  process.exit(build.status || 1);
}

if (!existsSync(paths.html)) {
  fail('status=build-failed');
  fail(`expected output not found: ${paths.html}`);
  process.exit(1);
}

const [opener, openerArgs] =
  process.platform === 'darwin' ? ['open', []]
  : process.platform === 'win32' ? ['cmd', ['/c', 'start', '']]
  : ['xdg-open', []];

const openRes = spawnSync(opener, [...openerArgs, paths.html], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
  shell: false,
});

if (openRes.error || (openRes.status != null && openRes.status !== 0)) {
  info('status=manual-open');
  info(`dashboard built, but failed to launch browser (${opener}): ${childFailureDetail(openRes, 'exit ' + openRes.status)}`);
  info(`open manually: ${paths.html}`);
  process.exit(0);
}

info('status=opened');
info(`dashboard opened — ${paths.html}`);
