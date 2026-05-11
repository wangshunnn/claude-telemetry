import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSelectorText } from '../scripts/open-dashboard.mjs';
import { ensureTelemetryDir, resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function writeTurn(projectRoot, agent) {
  const paths = resolveTelemetryPaths(projectRoot, null, { agent });
  ensureTelemetryDir(paths);
  writeFileSync(paths.events, [
    JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      session_id: 'session-1',
      event: 'user_prompt',
      prompt: `Hello ${agent}`,
    }),
    JSON.stringify({
      ts: '2026-01-01T00:00:01.000Z',
      session_id: 'session-1',
      event: 'session_stop',
      stop_status: 'success',
      source_hook: 'Stop',
      reply: 'done',
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    }),
  ].join('\n') + '\n');
  return paths;
}

function runCli(projectRoot, args) {
  return spawnSync(process.execPath, ['bin/claude-telemetry.mjs', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      CODEX_PROJECT_DIR: projectRoot,
      CLAUDE_TELEMETRY_NO_BROWSER: '1',
    },
    encoding: 'utf8',
  });
}

describe('claude-telemetry open', () => {
  let sandbox;
  let projectRoot;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-open-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace');
    mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('opens the Codex telemetry directory when requested explicitly', () => {
    const paths = writeTurn(projectRoot, 'codex');

    const result = runCli(projectRoot, ['open', 'codex']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pathToFileURL(paths.html).toString());
    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    expect(snapshot.agent).toBe('codex');
  });

  it('opens the Claude telemetry directory when requested explicitly', () => {
    const paths = writeTurn(projectRoot, 'claude');

    const result = runCli(projectRoot, ['open', 'claude']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pathToFileURL(paths.html).toString());
    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    expect(snapshot.agent).toBe('claude');
  });

  it('auto-opens the only populated agent in non-interactive mode', () => {
    const paths = writeTurn(projectRoot, 'codex');

    const result = runCli(projectRoot, ['open']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pathToFileURL(paths.html).toString());
  });

  it('asks for an explicit agent in non-interactive mode when both agents have data', () => {
    writeTurn(projectRoot, 'codex');
    writeTurn(projectRoot, 'claude');

    const result = runCli(projectRoot, ['open']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('open codex');
    expect(result.stdout).toContain('open claude');
  });

  it('renders interactive choices as separated blocks without color when disabled', () => {
    const text = renderSelectorText([
      {
        agent: 'claude',
        label: 'Claude',
        count: 1432,
        updatedAt: '2026-04-28T09:12:02.000Z',
        paths: { dir: '/workspace/.claude/telemetry' },
      },
      {
        agent: 'codex',
        label: 'Codex',
        count: 18,
        updatedAt: '2026-05-11T08:22:21.000Z',
        paths: { dir: '/workspace/.codex/telemetry' },
      },
    ], 0, { colors: false });

    expect(text).toContain('> Claude\n    1432 event(s)  2026-04-28 09:12:02Z');
    expect(text).toContain('/workspace/.claude/telemetry\n\n  Codex');
    expect(text).toContain('    /workspace/.codex/telemetry');
    expect(text).not.toMatch(/\x1b\[/);
  });
});
