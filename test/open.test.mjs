import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureTelemetryDir, resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

describe('open.mjs', () => {
  let sandbox;
  let projectRoot;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-open-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace', 'sample-project');
    mkdirSync(resolve(projectRoot, 'docs'), { recursive: true });
    delete process.env.CLAUDE_TELEMETRY_ROOT;
  });

  afterEach(() => {
    delete process.env.CLAUDE_TELEMETRY_ROOT;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('exits with guidance when no telemetry events have been collected yet', () => {
    const result = spawnSync(process.execPath, ['scripts/open.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[claude-telemetry] status=no-events');
    expect(result.stdout).toContain('[claude-telemetry] no events yet');
    expect(result.stdout).toContain('Try again after at least one turn');
    expect(result.stderr).toBe('');
  });

  it('returns success with a manual-open path when the browser launcher is unavailable', () => {
    const paths = resolveTelemetryPaths(projectRoot);
    ensureTelemetryDir(paths);

    const events = [
      {
        ts: '2026-01-01T00:00:00.000Z',
        session_id: 'session-1',
        event: 'session_start',
        cwd: projectRoot,
      },
      {
        ts: '2026-01-01T00:00:01.000Z',
        session_id: 'session-1',
        event: 'user_prompt',
        prompt: 'Summarize the docs',
      },
      {
        ts: '2026-01-01T00:00:02.000Z',
        session_id: 'session-1',
        event: 'session_stop',
        stop_status: 'success',
        source_hook: 'Stop',
        reply: 'Summary complete',
        reply_length: 16,
        reply_truncated: false,
        reply_ts: '2026-01-01T00:00:03.000Z',
        request_id: 'req-1',
        model: 'claude-test',
        api_calls: 1,
        tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
        max_context_tokens: 10,
      },
    ];

    writeFileSync(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const result = spawnSync(process.execPath, ['scripts/open.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
        PATH: '/definitely-missing-path',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(paths.html)).toBe(true);
    expect(result.stdout).toContain('[claude-telemetry] status=manual-open');
    expect(result.stdout).toContain('dashboard built, but failed to launch browser');
    expect(result.stdout).toContain(`open manually: ${paths.html}`);
    expect(result.stderr).toBe('');
  });
});
