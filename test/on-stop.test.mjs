import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectBucketStem, resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function runStopHook(projectRoot, input, extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/on-stop.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_PROJECT_DIR: projectRoot,
    },
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function readEvents(projectRoot) {
  const paths = resolveTelemetryPaths(projectRoot);
  return readFileSync(paths.events, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('on-stop.mjs', () => {
  let sandbox;
  let projectRoot;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-stop-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace', 'sample-project');
    mkdirSync(projectRoot, { recursive: true });
    delete process.env.CLAUDE_TELEMETRY_ROOT;
  });

  afterEach(() => {
    delete process.env.CLAUDE_TELEMETRY_ROOT;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('prefers transcript text and records transcript usage metadata', () => {
    const transcript = resolve(sandbox, 'transcript.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'Question' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        requestId: 'req-1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'thinking', thinking: 'Plan' }],
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        requestId: 'req-1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Transcript reply' }],
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      }),
    ].join('\n') + '\n');

    const result = runStopHook(projectRoot, {
      session_id: 'session-1',
      hook_event_name: 'Stop',
      transcript_path: transcript,
      last_assistant_message: 'Fallback reply',
    });

    expect(result.status).toBe(0);
    const [event] = readEvents(projectRoot);
    expect(event.reply).toBe('Transcript reply');
    expect(event.reply_source).toBe('transcript');
    expect(event.transcript_source).toBe('hook_input');
    expect(event.reply_ts).toBe('2026-01-01T00:00:01.000Z');
    expect(event.request_id).toBe('req-1');
    expect(event.model).toBe('claude-test');
    expect(event.api_calls).toBe(1);
    expect(event.tokens).toEqual({ input: 10, output: 3, cache_read: 2, cache_write: 1 });
    expect(event.max_context_tokens).toBe(13);
  });

  it('keeps assistant calls before tool results in the same user turn', () => {
    const transcript = resolve(sandbox, 'tool-transcript.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'Question' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'msg-tool',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'tool_use', name: 'Read', input: {} }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Result' }],
        },
        toolUseResult: { stdout: 'Result' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          id: 'msg-final',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Final reply' }],
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 1,
          },
        },
      }),
    ].join('\n') + '\n');

    const result = runStopHook(projectRoot, {
      session_id: 'session-1',
      hook_event_name: 'Stop',
      transcript_path: transcript,
    });

    expect(result.status).toBe(0);
    const [event] = readEvents(projectRoot);
    expect(event.reply).toBe('Final reply');
    expect(event.api_calls).toBe(2);
    expect(event.tokens).toEqual({ input: 30, output: 9, cache_read: 5, cache_write: 1 });
    expect(event.max_context_tokens).toBe(24);
  });

  it('infers the Claude transcript path from cwd and session_id when hook input omits it', () => {
    const sessionId = 'session-1';
    const fakeHome = resolve(sandbox, 'home');
    const transcriptDir = resolve(fakeHome, '.claude', 'projects', projectBucketStem(projectRoot));
    const transcript = resolve(transcriptDir, `${sessionId}.jsonl`);
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(transcript, [
      JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: { role: 'user', content: 'Question' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Inferred transcript reply' }],
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 3,
          },
        },
      }),
    ].join('\n') + '\n');

    const result = runStopHook(projectRoot, {
      session_id: sessionId,
      hook_event_name: 'Stop',
      cwd: projectRoot,
      last_assistant_message: 'Fallback reply',
    }, { HOME: fakeHome });

    expect(result.status).toBe(0);
    const [event] = readEvents(projectRoot);
    expect(event.reply).toBe('Inferred transcript reply');
    expect(event.reply_source).toBe('transcript');
    expect(event.transcript_source).toBe('inferred');
    expect(event.model).toBe('claude-test');
    expect(event.tokens).toEqual({ input: 20, output: 5, cache_read: 8, cache_write: 3 });
    expect(event.max_context_tokens).toBe(31);
  });

  it('falls back to last_assistant_message when transcript text is unavailable', () => {
    const missingTranscript = resolve(sandbox, 'missing-transcript.jsonl');

    const result = runStopHook(projectRoot, {
      session_id: 'session-1',
      hook_event_name: 'Stop',
      transcript_path: missingTranscript,
      last_assistant_message: [{ type: 'text', text: 'Hook fallback reply' }],
    });

    expect(result.status).toBe(0);
    const [event] = readEvents(projectRoot);
    expect(event.reply).toBe('Hook fallback reply');
    expect(event.reply_source).toBe('last_assistant_message');
    expect(event.transcript_source).toBe('');
    expect(event.reply_ts).toBe('');
    expect(event.model).toBe('');
    expect(event.api_calls).toBe(0);
  });

  it('keeps an empty reply when neither transcript nor hook input has text', () => {
    const result = runStopHook(projectRoot, {
      session_id: 'session-1',
      hook_event_name: 'Stop',
    });

    expect(result.status).toBe(0);
    const [event] = readEvents(projectRoot);
    expect(event.reply).toBe('');
    expect(event.reply_source).toBe('');
    expect(event.reply_length).toBe(0);
  });
});
