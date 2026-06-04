import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_MARKER,
  codexHooksPath,
  doctorCodex,
  installCodexHooks,
  pruneCodexTelemetryHooks,
  uninstallCodexHooks,
} from '../scripts/codex-hooks.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('Codex hook installer', () => {
  let sandbox;
  let projectRoot;
  let fakeHome;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-codex-hooks-${process.pid}-${Math.random().toString(36).slice(2)}`);
    projectRoot = resolve(sandbox, 'workspace');
    fakeHome = resolve(sandbox, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(resolve(fakeHome, '.codex'), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('installs Codex hooks into an empty project config', () => {
    const result = installCodexHooks({ projectRoot });

    expect(result.path).toBe(codexHooksPath(projectRoot));
    expect(existsSync(result.path)).toBe(true);

    const config = readJson(result.path);
    expect(config.hooks.SessionStart[0].hooks[0].command).toContain(`${CODEX_HOOK_MARKER} append-event session_start`);
    expect(config.hooks.PostToolUse[0].matcher).toContain('Bash');
    expect(config.hooks.Stop[0].hooks[0].command).toContain(`${CODEX_HOOK_MARKER} on-stop`);
    expect(config.hooks.SubagentStart).toBeUndefined();
    expect(config.hooks.SubagentStop).toBeUndefined();
    expect(config.hooks.PostToolUseFailure).toBeUndefined();
  });

  it('preserves unrelated hooks and is idempotent', () => {
    const path = codexHooksPath(projectRoot);
    mkdirSync(resolve(projectRoot, '.codex'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo keep', timeout: 3 }],
          },
        ],
      },
    }, null, 2));

    installCodexHooks({ projectRoot });
    installCodexHooks({ projectRoot });

    const config = readJson(path);
    const allCommands = JSON.stringify(config);
    expect(allCommands.match(new RegExp(CODEX_HOOK_MARKER, 'g'))).toHaveLength(5);
    expect(allCommands).toContain('echo keep');
  });

  it('uninstalls only claude-telemetry Codex hooks', () => {
    installCodexHooks({ projectRoot });
    const path = codexHooksPath(projectRoot);
    const config = readJson(path);
    config.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: 'echo keep', timeout: 3 }],
    });
    writeFileSync(path, JSON.stringify(config, null, 2));

    const result = uninstallCodexHooks({ projectRoot });

    expect(result.removed).toBe(5);
    const next = readJson(path);
    expect(JSON.stringify(next)).not.toContain(CODEX_HOOK_MARKER);
    expect(JSON.stringify(next)).toContain('echo keep');
  });

  it('does not drop entries that contain non-telemetry hooks', () => {
    const { config, removed } = pruneCodexTelemetryHooks({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'claude-telemetry hook codex on-stop || true' },
              { type: 'command', command: 'echo keep' },
            ],
          },
        ],
      },
    });

    expect(removed).toBe(1);
    expect(config.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'echo keep' }]);
  });

  it('throws on malformed hooks JSON instead of overwriting it', () => {
    const path = codexHooksPath(projectRoot);
    mkdirSync(resolve(projectRoot, '.codex'), { recursive: true });
    writeFileSync(path, '{bad json');

    expect(() => installCodexHooks({ projectRoot })).toThrow(/Failed to parse/);
    expect(readFileSync(path, 'utf8')).toBe('{bad json');
  });

  it('doctor reports the important Codex setup checks', () => {
    installCodexHooks({ projectRoot });
    writeFileSync(resolve(fakeHome, '.codex', 'config.toml'), [
      '[features]',
      'codex_hooks = true',
      '',
      `[projects."${projectRoot}"]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'));

    const result = doctorCodex({ projectRoot, home: fakeHome });

    expect(result.telemetryDir).toBe(resolve(projectRoot, '.codex', 'telemetry'));
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'project hooks file', ok: true }),
        expect.objectContaining({ name: 'claude-telemetry hooks installed', ok: true }),
        expect.objectContaining({ name: 'features.codex_hooks', ok: true }),
        expect.objectContaining({ name: 'project trusted', ok: true }),
      ])
    );
  });
});
