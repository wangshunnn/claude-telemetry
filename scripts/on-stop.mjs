#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ensureTelemetryDir } from './paths.mjs';

const MAX_REPLY_LEN = 4000;

async function extractTurnDataFromTranscript(path) {
  const empty = {
    reply: '',
    replyTs: '',
    requestId: '',
    model: '',
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    maxContextTokens: 0,
    apiCalls: 0,
  };
  if (!path || !existsSync(path)) return empty;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let assistantBuf = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.isSidechain) continue;
    if (rec.type === 'user' && rec.promptId && !rec.isMeta) {
      assistantBuf = [];
      continue;
    }
    if (rec.type === 'assistant') assistantBuf.push(rec);
  }

  const out = { ...empty, tokens: { ...empty.tokens } };
  for (const rec of assistantBuf) {
    const u = rec.message?.usage || {};
    const inT = Number(u.input_tokens) || 0;
    const cwT = Number(u.cache_creation_input_tokens) || 0;
    const crT = Number(u.cache_read_input_tokens) || 0;
    const outT = Number(u.output_tokens) || 0;
    out.tokens.input += inT;
    out.tokens.output += outT;
    out.tokens.cache_read += crT;
    out.tokens.cache_write += cwT;
    const ctx = inT + cwT + crT;
    if (ctx > out.maxContextTokens) out.maxContextTokens = ctx;
    if (rec.message?.model) out.model = rec.message.model;
    out.apiCalls += 1;

    const texts = (rec.message?.content || [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    if (texts.length) {
      out.reply = texts.join('\n\n');
      out.replyTs = rec.timestamp || '';
      out.requestId = rec.requestId || '';
    }
  }
  return out;
}

async function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  const hookName = input.hook_event_name || 'Stop';
  const isFailure = hookName === 'StopFailure' || Boolean(input.error || input.error_details);

  const turn = await extractTurnDataFromTranscript(input.transcript_path);

  let reply = turn.reply;
  const truncated = reply.length > MAX_REPLY_LEN;
  if (truncated) reply = reply.slice(0, MAX_REPLY_LEN) + '…';

  const event = {
    ts: new Date().toISOString(),
    session_id: input.session_id || '',
    event: 'session_stop',
    stop_status: isFailure ? 'failure' : 'success',
    source_hook: isFailure ? 'StopFailure' : 'Stop',
    reply,
    reply_length: reply.length,
    reply_truncated: truncated,
    reply_ts: turn.replyTs,
    request_id: turn.requestId,
    model: turn.model,
    api_calls: turn.apiCalls,
    tokens: turn.tokens,
    max_context_tokens: turn.maxContextTokens,
  };
  if (isFailure) {
    if (input.error) event.error = input.error;
    if (input.error_details) event.error_details = input.error_details;
  }

  const { events } = ensureTelemetryDir();
  appendFileSync(events, JSON.stringify(event) + '\n');
}

main().catch(() => process.exit(0));
