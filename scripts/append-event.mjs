#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { buildHookEvents } from './hook-adapters.mjs';
import { ensureTelemetryDir, normalizeAgent, resolveTelemetryPaths } from './paths.mjs';

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const profile = process.argv[2];
const agent = normalizeAgent(process.argv[3]);

const input = readInput();
const bodies = buildHookEvents(agent, profile, input);
if (!bodies.length) process.exit(0);

try {
  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.cwd();
  const { events } = ensureTelemetryDir(resolveTelemetryPaths(projectRoot, null, { agent }));
  const ts = new Date().toISOString();
  for (const body of bodies) {
    const event = { ts, session_id: input.session_id || '', ...body };
    appendFileSync(events, JSON.stringify(event) + '\n');
  }
} catch {}
