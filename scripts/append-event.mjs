#!/usr/bin/env node
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ensureTelemetryDir } from './paths.mjs';

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const n = (v) => (v === undefined ? null : v);

function detectInstalledSkill(name, cwd) {
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

const builders = {
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
    const skillPath = detectInstalledSkill(commandName, i.cwd);
    if (!skillPath) return null;
    return {
      event: 'skill_invoked',
      source_hook: 'UserPromptExpansion',
      skill: commandName,
      args: n(i.args),
    };
  },
};

const profile = process.argv[2];
const build = builders[profile];
if (!build) process.exit(0);

const input = readInput();
const body = build(input);
if (!body) process.exit(0);

const event = { ts: new Date().toISOString(), session_id: input.session_id || '', ...body };

try {
  const { events } = ensureTelemetryDir();
  appendFileSync(events, JSON.stringify(event) + '\n');
} catch {}
