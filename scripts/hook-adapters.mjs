import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { normalizeAgent } from './paths.mjs';

const n = (v) => (v === undefined ? null : v);

function compactInput(input) {
  if (!input || typeof input !== 'object') return n(input);
  const out = {};
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'glob', 'query']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

function detectInstalledClaudeSkill(name, cwd) {
  if (typeof name !== 'string' || !name) return null;
  const trimmed = name.trim();
  if (!trimmed || /[/\\]/.test(trimmed)) return null;
  const home = homedir();
  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const candidates = [
    resolve(base, '.claude', 'skills', trimmed, 'SKILL.md'),
    resolve(home, '.claude', 'skills', trimmed, 'SKILL.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const pluginsDir = resolve(home, '.claude', 'plugins');
  try {
    for (const entry of readdirSync(pluginsDir)) {
      const p = resolve(pluginsDir, entry, 'skills', trimmed, 'SKILL.md');
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

const claudeBuilders = {
  session_start: (i) => ({ event: 'session_start', cwd: n(i.cwd) }),
  user_prompt: (i) => ({ event: 'user_prompt', prompt: n(i.prompt) }),
  notification: (i) => ({
    event: 'notification',
    source_hook: 'Notification',
    notification_type: n(i.notification_type),
    message: n(i.message),
    title: n(i.title),
  }),
  permission_request: (i) => ({
    event: 'permission_request',
    source_hook: 'PermissionRequest',
    permission_mode: n(i.permission_mode),
    tool: n(i.tool_name),
    input: n(i.tool_input),
    suggestions: Array.isArray(i.permission_suggestions)
      ? i.permission_suggestions.map((s) => n(s?.label))
      : [],
    description: n(i.description),
    command: n(i.input?.command),
    file_path: n(i.tool_input?.file_path),
  }),
  instructions_loaded: (i) => {
    const raw = { ...i };
    delete raw.session_id;
    delete raw.hook_event_name;
    delete raw.transcript_path;
    delete raw.cwd;
    return { event: 'instructions_loaded', raw };
  },
  tool_read: (i) => ({ event: 'tool_read', file: n(i.tool_input?.file_path) }),
  tool_search: (i) => ({
    event: 'tool_search',
    tool: n(i.tool_name),
    pattern: n(i.tool_input?.pattern),
    glob: n(i.tool_input?.glob),
    path: n(i.tool_input?.path),
  }),
  tool_bash: (i) => ({
    event: 'tool_bash',
    tool: n(i.tool_name),
    command: n(i.tool_input?.command),
    description: n(i.tool_input?.description),
  }),
  tool_write: (i) => ({
    event: 'tool_write',
    tool: n(i.tool_name),
    file: n(i.tool_input?.file_path),
  }),
  skill_invoked: (i) => ({
    event: 'skill_invoked',
    source_hook: 'PostToolUse',
    skill: n(i.tool_input?.skill),
    args: n(i.tool_input?.args),
  }),
  slash_command: (i) => {
    const commandName = typeof i.command_name === 'string' ? i.command_name.trim() : '';
    if (!commandName) return null;
    const skillPath = detectInstalledClaudeSkill(commandName, i.cwd);
    if (!skillPath) return null;
    return {
      event: 'skill_invoked',
      source_hook: 'UserPromptExpansion',
      skill: commandName,
      args: n(i.args),
    };
  },
};

function splitShellWords(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const words = [];
  let current = '';
  let quote = '';
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    if ('|;&'.includes(ch)) break;
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function isLikelyPath(value) {
  return typeof value === 'string' &&
    value &&
    !value.startsWith('-') &&
    !/^[A-Z_][A-Z0-9_]*=/.test(value) &&
    (value.includes('/') || value.includes('.') || /^[A-Za-z0-9_-]+\.(md|mdc|txt|json|toml|ya?ml)$/i.test(value));
}

function resolveHookPath(path, cwd) {
  if (typeof path !== 'string' || !path) return null;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return resolve(cwd || process.cwd(), path);
}

function extractReadFilesFromBash(command, cwd) {
  const words = splitShellWords(command);
  if (!words.length) return [];
  const executable = basename(words[0]);
  const rest = words.slice(1);

  if (['cat', 'nl'].includes(executable)) {
    return rest.filter(isLikelyPath).map((p) => resolveHookPath(p, cwd)).filter(Boolean);
  }

  if (['head', 'tail'].includes(executable)) {
    const paths = [];
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index];
      if (!isLikelyPath(word)) continue;
      paths.push(resolveHookPath(word, cwd));
    }
    return paths.filter(Boolean);
  }

  if (executable === 'sed') {
    const candidates = rest.filter(isLikelyPath);
    return candidates.slice(-1).map((p) => resolveHookPath(p, cwd)).filter(Boolean);
  }

  return [];
}

function commandFromToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.command === 'string') return input.command;
  return null;
}

function firstPathFromValue(value, cwd) {
  if (!value || typeof value !== 'object') return null;
  const path = value.file_path || value.path || value.uri;
  return typeof path === 'string' ? resolveHookPath(path, cwd) : null;
}

function toolLooksLikeRead(tool, input) {
  const name = String(tool || '').toLowerCase();
  return /(^|__)read($|_)|read_file|filesystem.*read/.test(name) ||
    Boolean(input?.file_path || input?.path || input?.uri);
}

function toolLooksLikeSearch(tool, input) {
  const name = String(tool || '').toLowerCase();
  return /(^|__)(search|grep|glob|find)($|_)/.test(name) ||
    Boolean(input?.pattern || input?.glob || input?.query);
}

function codexPostToolUse(i) {
  const tool = String(i.tool_name || '');
  const input = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {};
  const command = commandFromToolInput(input);
  const cwd = i.cwd || process.cwd();

  if (tool === 'Bash') {
    const events = [{
      event: 'tool_bash',
      source_hook: 'PostToolUse',
      tool,
      command: n(command),
      description: n(input.description),
    }];
    for (const file of extractReadFilesFromBash(command, cwd)) {
      events.push({
        event: 'tool_read',
        source_hook: 'PostToolUse',
        tool,
        file,
      });
    }
    return events;
  }

  if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
    return {
      event: 'tool_write',
      source_hook: 'PostToolUse',
      tool,
      file: n(input.file_path || input.path),
    };
  }

  if (toolLooksLikeSearch(tool, input)) {
    return {
      event: 'tool_search',
      source_hook: 'PostToolUse',
      tool,
      pattern: n(input.pattern || input.query),
      glob: n(input.glob),
      path: n(input.path),
    };
  }

  if (toolLooksLikeRead(tool, input)) {
    return {
      event: 'tool_read',
      source_hook: 'PostToolUse',
      tool,
      file: firstPathFromValue(input, cwd),
    };
  }

  return {
    event: 'tool_use',
    source_hook: 'PostToolUse',
    tool: n(tool),
    input: compactInput(input),
  };
}

const codexBuilders = {
  session_start: (i) => ({
    event: 'session_start',
    source_hook: 'SessionStart',
    cwd: n(i.cwd),
    turn_id: n(i.turn_id),
  }),
  user_prompt: (i) => ({
    event: 'user_prompt',
    source_hook: 'UserPromptSubmit',
    prompt: n(i.prompt),
    turn_id: n(i.turn_id),
  }),
  permission_request: (i) => ({
    event: 'permission_request',
    source_hook: 'PermissionRequest',
    tool: n(i.tool_name),
    input: compactInput(i.tool_input),
    description: n(i.tool_input?.description),
    command: n(i.tool_input?.command),
    file_path: n(i.tool_input?.file_path || i.tool_input?.path),
    turn_id: n(i.turn_id),
  }),
  post_tool_use: codexPostToolUse,
};

export function buildHookEvents(agent, profile, input) {
  const normalizedAgent = normalizeAgent(agent);
  const builders = normalizedAgent === 'codex' ? codexBuilders : claudeBuilders;
  const build = builders[profile];
  if (!build) return [];
  const built = build(input || {});
  const events = Array.isArray(built) ? built : [built];
  return events
    .filter(Boolean)
    .map((event) => ({
      agent: normalizedAgent,
      ...event,
    }));
}
