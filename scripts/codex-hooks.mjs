import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resolveTelemetryPaths } from './paths.mjs';

export const CODEX_HOOK_MARKER = 'claude-telemetry hook codex';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function findProjectRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0 && result.stdout.trim()) return resolve(result.stdout.trim());
  return resolve(cwd);
}

export function codexHooksPath(projectRoot) {
  return resolve(projectRoot, '.codex', 'hooks.json');
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    err.message = `Failed to parse ${path}: ${err.message}`;
    throw err;
  }
}

function readExistingHooksConfig(path) {
  if (!existsSync(path)) return { hooks: {} };
  const parsed = readJsonFile(path);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  if (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks)) {
    parsed.hooks = {};
  }
  return parsed;
}

function hookCommand(cliCommand, command) {
  return `${cliCommand} hook codex ${command} || true`;
}

export function createCodexHooksConfig(cliCommand = 'claude-telemetry') {
  const commandHook = (command, timeout = 30) => ({
    type: 'command',
    command: hookCommand(cliCommand, command),
    timeout,
  });

  return {
    hooks: {
      SessionStart: [
        { hooks: [commandHook('append-event session_start')] },
      ],
      UserPromptSubmit: [
        { hooks: [commandHook('append-event user_prompt')] },
      ],
      PermissionRequest: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [commandHook('append-event permission_request')],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash|apply_patch|Edit|Write|mcp__.*',
          hooks: [commandHook('append-event post_tool_use')],
        },
      ],
      Stop: [
        { hooks: [commandHook('on-stop')] },
      ],
    },
  };
}

function isTelemetryHook(hook) {
  return hook &&
    typeof hook === 'object' &&
    typeof hook.command === 'string' &&
    hook.command.includes(CODEX_HOOK_MARKER);
}

export function pruneCodexTelemetryHooks(config) {
  const next = cloneJson(config || { hooks: {} });
  if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
  let removed = 0;

  for (const [eventName, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) continue;
    const keptEntries = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        keptEntries.push(entry);
        continue;
      }
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      const keptHooks = hooks.filter((hook) => {
        const shouldRemove = isTelemetryHook(hook);
        if (shouldRemove) removed += 1;
        return !shouldRemove;
      });
      if (keptHooks.length) {
        keptEntries.push({ ...entry, hooks: keptHooks });
      } else if (!hooks.length) {
        keptEntries.push(entry);
      }
    }
    if (keptEntries.length) next.hooks[eventName] = keptEntries;
    else delete next.hooks[eventName];
  }

  return { config: next, removed };
}

function mergeHooksConfig(base, addition) {
  const next = cloneJson(base || { hooks: {} });
  if (!next.hooks || typeof next.hooks !== 'object') next.hooks = {};
  for (const [eventName, entries] of Object.entries(addition.hooks || {})) {
    if (!Array.isArray(next.hooks[eventName])) next.hooks[eventName] = [];
    next.hooks[eventName].push(...cloneJson(entries));
  }
  return next;
}

function writeHooksConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

export function installCodexHooks(options = {}) {
  const projectRoot = resolve(options.projectRoot || findProjectRoot());
  const cliCommand = options.cliCommand || 'claude-telemetry';
  const path = codexHooksPath(projectRoot);
  const existing = readExistingHooksConfig(path);
  const pruned = pruneCodexTelemetryHooks(existing);
  const next = mergeHooksConfig(pruned.config, createCodexHooksConfig(cliCommand));
  writeHooksConfig(path, next);
  return { projectRoot, path, removed: pruned.removed, installed: 5 };
}

export function uninstallCodexHooks(options = {}) {
  const projectRoot = resolve(options.projectRoot || findProjectRoot());
  const path = codexHooksPath(projectRoot);
  if (!existsSync(path)) return { projectRoot, path, removed: 0, changed: false };
  const existing = readExistingHooksConfig(path);
  const pruned = pruneCodexTelemetryHooks(existing);
  writeHooksConfig(path, pruned.config);
  return { projectRoot, path, removed: pruned.removed, changed: pruned.removed > 0 };
}

