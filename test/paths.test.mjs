import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureTelemetryDir,
  projectBucketName,
  projectBucketStem,
  resolveTelemetryPaths,
  resolveTelemetryRoot,
} from '../scripts/paths.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('paths', () => {
  let sandbox;
  let sharedRoot;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-paths-${process.pid}-${Math.random().toString(36).slice(2)}`);
    sharedRoot = resolve(sandbox, 'shared-telemetry');
    delete process.env.CLAUDE_TELEMETRY_ROOT;
    mkdirSync(sharedRoot, { recursive: true });
  });

  afterEach(() => {
    delete process.env.CLAUDE_TELEMETRY_ROOT;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('resolves the default telemetry root inside the project', () => {
    expect(resolveTelemetryRoot('/tmp/example-project')).toBe('/tmp/example-project/.claude/telemetry');
  });

  it('resolves a custom telemetry root from CLAUDE_TELEMETRY_ROOT', () => {
    process.env.CLAUDE_TELEMETRY_ROOT = '../shared-output';
    expect(resolveTelemetryRoot('/tmp/example-project')).toBe('/tmp/shared-output');
  });

  it('maps unix-style project paths to Claude-style bucket stems', () => {
    expect(projectBucketStem('/Users/mycode/github/claude-telemetry'))
      .toBe('-Users-mycode-github-claude-telemetry');
  });

  it('sanitizes windows drive separators in bucket stems', () => {
    expect(projectBucketStem('C:\\Users\\dev\\proj')).toBe('C--Users-dev-proj');
  });

  it('returns a stable bucket name for the same project', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo');
    const first = projectBucketName(projectRoot, sharedRoot);
    const second = projectBucketName(projectRoot, sharedRoot);
    expect(first).toBe(projectBucketStem(projectRoot));
    expect(second).toBe(first);
  });

  it('adds a short suffix only when two project roots collide on the Claude-style name', () => {
    const projectA = resolve(sandbox, 'my-code', 'foo');
    const projectB = resolve(sandbox, 'my', 'code-foo');
    const baseBucket = projectBucketStem(projectA);
    const basePaths = resolveTelemetryPaths(projectA, sharedRoot);

    ensureTelemetryDir(basePaths);

    const bucket = projectBucketName(projectB, sharedRoot);
    const expectedHash = createHash('sha1').update(projectB).digest('hex').slice(0, 8);

    expect(baseBucket).toBe(projectBucketStem(projectB));
    expect(bucket).toBe(`${baseBucket}--${expectedHash}`);
  });

  it('writes events and dashboard outputs into the project-local telemetry directory by default', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo-app');
    const paths = resolveTelemetryPaths(projectRoot);

    ensureTelemetryDir(paths);

    expect(paths.dir).toBe(resolve(projectRoot, '.claude', 'telemetry'));
    expect(paths.events).toBe(resolve(paths.dir, 'events.jsonl'));
    expect(paths.html).toBe(resolve(paths.dir, 'index.html'));
    expect(paths.snapshot).toBe(resolve(paths.dir, 'snapshot.json'));
    expect(paths.bucketName).toBeNull();
    expect(paths.meta).toBeNull();
  });

  it('writes into a shared project bucket when a custom telemetry root is provided', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo-app');
    const paths = resolveTelemetryPaths(projectRoot, sharedRoot);

    ensureTelemetryDir(paths);

    const meta = readJson(paths.meta);
    expect(paths.dir).toBe(resolve(sharedRoot, 'projects', paths.bucketName));
    expect(meta.bucketName).toBe(paths.bucketName);
    expect(meta.storageMode).toBe('shared');
    expect(meta.telemetryRoot).toBe(sharedRoot);
  });

  it('preserves createdAt when refreshing shared project metadata', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo-app');
    const paths = resolveTelemetryPaths(projectRoot, sharedRoot);

    ensureTelemetryDir(paths);
    const first = readJson(paths.meta);
    ensureTelemetryDir(paths);
    const second = readJson(paths.meta);

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.projectRoot).toBe(first.projectRoot);
    expect(second.storageMode).toBe(first.storageMode);
  });
});
