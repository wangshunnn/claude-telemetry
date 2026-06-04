import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { extractReadFilesFromShellCommand } from './metrics.mjs';
import { normalizeAgent } from './paths.mjs';
import { MAX_REPLY_LEN, coerceReply } from './transcript-turn.mjs';

const n = (v) => (v === undefined ? null : v);

function compactInput(input) {
  if (!input || typeof input !== 'object') return n(input);
  const out = {};
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'glob', 'query', 'model', 'subagent_type']) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return Object.keys(out).length ? out : null;
}

function addDefined(out, key, value) {
  if (value !== undefined && value !== null && value !== '') out[key] = value;
}

function truncateText(value, max = MAX_REPLY_LEN) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function textPayload(value) {
  const text = coerceReply(value);
  const truncated = text.length > MAX_REPLY_LEN;
  const body = truncated ? truncateText(text) : text;
  return {
    text: body,
    length: body.length,
    truncated,
  };
}

function claudeCommonFields(input) {
  const out = {};
  addDefined(out, 'agent_id', input?.agent_id);
  addDefined(out, 'agent_type', input?.agent_type);
  addDefined(out, 'tool_use_id', input?.tool_use_id);
  addDefined(out, 'duration_ms', input?.duration_ms);
  return out;
}

function subagentTypeFromToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.subagent_type || input.agent_type || input.agent || input.name || null;
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
  subagent_request: (i) => ({
    event: 'subagent_request',
    source_hook: 'PreToolUse',
    tool: n(i.tool_name),
    agent_type: n(subagentTypeFromToolInput(i.tool_input)),
    description: n(i.tool_input?.description),
    prompt: n(i.tool_input?.prompt),
    model: n(i.tool_input?.model),
  }),
  subagent_start: (i) => ({
    event: 'subagent_start',
    source_hook: 'SubagentStart',
    agent_id: n(i.agent_id),
    agent_type: n(i.agent_type),
  }),
  subagent_stop: (i) => {
    const reply = textPayload(i.last_assistant_message);
    return {
      event: 'subagent_stop',
      source_hook: 'SubagentStop',
      agent_id: n(i.agent_id),
      agent_type: n(i.agent_type),
      agent_transcript_path: n(i.agent_transcript_path),
      reply: reply.text,
      reply_length: reply.length,
      reply_truncated: reply.truncated,
    };
  },
  subagent_result: (i) => {
    const response = textPayload(i.tool_response);
    return {
      event: 'subagent_result',
      source_hook: 'PostToolUse',
      tool: n(i.tool_name),
      agent_type: n(subagentTypeFromToolInput(i.tool_input)),
      description: n(i.tool_input?.description),
      response: response.text,
      response_length: response.length,
      response_truncated: response.truncated,
      duration_ms: n(i.duration_ms),
    };
  },
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
  tool_failure: (i) => ({
    event: 'tool_failure',
    source_hook: 'PostToolUseFailure',
    tool: n(i.tool_name),
    input: compactInput(i.tool_input),
    error: n(i.error || i.error_message || i.tool_error || i.tool_response?.error || i.tool_response?.stderr),
    duration_ms: n(i.duration_ms),
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

function resolveHookPath(path, cwd) {
  if (typeof path !== 'string' || !path) return null;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return resolve(cwd || process.cwd(), path);
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
    for (const file of extractReadFilesFromShellCommand(command, cwd)) {
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
      ...(normalizedAgent === 'claude' ? claudeCommonFields(input || {}) : {}),
      ...event,
    }));
}
