import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureTelemetryDir, projectBucketStem, resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function runBuild(projectRoot, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_PROJECT_DIR: projectRoot,
    },
    encoding: 'utf8',
  });
}

describe('build.mjs', () => {
  let sandbox;
  let projectRoot;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-build-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace', 'sample-project');
    mkdirSync(resolve(projectRoot, 'docs'), { recursive: true });
    delete process.env.CLAUDE_TELEMETRY_ROOT;
  });

  afterEach(() => {
    delete process.env.CLAUDE_TELEMETRY_ROOT;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('builds dashboard artifacts in the project-local telemetry directory by default', () => {
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

    const result = runBuild(projectRoot);

    expect(result.status).toBe(0);
    expect(paths.meta).toBeNull();
    expect(existsSync(paths.html)).toBe(true);
    expect(existsSync(paths.snapshot)).toBe(true);
    expect(existsSync(resolve(projectRoot, '.claude', 'telemetry'))).toBe(true);
    expect(result.stdout.trim()).toBe(pathToFileURL(paths.html).toString());
    expect(() => JSON.parse(readFileSync(paths.snapshot, 'utf8'))).not.toThrow();
  });

  it('backfills missing token metadata from the local Claude transcript', () => {
    const paths = resolveTelemetryPaths(projectRoot);
    ensureTelemetryDir(paths);
    const fakeHome = resolve(sandbox, 'home');
    const sessionId = 'session-1';
    const transcriptDir = resolve(fakeHome, '.claude', 'projects', projectBucketStem(projectRoot));
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(resolve(transcriptDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'What skills are available?' },
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Skill list' }],
          usage: {
            input_tokens: 100,
            output_tokens: 12,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
          },
        },
      }),
    ].join('\n') + '\n');

    const events = [
      {
        ts: '2026-01-01T00:00:00.000Z',
        session_id: sessionId,
        event: 'session_start',
        cwd: projectRoot,
      },
      {
        ts: '2026-01-01T00:00:01.000Z',
        session_id: sessionId,
        event: 'user_prompt',
        prompt: 'What skills are available?',
      },
      {
        ts: '2026-01-01T00:00:03.000Z',
        session_id: sessionId,
        event: 'session_stop',
        stop_status: 'success',
        source_hook: 'Stop',
        reply: 'Fallback reply',
        reply_length: 14,
        reply_truncated: false,
        reply_source: 'last_assistant_message',
        reply_ts: '',
        request_id: '',
        model: '',
        api_calls: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        max_context_tokens: 0,
      },
    ];

    writeFileSync(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const result = runBuild(projectRoot, { HOME: fakeHome });
    expect(result.status).toBe(0);

    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    const [task] = snapshot.metrics.recentTasks;
    expect(task.reply).toBe('Fallback reply');
    expect(task.model).toBe('claude-test');
    expect(task.apiCalls).toBe(1);
    expect(task.tokens).toEqual({ input: 100, output: 12, cache_read: 50, cache_write: 25 });
    expect(task.maxContextTokens).toBe(175);
    expect(snapshot.metrics.kpi.tokenSampleCount).toBe(1);
  });

  it('prints the bilingual no-data message when no telemetry events have been collected yet', () => {
    const paths = resolveTelemetryPaths(projectRoot);

    const result = runBuild(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No telemetry turns yet for this project.');
    expect(result.stdout).toContain('run /claude-telemetry:open again');
    expect(result.stdout).toContain('暂无本项目的 telemetry 数据');
    expect(result.stdout).not.toContain(pathToFileURL(paths.html).toString());
    expect(result.stderr).toBe('');
  });

  it('prints the no-data message when the events file is empty', () => {
    const paths = resolveTelemetryPaths(projectRoot);
    ensureTelemetryDir(paths);
    writeFileSync(paths.events, '');

    const result = runBuild(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No telemetry turns yet for this project.');
    expect(result.stdout).not.toContain(pathToFileURL(paths.html).toString());
    expect(result.stderr).toBe('');
  });

  it('falls back to an existing dashboard when no events are available', () => {
    const paths = resolveTelemetryPaths(projectRoot);
    ensureTelemetryDir(paths);
    writeFileSync(paths.html, '<!doctype html><title>old dashboard</title>');

    const result = runBuild(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pathToFileURL(paths.html).toString());
    expect(result.stderr).toBe('');
  });

  it('prints the no-data message when telemetry has events but no turn data yet', () => {
    const paths = resolveTelemetryPaths(projectRoot);
    ensureTelemetryDir(paths);

    const events = [
      {
        ts: '2026-01-01T00:00:00.000Z',
        session_id: 'session-1',
        event: 'session_start',
        cwd: projectRoot,
      },
    ];

    writeFileSync(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const result = runBuild(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No telemetry turns yet for this project.');
    expect(result.stdout).not.toContain(pathToFileURL(paths.html).toString());
    expect(result.stderr).toBe('');

    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    expect(snapshot.metrics.kpi.totalTaskCount).toBe(0);
  });

  it('aggregates skill_invoked events into knowledge hits keyed by skill name', () => {
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
        prompt: 'Use the vercel skill',
      },
      {
        ts: '2026-01-01T00:00:02.000Z',
        session_id: 'session-1',
        event: 'skill_invoked',
        source_hook: 'PostToolUse',
        skill: 'vercel-react-best-practices',
        args: null,
      },
      {
        ts: '2026-01-01T00:00:03.000Z',
        session_id: 'session-1',
        event: 'tool_read',
        file: resolve(projectRoot, '.claude', 'skills', 'vercel-react-best-practices', 'rules', 'advanced-init-once.md'),
      },
      {
        ts: '2026-01-01T00:00:04.000Z',
        session_id: 'session-1',
        event: 'session_stop',
        stop_status: 'success',
        source_hook: 'Stop',
        reply: 'done',
        reply_length: 4,
        reply_truncated: false,
        reply_ts: '2026-01-01T00:00:04.000Z',
        request_id: 'req-1',
        model: 'claude-test',
        api_calls: 1,
        tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
        max_context_tokens: 1,
      },
    ];

    writeFileSync(paths.events, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

    const result = runBuild(projectRoot);
    expect(result.status).toBe(0);

    const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
    const hits = snapshot.metrics.knowledgeTargets;
    const skillHit = hits.find((h) => h.key === 'skill:vercel-react-best-practices');
    expect(skillHit).toBeDefined();
    expect(skillHit.kind).toBe('skill');
    expect(skillHit.label).toBe('vercel-react-best-practices');
    expect(snapshot.metrics.kpi.knowledgeTaskCount).toBe(1);
  });
});
