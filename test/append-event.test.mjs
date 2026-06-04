import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTelemetryPaths } from '../scripts/paths.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function runHook(profile, input, { projectRoot, home, agent = 'claude' }) {
  return spawnSync(process.execPath, ['scripts/append-event.mjs', profile, agent], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      CODEX_PROJECT_DIR: projectRoot,
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

describe('append-event.mjs tool events', () => {
  let sandbox;
  let projectRoot;
  let fakeHome;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-tool-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace');
    fakeHome = resolve(sandbox, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('captures Bash command metadata', () => {
    const result = runHook('tool_bash', {
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: {
        command: 'pnpm test',
        description: 'Run tests',
      },
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'tool_bash',
      tool: 'Bash',
      command: 'pnpm test',
      description: 'Run tests',
      session_id: 's1',
    });
  });

  it('keeps Claude Bash file reads as Bash events only', () => {
    const result = runHook('tool_bash', {
      session_id: 's1',
      tool_name: 'Bash',
      cwd: projectRoot,
      tool_input: {
        command: 'ls docs/ 2>&1; echo "---"; head -100 docs/biz/index.md 2>&1',
        description: 'List docs structure',
      },
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot);
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'tool_bash',
      tool: 'Bash',
      command: 'ls docs/ 2>&1; echo "---"; head -100 docs/biz/index.md 2>&1',
      description: 'List docs structure',
      session_id: 's1',
    });
  });

  it('captures subagent lifecycle and launch metadata', () => {
    const start = runHook('subagent_start', {
      session_id: 's1',
      agent_id: 'agent-1',
      agent_type: 'research',
      cwd: projectRoot,
    }, { projectRoot, home: fakeHome });
    const request = runHook('subagent_request', {
      session_id: 's1',
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'research',
        description: 'Map repo architecture',
        prompt: 'Read the packages and summarize the framework',
        model: 'claude-opus-4-6',
      },
    }, { projectRoot, home: fakeHome });
    const stop = runHook('subagent_stop', {
      session_id: 's1',
      agent_id: 'agent-1',
      agent_type: 'research',
      agent_transcript_path: '/tmp/agent-1.jsonl',
      last_assistant_message: [{ type: 'text', text: 'Architecture mapped' }],
    }, { projectRoot, home: fakeHome });

    expect(start.status).toBe(0);
    expect(request.status).toBe(0);
    expect(stop.status).toBe(0);

    const events = readEvents(resolveTelemetryPaths(projectRoot));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      event: 'subagent_start',
      source_hook: 'SubagentStart',
      agent_id: 'agent-1',
      agent_type: 'research',
    });
    expect(events[1]).toMatchObject({
      event: 'subagent_request',
      source_hook: 'PreToolUse',
      tool: 'Task',
      agent_type: 'research',
      description: 'Map repo architecture',
      prompt: 'Read the packages and summarize the framework',
      model: 'claude-opus-4-6',
    });
    expect(events[2]).toMatchObject({
      event: 'subagent_stop',
      source_hook: 'SubagentStop',
      agent_id: 'agent-1',
      agent_type: 'research',
      agent_transcript_path: '/tmp/agent-1.jsonl',
      reply: 'Architecture mapped',
      reply_length: 19,
      reply_truncated: false,
    });
  });

  it('preserves subagent identity on Claude tool events', () => {
    const result = runHook('tool_read', {
      session_id: 's1',
      tool_name: 'Read',
      agent_id: 'agent-1',
      agent_type: 'research',
      tool_input: {
        file_path: resolve(projectRoot, 'docs', 'architecture.md'),
      },
    }, { projectRoot, home: fakeHome });

    expect(result.status).toBe(0);

    const [event] = readEvents(resolveTelemetryPaths(projectRoot));
    expect(event).toMatchObject({
      event: 'tool_read',
      file: resolve(projectRoot, 'docs', 'architecture.md'),
      agent_id: 'agent-1',
      agent_type: 'research',
    });
  });
});

describe('append-event.mjs Codex adapter', () => {
  let sandbox;
  let projectRoot;
  let fakeHome;

  beforeEach(() => {
    sandbox = resolve('/tmp', `claude-tel-codex-hook-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace');
    fakeHome = resolve(sandbox, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes Codex prompt events into .codex/telemetry', () => {
    const result = runHook('user_prompt', {
      session_id: 's1',
      turn_id: 'turn-1',
      prompt: 'Review the repo',
      cwd: projectRoot,
    }, { projectRoot, home: fakeHome, agent: 'codex' });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot, null, { agent: 'codex' });
    const events = readEvents(paths);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'codex',
      event: 'user_prompt',
      source_hook: 'UserPromptSubmit',
      prompt: 'Review the repo',
      turn_id: 'turn-1',
    });
    expect(existsSync(resolveTelemetryPaths(projectRoot).events)).toBe(false);
  });

  it('maps Codex Bash post-tool-use and conservative file reads', () => {
    const result = runHook('post_tool_use', {
      session_id: 's1',
      tool_name: 'Bash',
      cwd: projectRoot,
      tool_input: {
        command: 'cat docs/guide.md',
        description: 'Read guide',
      },
    }, { projectRoot, home: fakeHome, agent: 'codex' });

    expect(result.status).toBe(0);

    const paths = resolveTelemetryPaths(projectRoot, null, { agent: 'codex' });
    const events = readEvents(paths);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      agent: 'codex',
      event: 'tool_bash',
      tool: 'Bash',
      command: 'cat docs/guide.md',
      description: 'Read guide',
    });
    expect(events[1]).toMatchObject({
      agent: 'codex',
      event: 'tool_read',
      tool: 'Bash',
      file: resolve(projectRoot, 'docs', 'guide.md'),
    });
  });

  it('maps Codex apply_patch post-tool-use to a write event', () => {
    const result = runHook('post_tool_use', {
      session_id: 's1',
      tool_name: 'apply_patch',
      cwd: projectRoot,
      tool_input: {
        command: '*** Begin Patch\n*** Update File: README.md\n*** End Patch',
      },
    }, { projectRoot, home: fakeHome, agent: 'codex' });

    expect(result.status).toBe(0);

    const events = readEvents(resolveTelemetryPaths(projectRoot, null, { agent: 'codex' }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'codex',
      event: 'tool_write',
      source_hook: 'PostToolUse',
      tool: 'apply_patch',
    });
  });

  it('maps Codex permission requests with compact input only', () => {
    const result = runHook('permission_request', {
      session_id: 's1',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      cwd: projectRoot,
      tool_input: {
        command: 'pnpm install',
        description: 'Install dependencies',
        secret: 'not copied',
      },
    }, { projectRoot, home: fakeHome, agent: 'codex' });

    expect(result.status).toBe(0);

    const [event] = readEvents(resolveTelemetryPaths(projectRoot, null, { agent: 'codex' }));
    expect(event).toMatchObject({
      agent: 'codex',
      event: 'permission_request',
      source_hook: 'PermissionRequest',
      tool: 'Bash',
      input: {
        command: 'pnpm install',
        description: 'Install dependencies',
      },
    });
    expect(JSON.stringify(event)).not.toContain('not copied');
  });
});
