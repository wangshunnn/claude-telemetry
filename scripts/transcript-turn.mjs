import { createReadStream, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { projectBucketStem } from './paths.mjs';

export const MAX_REPLY_LEN = 4000;

export function emptyTurnData() {
  return {
    reply: '',
    replyTs: '',
    requestId: '',
    model: '',
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    maxContextTokens: 0,
    apiCalls: 0,
    transcriptSource: '',
  };
}

export function coerceReply(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceReply(item))
      .filter(Boolean)
      .join('\n\n');
  }
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (!value.type && typeof value.text === 'string') return value.text;
  if ('content' in value) return coerceReply(value.content);
  if (value.message && typeof value.message === 'object') return coerceReply(value.message.content);
  return '';
}

function tsToMs(ts) {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}

function isToolResultUserRecord(rec) {
  if (rec?.toolUseResult) return true;
  const content = rec?.message?.content;
  return Array.isArray(content) && content.some((item) => item && item.type === 'tool_result');
}

export function hasTurnData(turn) {
  if (!turn) return false;
  const tokens = turn.tokens || {};
  return Boolean(
    turn.reply ||
    turn.model ||
    turn.apiCalls ||
    turn.maxContextTokens ||
    tokens.input ||
    tokens.output ||
    tokens.cache_read ||
    tokens.cache_write
  );
}

export async function loadTranscriptRecords(path, cache = new Map()) {
  if (!path || !existsSync(path)) return [];
  if (cache.has(path)) return cache.get(path);

  const records = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {}
  }
  cache.set(path, records);
  return records;
}

export function extractTurnDataFromTranscriptRecords(records, stopTs = '') {
  const stopMs = tsToMs(stopTs);
  let assistantBuf = [];
  for (const rec of records) {
    const recMs = tsToMs(rec.timestamp);
    if (Number.isFinite(stopMs) && Number.isFinite(recMs) && recMs > stopMs) continue;
    if (rec.isSidechain) continue;
    if (rec.type === 'user' && rec.promptId && !rec.isMeta && !isToolResultUserRecord(rec)) {
      assistantBuf = [];
      continue;
    }
    if (rec.type === 'assistant') assistantBuf.push(rec);
  }

  const out = emptyTurnData();
  const seenUsage = new Set();
  for (const rec of assistantBuf) {
    const u = rec.message?.usage || {};
    const usageKey = rec.message?.id || rec.requestId || rec.uuid || '';
    const hasUsage = u && typeof u === 'object' && Object.keys(u).length > 0;
    if (hasUsage && (!usageKey || !seenUsage.has(usageKey))) {
      if (usageKey) seenUsage.add(usageKey);
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
      out.apiCalls += 1;
    }
    if (rec.message?.model) out.model = rec.message.model;

    const text = coerceReply(rec.message?.content);
    if (text) {
      out.reply = text;
      out.replyTs = rec.timestamp || '';
      out.requestId = rec.requestId || '';
    }
  }
  return out;
}

export async function extractTurnDataFromTranscript(path, stopTs = '') {
  const records = await loadTranscriptRecords(path);
  return extractTurnDataFromTranscriptRecords(records, stopTs);
}

export function transcriptPathForSession(sessionId, cwd) {
  if (!sessionId) return '';
  const projectRoot = resolve(cwd || process.cwd());
  return resolve(homedir(), '.claude', 'projects', projectBucketStem(projectRoot), `${sessionId}.jsonl`);
}

export function transcriptCandidates(input, options = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (path, source) => {
    if (typeof path !== 'string' || !path.trim()) return;
    const normalized = resolve(path);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ path: normalized, source });
  };

  add(input.transcript_path, 'hook_input');

  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  if (sessionId && options.agent !== 'codex') {
    const projectRoot = resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    add(transcriptPathForSession(sessionId, projectRoot), 'inferred');
  }

  return candidates;
}
