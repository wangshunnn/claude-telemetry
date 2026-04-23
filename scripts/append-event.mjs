#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { ensureTelemetryDir } from './paths.mjs';

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const n = (v) => (v === undefined ? null : v);

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
};

const profile = process.argv[2];
const build = builders[profile];
if (!build) process.exit(0);

const input = readInput();
const body = build(input);
const event = { ts: new Date().toISOString(), session_id: input.session_id || '', ...body };

try {
  const { events } = ensureTelemetryDir();
  appendFileSync(events, JSON.stringify(event) + '\n');
} catch {}
