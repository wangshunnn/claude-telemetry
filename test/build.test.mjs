import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureTelemetryDir, resolveTelemetryPaths, resolveTelemetryRoot } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

describe('build.mjs', () => {
  let sandbox;
  let homeDir;
  let telemetryRoot;
  let projectRoot;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-build-${process.pid}-${Math.random().toString(36).slice(2)}`);
    homeDir = resolve(sandbox, 'home');
    telemetryRoot = resolveTelemetryRoot(homeDir);
    projectRoot = resolve(sandbox, 'workspace', 'sample-project');
    mkdirSync(resolve(projectRoot, 'docs'), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('builds dashboard artifacts in the global project bucket without touching the repo', () => {
    const paths = resolveTelemetryPaths(projectRoot, telemetryRoot);
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
        event: 'tool_read',
        file: resolve(projectRoot, 'docs', 'guide.md'),
      },
      {
        ts: '2026-01-01T00:00:03.000Z',
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

    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        CLAUDE_PROJECT_DIR: projectRoot,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(paths.meta)).toBe(true);
    expect(existsSync(paths.html)).toBe(true);
    expect(existsSync(paths.snapshot)).toBe(true);
    expect(existsSync(resolve(projectRoot, '.claude', 'telemetry'))).toBe(false);
    expect(() => JSON.parse(readFileSync(paths.snapshot, 'utf8'))).not.toThrow();
  });
});
