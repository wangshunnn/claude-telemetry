import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function runHook(profile, input, { projectRoot, home }) {
  return spawnSync(process.execPath, ['scripts/append-event.mjs', profile], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      HOME: home,
    },
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function readEvents(paths) {
  if (!existsSync(paths.events)) return [];
  return readFileSync(paths.events, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('append-event.mjs slash_command', () => {
  let sandbox;
  let projectRoot;
  let fakeHome;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-hook-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace');
    fakeHome = resolve(sandbox, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('emits a skill_invoked event when command_name matches a project-level skill', () => {
    const skillDir = resolve(projectRoot, '.claude', 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), '# deploy');

    const result = runHook('slash_command', {
      session_id: 's1',
      command_name: 'deploy',
      cwd: projectRoot,
      args: 'staging',
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'skill_invoked',
      source_hook: 'UserPromptExpansion',
      skill: 'deploy',
      args: 'staging',
      session_id: 's1',
    });
  });

  it('emits a skill_invoked event when command_name matches a user-level skill', () => {
    const skillDir = resolve(fakeHome, '.claude', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), '# review');

    const result = runHook('slash_command', {
      session_id: 's1',
      command_name: 'review',
      cwd: projectRoot,
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('review');
  });

  it('emits a skill_invoked event when command_name matches a plugin-installed skill', () => {
    const skillDir = resolve(fakeHome, '.claude', 'plugins', 'some-pack', 'skills', 'vercel-react-best-practices');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), '# vercel');

    const result = runHook('slash_command', {
      session_id: 's1',
      command_name: 'vercel-react-best-practices',
      cwd: projectRoot,
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('vercel-react-best-practices');
  });

  it('ignores slash commands that do not correspond to an installed skill', () => {
    const result = runHook('slash_command', {
      session_id: 's1',
      command_name: 'review',
      cwd: projectRoot,
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    expect(existsSync(paths.events)).toBe(false);
  });

  it('ignores commands with empty or unsafe names', () => {
    for (const name of ['', '  ', 'foo/bar', '..\\bad']) {
      const result = runHook('slash_command', {
        session_id: 's1',
        command_name: name,
        cwd: projectRoot,
      }, { projectRoot, home: fakeHome });
      expect(result.status).toBe(0);
    }

    const paths = resolveTelemetryPaths(projectRoot);
    expect(existsSync(paths.events)).toBe(false);
  });
});
