import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
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
  let homeDir;
  let telemetryRoot;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-paths-${process.pid}-${Math.random().toString(36).slice(2)}`);
    homeDir = resolve(sandbox, 'home');
    telemetryRoot = resolveTelemetryRoot(homeDir);
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('resolves the global telemetry root under ~/.claude/claude-telemetry', () => {
    expect(resolveTelemetryRoot('/tmp/example-home')).toBe('/tmp/example-home/.claude/claude-telemetry');
  });

  it('maps unix-style project paths to Claude-style bucket stems', () => {
    expect(projectBucketStem('/Users/didi/mycode/github/claude-telemetry'))
      .toBe('-Users-didi-mycode-github-claude-telemetry');
  });

  it('sanitizes windows drive separators in bucket stems', () => {
    expect(projectBucketStem('C:\\Users\\dev\\proj')).toBe('C--Users-dev-proj');
  });

  it('returns a stable bucket name for the same project', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo');
    const first = projectBucketName(projectRoot, telemetryRoot);
    const second = projectBucketName(projectRoot, telemetryRoot);
    expect(first).toBe(projectBucketStem(projectRoot));
    expect(second).toBe(first);
  });

  it('adds a short suffix only when two project roots collide on the Claude-style name', () => {
    const projectA = resolve(sandbox, 'my-code', 'foo');
    const projectB = resolve(sandbox, 'my', 'code-foo');
    const baseBucket = projectBucketStem(projectA);
    const basePaths = resolveTelemetryPaths(projectA, telemetryRoot);

    ensureTelemetryDir(basePaths);

    const bucket = projectBucketName(projectB, telemetryRoot);
    const expectedHash = createHash('sha1').update(projectB).digest('hex').slice(0, 8);

    expect(baseBucket).toBe(projectBucketStem(projectB));
    expect(bucket).toBe(`${baseBucket}--${expectedHash}`);
  });

  it('writes events, outputs, and meta.json into the global project bucket', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo-app');
    const paths = resolveTelemetryPaths(projectRoot, telemetryRoot);

    ensureTelemetryDir(paths);

    const meta = readJson(paths.meta);
    expect(paths.dir).toBe(resolve(telemetryRoot, 'projects', paths.bucketName));
    expect(paths.events).toBe(resolve(paths.dir, 'events.jsonl'));
    expect(paths.html).toBe(resolve(paths.dir, 'index.html'));
    expect(paths.snapshot).toBe(resolve(paths.dir, 'snapshot.json'));
    expect(meta.projectRoot).toBe(projectRoot);
    expect(meta.bucketName).toBe(paths.bucketName);
    expect(meta.projectName).toBe(basename(projectRoot));
    expect(typeof meta.createdAt).toBe('string');
    expect(typeof meta.lastSeenAt).toBe('string');
  });

  it('preserves createdAt when refreshing project metadata', () => {
    const projectRoot = resolve(sandbox, 'workspace', 'demo-app');
    const paths = resolveTelemetryPaths(projectRoot, telemetryRoot);

    ensureTelemetryDir(paths);
    const first = readJson(paths.meta);
    ensureTelemetryDir(paths);
    const second = readJson(paths.meta);

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.projectRoot).toBe(first.projectRoot);
    expect(second.bucketName).toBe(first.bucketName);
  });
});
