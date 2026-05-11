#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { ensureTelemetryDir, normalizeAgent, resolveTelemetryPaths } from './paths.mjs';
import {
  MAX_REPLY_LEN,
  coerceReply,
  emptyTurnData,
  extractTurnDataFromTranscript,
  hasTurnData,
  transcriptCandidates,
} from './transcript-turn.mjs';

const TRANSCRIPT_RETRY_ATTEMPTS = 5;
const TRANSCRIPT_RETRY_DELAY_MS = 75;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function extractTurnData(input, agent) {
  const candidates = transcriptCandidates(input, { agent });
  if (!candidates.length) return emptyTurnData();

  let best = emptyTurnData();
  for (let attempt = 0; attempt < TRANSCRIPT_RETRY_ATTEMPTS; attempt += 1) {
    for (const candidate of candidates) {
      const turn = await extractTurnDataFromTranscript(candidate.path);
      if (hasTurnData(turn)) return { ...turn, transcriptSource: candidate.source };
      best = turn;
    }
    if (attempt < TRANSCRIPT_RETRY_ATTEMPTS - 1) await sleep(TRANSCRIPT_RETRY_DELAY_MS);
  }
  return best;
}

async function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  const agent = normalizeAgent(process.argv[2]);
  const hookName = input.hook_event_name || 'Stop';
  const isFailure = hookName === 'StopFailure' || Boolean(input.error || input.error_details);

  const turn = await extractTurnData(input, agent);

  const fallbackReply = coerceReply(input.last_assistant_message);
  let reply = turn.reply || fallbackReply;
  const replySource = turn.reply ? 'transcript' : (fallbackReply ? 'last_assistant_message' : '');
  const truncated = reply.length > MAX_REPLY_LEN;
  if (truncated) reply = reply.slice(0, MAX_REPLY_LEN) + '…';

  const event = {
    ts: new Date().toISOString(),
    session_id: input.session_id || '',
    agent,
    event: 'session_stop',
    stop_status: isFailure ? 'failure' : 'success',
    source_hook: isFailure ? 'StopFailure' : 'Stop',
    reply,
    reply_length: reply.length,
    reply_truncated: truncated,
    reply_source: replySource,
    reply_ts: turn.replyTs,
    request_id: turn.requestId,
    model: turn.model,
    api_calls: turn.apiCalls,
    tokens: turn.tokens,
    max_context_tokens: turn.maxContextTokens,
    transcript_source: turn.transcriptSource,
  };
  if (input.turn_id) event.turn_id = input.turn_id;
  if (isFailure) {
    if (input.error) event.error = input.error;
    if (input.error_details) event.error_details = input.error_details;
  }

  const projectRoot = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.cwd();
  const { events } = ensureTelemetryDir(resolveTelemetryPaths(projectRoot, null, { agent }));
  appendFileSync(events, JSON.stringify(event) + '\n');
}

main().catch(() => process.exit(0));