function configTomlPath(home = homedir()) {
  return resolve(home, '.codex', 'config.toml');
}

function readConfigToml(home) {
  const path = configTomlPath(home);
  if (!existsSync(path)) return { path, text: '' };
  return { path, text: readFileSync(path, 'utf8') };
}

function hasCodexHooksFeature(text) {
  return /(?:^|\n)\s*codex_hooks\s*=\s*true\s*(?:\n|$)/.test(text);
}

function projectIsTrusted(text, projectRoot) {
  const escaped = projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = new RegExp(`\\[projects\\."${escaped}"\\]([\\s\\S]*?)(?:\\n\\[|$)`).exec(text);
  return Boolean(section && /(?:^|\n)\s*trust_level\s*=\s*"trusted"\s*(?:\n|$)/.test(section[1]));
}

function commandExists(command) {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
  return result.status === 0;
}

function countEvents(eventsPath) {
  if (!existsSync(eventsPath)) return 0;
  return readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim()).length;
}

export function doctorCodex(options = {}) {
  const projectRoot = resolve(options.projectRoot || findProjectRoot());
  const home = options.home || homedir();
  const hooksPath = codexHooksPath(projectRoot);
  const telemetryPaths = resolveTelemetryPaths(projectRoot, null, { agent: 'codex' });
  const checks = [];

  let hooksConfig = null;
  if (existsSync(hooksPath)) {
    try {
      hooksConfig = readExistingHooksConfig(hooksPath);
      const { removed } = pruneCodexTelemetryHooks(hooksConfig);
      checks.push({ name: 'project hooks file', ok: true, detail: hooksPath });
      checks.push({
        name: 'claude-telemetry hooks installed',
        ok: removed > 0,
        detail: removed > 0 ? `${removed} hook command(s) found` : 'run claude-telemetry install codex',
      });
    } catch (err) {
      checks.push({ name: 'project hooks file', ok: false, detail: err.message });
    }
  } else {
    checks.push({ name: 'project hooks file', ok: false, detail: `missing ${hooksPath}` });
    checks.push({ name: 'claude-telemetry hooks installed', ok: false, detail: 'run claude-telemetry install codex' });
  }

  const config = readConfigToml(home);
  checks.push({
    name: 'features.codex_hooks',
    ok: hasCodexHooksFeature(config.text),
    detail: hasCodexHooksFeature(config.text)
      ? config.path
      : `enable [features] codex_hooks = true in ${config.path}`,
  });
  checks.push({
    name: 'project trusted',
    ok: projectIsTrusted(config.text, projectRoot),
    detail: projectIsTrusted(config.text, projectRoot)
      ? projectRoot
      : 'trust this project in Codex before project hooks can load',
  });
  checks.push({
    name: 'CLI on PATH',
    ok: commandExists('claude-telemetry'),
    detail: commandExists('claude-telemetry') ? 'claude-telemetry' : 'run npm install -g claude-telemetry',
  });

  try {
    mkdirSync(telemetryPaths.dir, { recursive: true });
    const probe = resolve(telemetryPaths.dir, `.doctor-${process.pid}.tmp`);
    writeFileSync(probe, 'ok\n');
    rmSync(probe, { force: true });
    checks.push({ name: 'telemetry directory writable', ok: true, detail: telemetryPaths.dir });
  } catch (err) {
    checks.push({ name: 'telemetry directory writable', ok: false, detail: err.message });
  }

  const eventCount = countEvents(telemetryPaths.events);
  checks.push({ name: 'codex telemetry events', ok: eventCount > 0, detail: `${eventCount} event(s)` });

  return {
    projectRoot,
    hooksPath,
    telemetryDir: telemetryPaths.dir,
    checks,
    ok: checks.every((check) => check.ok || check.name === 'codex telemetry events'),
  };
}
