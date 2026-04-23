#!/usr/bin/env node
/**
 * claude-telemetry dashboard generator
 *
 * Usage: node build.mjs
 *   Reads  <project>/.claude/telemetry/events.jsonl by default
 *   Writes <project>/.claude/telemetry/index.html by default
 *   Writes <project>/.claude/telemetry/snapshot.json by default
 *   Set CLAUDE_TELEMETRY_ROOT to use a custom shared root instead.
 */

import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ensureTelemetryDir } from './paths.mjs';
import { loadKnowledgeTargets } from './config.mjs';
import {
  MAX_REPLY_LEN,
  extractTurnDataFromTranscriptRecords,
  hasTurnData,
  loadTranscriptRecords,
  transcriptPathForSession,
} from './transcript-turn.mjs';
import {
  shortenHome,
  compactPath as _compactPath,
  classifyKnowledgePath as _classifyKnowledgePath,
  extractKnowledgeTarget as _extractKnowledgeTarget,
} from './metrics.mjs';

const { projectRoot: PROJECT_ROOT, events: EVENTS_PATH, html: OUTPUT_PATH, snapshot: SNAPSHOT_PATH } = ensureTelemetryDir();
const SNAPSHOT_FILE_NAME = 'snapshot.json';
const AUTO_REFRESH_MS = 60_000;
const RECENT_TASK_LIMIT = 50;

const KNOWLEDGE_TARGET_DEFS = await loadKnowledgeTargets(PROJECT_ROOT);

const BJ_FULL_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const EVENT_META = {
  session_start: {
    label: 'Session Start',
    shortLabel: 'start',
    color: '#14866d',
  },
  session_stop: {
    label: 'Stop',
    shortLabel: 'stop',
    color: '#6b7280',
  },
  session_stop_failure: {
    label: 'StopFailure',
    shortLabel: 'stop_failure',
    color: '#d94841',
  },
  user_prompt: {
    label: 'User Prompt',
    shortLabel: 'prompt',
    color: '#7c3aed',
  },
  instructions_loaded: {
    label: 'Instructions Loaded',
    shortLabel: 'loaded',
    color: '#d97706',
  },
  tool_read: {
    label: 'Read',
    shortLabel: 'read',
    color: '#2563eb',
  },
  tool_search: {
    label: 'Search',
    shortLabel: 'search',
    color: '#0891b2',
  },
  tool_write: {
    label: 'Write',
    shortLabel: 'write',
    color: '#dc2626',
  },
  skill_invoked: {
    label: 'Skill',
    shortLabel: 'skill',
    color: '#d94841',
  },
  permission_request: {
    label: '审批请求',
    shortLabel: 'approval',
    color: '#f59e0b',
  },
  notification_approval: {
    label: '审批请求',
    shortLabel: 'approval',
    color: '#f59e0b',
  },
  notification_idle: {
    label: '等待输入',
    shortLabel: 'idle',
    color: '#94a3b8',
  },
  notification_other: {
    label: '通知',
    shortLabel: 'notify',
    color: '#a855f7',
  },
  unknown: {
    label: 'Unknown',
    shortLabel: 'unknown',
    color: '#94a3b8',
  },
};

async function loadEvents() {
  if (!existsSync(EVENTS_PATH)) return { events: [], malformed: 0 };

  const events = [];
  let malformed = 0;
  const rl = createInterface({
    input: createReadStream(EVENTS_PATH),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }

  return { events, malformed };
}

function formatBjFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : BJ_FULL_FMT.format(d);
}

function formatBjDay(ts) {
  return formatBjFull(ts).slice(0, 10);
}

function formatBjTime(ts) {
  return formatBjFull(ts).slice(11, 19);
}

function shortSessionId(id) {
  return typeof id === 'string' && id ? id : '(unknown)';
}

function truncate(value, max = 160) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function tsToMs(ts) {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}

function stopEventNeedsTranscriptBackfill(event) {
  if (event?.event !== 'session_stop') return false;
  const tokens = event.tokens || {};
  const hasTokenMeta = Boolean(
    event.model ||
    Number(event.api_calls) ||
    Number(event.max_context_tokens) ||
    Number(tokens.input) ||
    Number(tokens.output) ||
    Number(tokens.cache_read) ||
    Number(tokens.cache_write)
  );
  return !hasTokenMeta || !(typeof event.reply === 'string' && event.reply.length);
}

function mergeTranscriptBackfill(event, turn) {
  if (!hasTurnData(turn)) return event;
  const next = { ...event };
  if (!(typeof next.reply === 'string' && next.reply.length) && turn.reply) {
    const truncated = turn.reply.length > MAX_REPLY_LEN;
    next.reply = truncated ? turn.reply.slice(0, MAX_REPLY_LEN) + '…' : turn.reply;
    next.reply_length = next.reply.length;
    next.reply_truncated = truncated;
    next.reply_source = 'transcript_backfill';
  }
  if (!next.reply_ts && turn.replyTs) next.reply_ts = turn.replyTs;
  if (!next.request_id && turn.requestId) next.request_id = turn.requestId;
  if (!next.model && turn.model) next.model = turn.model;
  if (!Number(next.api_calls) && turn.apiCalls) next.api_calls = turn.apiCalls;
  if (!Number(next.max_context_tokens) && turn.maxContextTokens) {
    next.max_context_tokens = turn.maxContextTokens;
  }
  const tokens = next.tokens || {};
  const hasTokens = Boolean(
    Number(tokens.input) ||
    Number(tokens.output) ||
    Number(tokens.cache_read) ||
    Number(tokens.cache_write)
  );
  if (!hasTokens) next.tokens = turn.tokens;
  if (!next.transcript_source) next.transcript_source = 'build_backfill';
  return next;
}

async function backfillEventsFromTranscripts(events) {
  const cwdBySession = new Map();
  const transcriptCache = new Map();
  const out = [];

  for (const event of events) {
    const sessionId = event.session_id || '';
    if (event.event === 'session_start' && event.cwd && sessionId) {
      cwdBySession.set(sessionId, event.cwd);
    }
    if (!stopEventNeedsTranscriptBackfill(event)) {
      out.push(event);
      continue;
    }

    const transcriptPath = transcriptPathForSession(sessionId, cwdBySession.get(sessionId) || PROJECT_ROOT);
    const records = await loadTranscriptRecords(transcriptPath, transcriptCache);
    const turn = extractTurnDataFromTranscriptRecords(records, event.ts);
    out.push(mergeTranscriptBackfill(event, turn));
  }

  return out;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m + 'm ' + (r < 10 ? '0' + r : r) + 's';
}

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

const compactPath = (p) => _compactPath(p, PROJECT_ROOT);

const classifyKnowledgePath = (p) => _classifyKnowledgePath(p, KNOWLEDGE_TARGET_DEFS, PROJECT_ROOT);
const extractKnowledgeTarget = (e) => _extractKnowledgeTarget(e, KNOWLEDGE_TARGET_DEFS, PROJECT_ROOT);

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function ensureDayBucket(map, day) {
  if (!day || map.has(day)) return;
  map.set(day, {
    day,
    totalTasks: 0,
    hitTasks: 0,
  });
}

function isStopFailure(event) {
  return event?.event === 'session_stop' &&
    (event.stop_status === 'failure' || event.source_hook === 'StopFailure' || Boolean(event.error));
}

function classifyNotification(event) {
  const notificationType = String(event?.notification_type || '');
  const tool = String(event?.tool || event?.tool_name || '');
  if (notificationType === 'permission_prompt') return { kind: 'approval', tool };
  if (notificationType === 'idle_prompt') return { kind: 'idle', tool: '' };

  const msg = String(event?.message || '');
  const permMatch = /needs?\s+your\s+permission\s+to\s+use\s+([\w-]+)/i.exec(msg);
  if (permMatch) return { kind: 'approval', tool: tool || permMatch[1] };
  if (/waiting\s+for\s+your\s+input/i.test(msg)) return { kind: 'idle', tool: '' };
  if (/permission|approve|approval/i.test(msg) || event?.source_hook === 'PermissionRequest') {
    return { kind: 'approval', tool };
  }
  return { kind: 'other', tool: '' };
}

function eventKeyForDisplay(event) {
  if (isStopFailure(event)) return 'session_stop_failure';
  if (event?.event === 'permission_request') return 'permission_request';
  if (event?.event === 'notification') {
    const cls = classifyNotification(event);
    return 'notification_' + cls.kind;
  }
  return event?.event ?? 'unknown';
}

function eventMeta(eventOrKey) {
  const key = typeof eventOrKey === 'string' ? eventOrKey : eventKeyForDisplay(eventOrKey);
  return EVENT_META[key] ?? EVENT_META.unknown;
}

function summarizeEvent(event) {
  const key = eventKeyForDisplay(event);
  const meta = eventMeta(key);
  const knowledgeReadTarget = event.event === 'tool_read' ? classifyKnowledgePath(event.file) : null;
  let label = meta.shortLabel;
  let detail = '';

  switch (event.event) {
    case 'session_start':
      detail = compactPath(event.cwd);
      break;
    case 'session_stop':
      if (key === 'session_stop_failure') {
        detail = [event.error, event.error_details, truncate(event.last_assistant_message, 120)]
          .filter(Boolean)
          .join(' · ');
      }
      break;
    case 'user_prompt':
      detail = truncate(event.prompt, 140);
      break;
    case 'instructions_loaded':
      label = event.raw?.load_reason ? `loaded:${event.raw.load_reason}` : label;
      detail = compactPath(event.raw?.file_path);
      break;
    case 'tool_read':
      detail = compactPath(event.file);
      break;
    case 'tool_search':
      label = event.tool ? `search:${String(event.tool).toLowerCase()}` : label;
      detail = [event.pattern, event.glob, compactPath(event.path)].filter(Boolean).join(' · ');
      break;
    case 'tool_write':
      label = event.tool ? `write:${String(event.tool).toLowerCase()}` : label;
      detail = compactPath(event.file);
      break;
    case 'skill_invoked':
      label = event.skill ? `skill:${event.skill}` : label;
      detail = typeof event.args === 'string' ? truncate(event.args, 140) : '';
      break;
    case 'permission_request':
      label = event.tool ? `approval:${event.tool}` : 'approval';
      detail = truncate(
        event.file_path ||
        event.input?.description ||
        event.input?.command ||
        event.description ||
        event.message ||
        '',
        140
      );
      break;
    case 'notification': {
      const cls = classifyNotification(event);
      if (cls.kind === 'approval') {
        label = cls.tool ? `approval:${cls.tool}` : 'approval';
      } else if (cls.kind === 'idle') {
        label = 'idle';
      } else {
        label = 'notify';
      }
      detail = truncate(event.message || event.title || '', 140);
      break;
    }
    default:
      label = event.event ?? label;
      break;
  }

  return {
    ts: formatBjTime(event.ts),
    key,
    color: meta.color,
    label,
    detail,
    knowledgeHit: Boolean(knowledgeReadTarget),
    knowledgeKindLabel: knowledgeReadTarget?.kindLabel ?? '',
  };
}

function computeMetrics(events) {
  const sortedEvents = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const aTs = a.event.ts ?? '';
      const bTs = b.event.ts ?? '';
      if (aTs === bTs) return a.index - b.index;
      return aTs.localeCompare(bTs);
    });

  const sessionState = new Map();
  const tasks = [];
  let lastEventAt = null;

  for (const { event } of sortedEvents) {
    const sessionId = event.session_id ?? '(unknown)';
    if (!lastEventAt || (event.ts ?? '') > lastEventAt) lastEventAt = event.ts ?? lastEventAt;

    if (!sessionState.has(sessionId)) {
      sessionState.set(sessionId, { sequence: 0, openTask: null, pendingPreludeEvents: [] });
    }
    const state = sessionState.get(sessionId);

    if (!state.openTask && event.event === 'instructions_loaded') {
      state.pendingPreludeEvents.push(event);
      continue;
    }

    if (event.event === 'user_prompt') {
      if (state.openTask) {
        state.openTask.end = state.openTask.lastTs || state.openTask.start;
        state.openTask.displayEnd = formatBjFull(state.openTask.end);
        state.openTask.status = state.openTask.status || 'open';
      }

      const preludeEvents = state.pendingPreludeEvents.splice(0);
      const summarizedPreludeEvents = preludeEvents.map((item) => summarizeEvent(item));
      const knowledgeTargets = new Map();

      for (const preludeEvent of preludeEvents) {
        const target = extractKnowledgeTarget(preludeEvent);
        if (!target) continue;
        if (!knowledgeTargets.has(target.key)) {
          knowledgeTargets.set(target.key, {
            ...target,
            sources: new Set([target.source]),
          });
        } else {
          knowledgeTargets.get(target.key).sources.add(target.source);
        }
      }

      state.sequence += 1;
      const task = {
        id: `${sessionId}::${state.sequence}`,
        sessionId,
        sequence: state.sequence,
        prompt: truncate(event.prompt, 220),
        start: event.ts,
        end: event.ts,
        displayStart: formatBjFull(preludeEvents[0]?.ts ?? event.ts),
        displayEnd: formatBjFull(event.ts),
        day: formatBjDay(event.ts),
        status: 'success',
        eventCount: 1 + summarizedPreludeEvents.length,
        knowledgeTargets,
        events: [...summarizedPreludeEvents, summarizeEvent(event)],
        lastTs: event.ts,
        reply: '',
        replyTruncated: false,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        maxContextTokens: 0,
        apiCalls: 0,
        model: '',
        approvalCount: 0,
        idleCount: 0,
        approvalTools: new Map(),
      };
      tasks.push(task);
      state.openTask = task;
      continue;
    }

    if (!state.openTask) continue;

    const task = state.openTask;
    task.eventCount++;
    task.lastTs = event.ts || task.lastTs;
    task.end = event.ts || task.end;
    task.displayEnd = formatBjFull(task.end);
    task.events.push(summarizeEvent(event));

    const target = extractKnowledgeTarget(event);
    if (target) {
      if (!task.knowledgeTargets.has(target.key)) {
        task.knowledgeTargets.set(target.key, {
          ...target,
          sources: new Set([target.source]),
        });
      } else {
        task.knowledgeTargets.get(target.key).sources.add(target.source);
      }
    }

    if (event.event === 'permission_request') {
      task.approvalCount++;
      incrementMap(task.approvalTools, String(event.tool || 'unknown'));
    } else if (event.event === 'notification') {
      const cls = classifyNotification(event);
      if (cls.kind === 'approval') {
        task.approvalCount++;
        const toolKey = cls.tool || 'unknown';
        incrementMap(task.approvalTools, toolKey);
      } else if (cls.kind === 'idle') {
        task.idleCount++;
      }
    }

    if (event.event === 'session_stop') {
      task.status = isStopFailure(event) ? 'failure' : 'success';
      if (typeof event.reply === 'string' && event.reply.length) {
        task.reply = event.reply;
        task.replyTruncated = Boolean(event.reply_truncated);
      }
      if (event.tokens && typeof event.tokens === 'object') {
        task.tokens = {
          input: Number(event.tokens.input) || 0,
          output: Number(event.tokens.output) || 0,
          cache_read: Number(event.tokens.cache_read) || 0,
          cache_write: Number(event.tokens.cache_write) || 0,
        };
      }
      if (Number.isFinite(Number(event.max_context_tokens))) {
        task.maxContextTokens = Number(event.max_context_tokens) || 0;
      }
      if (Number.isFinite(Number(event.api_calls))) {
        task.apiCalls = Number(event.api_calls) || 0;
      }
      if (typeof event.model === 'string') task.model = event.model;
      state.openTask = null;
    }
  }

  for (const state of sessionState.values()) {
    if (!state.openTask) continue;
    state.openTask.end = state.openTask.lastTs || state.openTask.start;
    state.openTask.displayEnd = formatBjFull(state.openTask.end);
    state.openTask.status = state.openTask.status || 'open';
  }

  const dayBuckets = new Map();
  const knowledgeTargetStats = new Map();
  const kindTaskHits = new Map();
  let knowledgeTaskCount = 0;

  for (const task of tasks) {
    ensureDayBucket(dayBuckets, task.day);
    const bucket = dayBuckets.get(task.day);
    bucket.totalTasks++;

    if (task.knowledgeTargets.size > 0) {
      knowledgeTaskCount++;
      bucket.hitTasks++;
    }

    for (const target of task.knowledgeTargets.values()) {
      if (!knowledgeTargetStats.has(target.key)) {
        knowledgeTargetStats.set(target.key, {
          key: target.key,
          label: target.label,
          kind: target.kind,
          kindLabel: target.kindLabel,
          taskHits: 0,
          sources: new Set(),
        });
      }
      const stat = knowledgeTargetStats.get(target.key);
      stat.taskHits++;
      incrementMap(kindTaskHits, target.kindLabel);
      for (const source of target.sources) stat.sources.add(source);
    }
  }

  const totalTaskCount = tasks.length;
  const knowledgeCoverageRate = totalTaskCount ? knowledgeTaskCount / totalTaskCount : 0;

  for (const task of tasks) {
    const startMs = tsToMs(task.start);
    const endMs = tsToMs(task.end);
    task.durationMs = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : 0;
  }

  const closedDurations = tasks
    .filter((task) => task.status !== 'open' && task.durationMs > 0)
    .map((task) => task.durationMs);
  const totalDurationMs = closedDurations.reduce((a, b) => a + b, 0);
  const avgDurationMs = closedDurations.length ? totalDurationMs / closedDurations.length : 0;
  const maxDurationMs = closedDurations.length ? Math.max.apply(null, closedDurations) : 0;

  let totalApprovalCount = 0;
  let totalIdleCount = 0;
  let approvalTaskCount = 0;
  const approvalToolMap = new Map();
  for (const task of tasks) {
    totalApprovalCount += task.approvalCount || 0;
    totalIdleCount += task.idleCount || 0;
    if ((task.approvalCount || 0) > 0) approvalTaskCount += 1;
    if (task.approvalTools) {
      for (const [tool, count] of task.approvalTools) {
        incrementMap(approvalToolMap, tool, count);
      }
    }
  }
  const approvalTools = [...approvalToolMap.entries()]
    .map(([tool, count]) => ({
      label: tool,
      count,
      rate: totalApprovalCount ? count / totalApprovalCount : 0,
      valueLabel: String(count),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const tokenTasks = tasks.filter((task) => (task.maxContextTokens || 0) > 0);
  const totalTokens = tasks.reduce((acc, task) => {
    acc.input += task.tokens?.input || 0;
    acc.output += task.tokens?.output || 0;
    acc.cache_read += task.tokens?.cache_read || 0;
    acc.cache_write += task.tokens?.cache_write || 0;
    return acc;
  }, { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  const avgMaxContextTokens = tokenTasks.length
    ? tokenTasks.reduce((a, t) => a + (t.maxContextTokens || 0), 0) / tokenTasks.length
    : 0;
  const peakMaxContextTokens = tokenTasks.length
    ? Math.max.apply(null, tokenTasks.map((t) => t.maxContextTokens || 0))
    : 0;

  const knowledgeTargets = [...knowledgeTargetStats.values()]
    .map((item) => ({
      ...item,
      usageRate: totalTaskCount ? item.taskHits / totalTaskCount : 0,
      globalUsageRate: totalTaskCount ? item.taskHits / totalTaskCount : 0,
      knowledgeUsageRate: knowledgeTaskCount ? item.taskHits / knowledgeTaskCount : 0,
      sourceLabels: [...item.sources].sort(),
      valueLabel: `${item.taskHits} / ${totalTaskCount}`,
      globalValueLabel: `${item.taskHits} / ${totalTaskCount}`,
      knowledgeValueLabel: `${item.taskHits} / ${knowledgeTaskCount || 0}`,
    }))
    .sort((a, b) => {
      if (b.taskHits !== a.taskHits) return b.taskHits - a.taskHits;
      return a.label.localeCompare(b.label);
    });

  const topTarget = knowledgeTargets[0] ?? null;

  return {
    kpi: {
      totalTaskCount,
      knowledgeTaskCount,
      knowledgeCoverageRate,
      knowledgeTargetCount: knowledgeTargets.length,
      topTarget,
      lastEventAt,
      avgDurationMs,
      maxDurationMs,
      totalDurationMs,
      durationSampleCount: closedDurations.length,
      avgMaxContextTokens,
      peakMaxContextTokens,
      tokenSampleCount: tokenTasks.length,
      totalTokens,
      contextWindow: null,
      totalApprovalCount,
      totalIdleCount,
      approvalTaskCount,
      approvalTaskRate: totalTaskCount ? approvalTaskCount / totalTaskCount : 0,
      topApprovalTool: approvalTools[0] || null,
    },
    approvalTools,
    taskTrend: [...dayBuckets.values()]
      .map((item) => ({
        ...item,
        missTasks: Math.max(item.totalTasks - item.hitTasks, 0),
        coverageRate: item.totalTasks ? item.hitTasks / item.totalTasks : 0,
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    knowledgeTargets: knowledgeTargets.slice(0, 12),
    knowledgeKinds: [...kindTaskHits.entries()]
      .map(([label, count]) => ({ label, count, color: '#2563eb' }))
      .sort((a, b) => b.count - a.count),
    recentTasks: tasks
      .sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''))
      .slice(0, RECENT_TASK_LIMIT)
      .map((task) => ({
        id: task.id,
        sessionId: task.sessionId,
        sequence: task.sequence,
        displayId: `${task.sessionId}#${task.sequence}`,
        prompt: task.prompt,
        start: task.start,
        end: task.end,
        displayStart: task.displayStart,
        displayEnd: task.displayEnd,
        taskLabel: `轮次 #${task.sequence}`,
        status: task.status,
        eventCount: task.eventCount,
        knowledgeCount: task.knowledgeTargets.size,
        knowledgeTargets: [...task.knowledgeTargets.values()]
          .map((target) => ({
            label: target.label,
            kindLabel: target.kindLabel,
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, 8),
        events: task.events.slice(-12),
        durationMs: task.durationMs,
        durationLabel: formatDuration(task.durationMs),
        reply: task.reply || '',
        replyTruncated: Boolean(task.replyTruncated),
        tokens: task.tokens || { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        maxContextTokens: task.maxContextTokens || 0,
        apiCalls: task.apiCalls || 0,
        model: task.model || '',
        approvalCount: task.approvalCount || 0,
        idleCount: task.idleCount || 0,
        approvalTools: [...(task.approvalTools || new Map()).entries()]
          .map(([tool, count]) => ({ tool, count }))
          .sort((a, b) => b.count - a.count),
      })),
  };
}

function buildSnapshot(events, malformed) {
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    projectRoot: shortenHome(PROJECT_ROOT),
    sourceFile: compactPath(EVENTS_PATH),
    eventCount: events.length,
    malformed,
    metrics: computeMetrics(events),
  };
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

function renderHtml(snapshot) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Telemetry</title>
<style>
  :root {
    --bg: #f4efe5;
    --bg-spot: rgba(25, 118, 92, 0.12);
    --panel: rgba(255, 252, 246, 0.92);
    --panel-strong: #fffaf1;
    --border: rgba(40, 58, 74, 0.14);
    --ink: #1f2937;
    --muted: #5f6b7a;
    --accent: #14532d;
    --accent-soft: rgba(20, 83, 45, 0.08);
    --gold: #b45309;
    --gold-soft: rgba(180, 83, 9, 0.1);
    --blue: #1d4ed8;
    --blue-soft: rgba(29, 78, 216, 0.1);
    --danger: #c2410c;
    --danger-soft: rgba(194, 65, 12, 0.1);
    --shadow: 0 18px 60px rgba(38, 49, 61, 0.08);
    --radius-xl: 26px;
    --radius-lg: 20px;
    --radius-md: 14px;
    --radius-sm: 10px;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    color: var(--ink);
    font-family: "Avenir Next", "IBM Plex Sans", "PingFang SC", "Hiragino Sans GB", sans-serif;
    background:
      radial-gradient(circle at top left, var(--bg-spot), transparent 32%),
      radial-gradient(circle at bottom right, rgba(29, 78, 216, 0.08), transparent 36%),
      var(--bg);
  }

  .shell {
    max-width: 1360px;
    margin: 0 auto;
    padding: 32px 20px 56px;
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
    gap: 20px;
    margin-bottom: 24px;
  }

  .hero-copy,
  .source-card,
  .panel,
  .stat-card,
  .empty-state {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow);
    backdrop-filter: blur(12px);
  }

  .hero-copy {
    padding: 28px 30px;
    position: relative;
    overflow: hidden;
  }

  .hero-copy::after {
    content: "";
    position: absolute;
    inset: auto -80px -90px auto;
    width: 220px;
    height: 220px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(20, 83, 45, 0.16), rgba(29, 78, 216, 0.08));
  }

  .eyebrow {
    margin: 0 0 10px;
    color: var(--accent);
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 700;
  }

  h1 {
    margin: 0;
    font-size: clamp(28px, 4vw, 42px);
    line-height: 1.04;
    font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", serif;
    white-space: nowrap;
  }

  .hero-copy p {
    margin: 16px 0 0;
    max-width: 760px;
    color: var(--muted);
    line-height: 1.7;
    font-size: 15px;
  }

  .source-card {
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .source-title {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }

  .source-title h2 {
    margin: 0;
    font-size: 20px;
  }

  .source-title p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .workspace-line {
    color: var(--ink);
    font-size: 13px;
  }

  .workspace-line code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    word-break: break-all;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.06);
    color: var(--ink);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .badge.is-online { background: var(--blue-soft); color: var(--blue); }
  .badge.is-offline { background: var(--accent-soft); color: var(--accent); }
  .badge.is-warn { background: var(--gold-soft); color: var(--gold); }
  .badge.is-danger { background: var(--danger-soft); color: var(--danger); }

  .source-note {
    min-height: 42px;
    margin: 0;
    padding: 12px 14px;
    border-radius: var(--radius-md);
    background: rgba(17, 24, 39, 0.04);
    color: var(--muted);
    font-size: 13px;
    line-height: 1.65;
  }

  .source-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(3, auto);
    gap: 10px;
  }

  .source-actions input {
    width: 100%;
    min-width: 0;
    border: 1px solid rgba(31, 41, 55, 0.16);
    border-radius: 999px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.88);
    color: var(--ink);
    font-size: 13px;
    outline: none;
  }

  .source-actions input:focus {
    border-color: rgba(29, 78, 216, 0.46);
    box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.08);
  }

  .btn {
    border: 0;
    border-radius: 999px;
    padding: 11px 16px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 0.16s ease, opacity 0.16s ease, background 0.16s ease;
  }

  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: var(--ink); color: #fff; }
  .btn-secondary { background: rgba(17, 24, 39, 0.08); color: var(--ink); }
  .btn-ghost { background: transparent; color: var(--muted); border: 1px solid rgba(17, 24, 39, 0.12); }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 16px;
  }

  .stat-card {
    padding: 18px;
    border-radius: var(--radius-lg);
    background: var(--panel-strong);
  }

  .stat-label {
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .stat-value {
    margin-top: 10px;
    font-size: clamp(28px, 4vw, 36px);
    line-height: 1;
    font-weight: 800;
  }

  .stat-note {
    margin-top: 12px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .panel-grid {
    display: grid;
    gap: 16px;
    margin-top: 16px;
  }

  .panel-grid.two-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .panel {
    padding: 22px;
  }

  .panel-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 18px;
  }

  .panel-head h3 {
    margin: 0;
    font-size: 21px;
    font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", serif;
  }

  .panel-head p {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.65;
  }

  .panel-side-note {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .vbars {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(78px, 1fr));
    gap: 14px;
    align-items: end;
    min-height: 240px;
  }

  .vbar {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .vbar-track {
    height: 180px;
    display: flex;
    align-items: end;
    border-radius: 18px;
    background: linear-gradient(180deg, rgba(17, 24, 39, 0.04), rgba(17, 24, 39, 0.12));
    padding: 8px;
  }

  .vbar-fill {
    width: 100%;
    border-radius: 12px;
    min-height: 10px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  .vbar-value {
    font-size: 18px;
    font-weight: 800;
    line-height: 1;
  }

  .vbar-label {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
  }

  .chart-wrap {
    border-radius: var(--radius-md);
    border: 1px solid rgba(17, 24, 39, 0.08);
    background: rgba(255, 255, 255, 0.6);
    overflow: hidden;
  }

  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 14px;
    margin-bottom: 14px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }

  .hbars {
    display: grid;
    gap: 12px;
    --hbar-label-width: 132px;
    --hbar-value-width: 92px;
  }

  .hbar-row {
    display: grid;
    grid-template-columns: var(--hbar-label-width) minmax(0, 1fr) var(--hbar-value-width);
    gap: 12px;
    align-items: center;
  }

  .hbar-row.is-stacked {
    grid-template-columns: 1fr;
    gap: 8px;
    align-items: stretch;
  }

  .hbar-label {
    font-size: 13px;
    color: var(--ink);
    line-height: 1.5;
    word-break: break-word;
    min-width: 0;
  }

  .hbar-label-wrap {
    min-width: 0;
  }

  .hbar-mainline {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .hbar-kind-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid rgba(17, 24, 39, 0.1);
    background: rgba(17, 24, 39, 0.05);
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .hbar-kind-badge.is-doc {
    color: #2563eb;
    background: rgba(37, 99, 235, 0.1);
    border-color: rgba(37, 99, 235, 0.16);
  }

  .hbar-kind-badge.is-rule {
    color: #b45309;
    background: rgba(180, 83, 9, 0.1);
    border-color: rgba(180, 83, 9, 0.16);
  }

  .hbar-kind-badge.is-agents {
    color: #7c3aed;
    background: rgba(124, 58, 237, 0.1);
    border-color: rgba(124, 58, 237, 0.16);
  }

  .hbar-kind-badge.is-skill {
    color: #d94841;
    background: rgba(217, 72, 65, 0.1);
    border-color: rgba(217, 72, 65, 0.16);
  }

  .hbar-kind-badge.is-cursor {
    color: #0891b2;
    background: rgba(8, 145, 178, 0.1);
    border-color: rgba(8, 145, 178, 0.16);
  }

  .hbar-kind-badge.is-copilot {
    color: #16a34a;
    background: rgba(22, 163, 74, 0.1);
    border-color: rgba(22, 163, 74, 0.16);
  }

  .hbar-main {
    display: block;
    min-width: 0;
    color: var(--ink);
    flex: 1 1 240px;
  }

  .hbar-main.is-ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hbar-main.is-path {
    overflow-wrap: normal;
    word-break: normal;
  }

  .hbar-row.is-stacked .hbar-main {
    white-space: normal;
    line-height: 1.45;
  }

  .hbar-bottom {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--hbar-value-width);
    gap: 12px;
    align-items: center;
  }

  .hbar-track {
    width: 100%;
    height: 12px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.08);
    overflow: hidden;
  }

  .hbar-fill {
    height: 100%;
    border-radius: inherit;
  }

  .hbar-value {
    width: var(--hbar-value-width);
    min-width: var(--hbar-value-width);
    text-align: right;
    font-size: 12px;
    color: var(--muted);
    font-weight: 700;
    white-space: nowrap;
  }

  .hbar-value-stack {
    display: grid;
    gap: 2px;
    justify-items: end;
    white-space: normal;
  }

  .hbar-value-main {
    display: block;
    color: var(--ink);
    font-weight: 700;
    line-height: 1.2;
  }

  .hbar-value-sub {
    display: block;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.2;
  }

  .kv-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 18px;
  }

  .kv-card {
    padding: 14px;
    border-radius: var(--radius-md);
    background: rgba(17, 24, 39, 0.05);
  }

  .kv-card span {
    display: block;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .kv-card strong {
    display: block;
    margin-top: 8px;
    font-size: 24px;
    line-height: 1;
  }

  .split-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .mini-block {
    padding: 14px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(17, 24, 39, 0.08);
  }

  .mini-block h4 {
    margin: 0 0 12px;
    font-size: 13px;
    color: var(--muted);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .mini-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .mini-list li {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    font-size: 13px;
    line-height: 1.45;
    color: var(--ink);
  }

  .mini-list li span:first-child {
    color: var(--muted);
    font-weight: 700;
  }

  .mini-list li span:last-child {
    color: var(--muted);
    font-weight: 700;
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
    text-align: right;
  }

  .mini-list code {
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .alert-card {
    padding: 18px;
    border-radius: var(--radius-lg);
    background: linear-gradient(135deg, rgba(194, 65, 12, 0.1), rgba(255, 255, 255, 0.7));
    border: 1px solid rgba(194, 65, 12, 0.18);
  }

  .alert-card.is-ok {
    background: linear-gradient(135deg, rgba(20, 83, 45, 0.08), rgba(255, 255, 255, 0.76));
    border-color: rgba(20, 83, 45, 0.16);
  }

  .alert-card h4 {
    margin: 0;
    font-size: 22px;
  }

  .alert-card p {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.7;
  }

  .sessions {
    display: grid;
    gap: 12px;
  }

  .session-card {
    border: 1px solid rgba(17, 24, 39, 0.08);
    border-radius: var(--radius-lg);
    background: rgba(255, 255, 255, 0.75);
    overflow: hidden;
  }

  .session-card summary {
    list-style: none;
    cursor: pointer;
    padding: 16px 18px;
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
  }

  .session-card summary::-webkit-details-marker { display: none; }

  .session-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .session-caption {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .session-main code {
    width: fit-content;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.08);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 700;
    word-break: break-all;
  }

  .session-main span,
  .session-meta {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .summary-tail {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    min-width: 0;
  }

  .disclosure {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .disclosure-text::before {
    content: "展开";
  }

  .disclosure-icon {
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.08);
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.18s ease, background 0.18s ease, color 0.18s ease;
    flex: 0 0 auto;
  }

  .disclosure-icon svg {
    width: 10px;
    height: 10px;
    display: block;
  }

  .session-card[open] > summary .disclosure-text::before,
  .task-card[open] > summary .disclosure-text::before {
    content: "收起";
  }

  .session-card[open] > summary .disclosure-icon,
  .task-card[open] > summary .disclosure-icon {
    transform: rotate(180deg);
    background: rgba(17, 24, 39, 0.12);
    color: var(--ink);
  }

  .session-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-start;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.08);
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .pill.is-danger {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .pill.is-approval {
    background: var(--gold-soft);
    color: var(--gold);
  }

  .session-body {
    padding: 0 18px 18px;
    border-top: 1px solid rgba(17, 24, 39, 0.08);
  }

  .task-stack {
    display: grid;
    gap: 10px;
    padding-top: 14px;
  }

  .task-card {
    border: 1px solid rgba(17, 24, 39, 0.08);
    border-radius: var(--radius-md);
    background: rgba(244, 239, 229, 0.42);
    overflow: hidden;
  }

  .task-card summary {
    list-style: none;
    cursor: pointer;
    padding: 14px 16px;
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
  }

  .task-card summary::-webkit-details-marker { display: none; }

  .task-main {
    min-width: 0;
  }

  .task-main code {
    display: inline-flex;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.08);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    font-weight: 700;
    word-break: break-all;
  }

  .task-prompt {
    margin-top: 8px;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.55;
    word-break: break-word;
  }

  .task-range {
    margin-top: 6px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .task-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .task-body {
    padding: 0 16px 16px;
    border-top: 1px solid rgba(17, 24, 39, 0.08);
  }

  .doc-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 14px;
  }

  .doc-chip {
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(29, 78, 216, 0.08);
    color: var(--blue);
    font-size: 12px;
    font-weight: 700;
  }

  .reply-block {
    margin-top: 14px;
    padding: 14px;
    border-radius: var(--radius-md);
    background: rgba(20, 83, 45, 0.06);
    border: 1px solid rgba(20, 83, 45, 0.14);
  }

  .reply-block.reply-empty {
    background: rgba(17, 24, 39, 0.04);
    border-color: rgba(17, 24, 39, 0.08);
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }

  .reply-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .reply-meta {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
  }

  .reply-body {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "PingFang SC", "Hiragino Sans GB", "IBM Plex Sans", sans-serif;
    font-size: 13px;
    line-height: 1.65;
    color: var(--ink);
  }

  .token-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .token-meta span {
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(17, 24, 39, 0.06);
  }

  .session-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 14px;
  }

  .session-table td {
    padding: 10px 8px;
    border-top: 1px solid rgba(17, 24, 39, 0.06);
    vertical-align: top;
    font-size: 13px;
    line-height: 1.55;
  }

  .session-time {
    width: 72px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap;
  }

  .session-event-tag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    white-space: nowrap;
  }

  .session-event-tag i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    flex: 0 0 auto;
  }

  .session-detail {
    color: var(--muted);
    word-break: break-word;
  }

  .session-row.is-knowledge-hit td {
    background: rgba(29, 78, 216, 0.06);
  }

  .session-row.is-knowledge-hit td:first-child {
    box-shadow: inset 3px 0 0 rgba(29, 78, 216, 0.72);
  }

  .session-detail.is-knowledge-hit {
    color: var(--ink);
    font-weight: 700;
  }

  .session-hit-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(29, 78, 216, 0.1);
    color: var(--blue);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .empty-state {
    padding: 40px 26px;
    text-align: center;
    color: var(--muted);
    line-height: 1.8;
  }

  .task-helper {
    margin-bottom: 12px;
    padding: 8px 2px 8px 12px;
    border-left: 2px solid rgba(17, 24, 39, 0.12);
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }

  .footnote {
    margin-top: 20px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }

  footer {
    margin-top: 24px;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }

  @media (max-width: 1180px) {
    .hero,
    .panel-grid.two-col,
    .split-grid,
    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .stats-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }

  @media (max-width: 820px) {
    .shell {
      padding-inline: 14px;
      padding-top: 18px;
    }

    .hero,
    .panel-grid.two-col,
    .split-grid,
    .stats-grid,
    .source-actions,
    .kv-grid {
      grid-template-columns: 1fr;
    }

    .source-title {
      flex-direction: column;
    }

    .hbar-row {
      grid-template-columns: 1fr;
    }

    .session-card summary {
      grid-template-columns: 1fr;
    }

    .task-card summary {
      grid-template-columns: 1fr;
    }
  }
</style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <article class="hero-copy">
        <div class="eyebrow">Claude Code Hooks Telemetry</div>
        <h1>Claude Code 遥测看板</h1>
        <p>离线可看，在线可同步。当前页面内嵌了一份构建时快照，所以双击 <code>index.html</code> 就能离线查看；当它被托管到 HTTP(S) 静态站点后，会自动尝试拉取同目录 <code>${SNAPSHOT_FILE_NAME}</code>，并每 60 秒刷新一次，适合拿来做团队共享的在线同步视图。</p>
      </article>
      <aside class="source-card" id="source-card"></aside>
    </section>

    <main id="app"></main>
    <footer>源数据 <code>${compactPath(EVENTS_PATH)}</code> · 输出 <code>${compactPath(OUTPUT_PATH)}</code> / <code>${compactPath(SNAPSHOT_PATH)}</code></footer>
  </div>

<script>
const EMBEDDED_SNAPSHOT = ${safeJson(snapshot)};
const AUTO_REFRESH_MS = ${AUTO_REFRESH_MS};
const DEFAULT_REMOTE_FILE = ${JSON.stringify(SNAPSHOT_FILE_NAME)};

const runtime = {
  snapshot: EMBEDDED_SNAPSHOT,
  online: false,
  remoteUrl: '',
  pollHandle: null,
  note: '当前显示构建时内嵌快照。首页 KPI 与调用率按全历史轮次统计；明细区会按 session 聚合，覆盖最近 50 个轮次，并在组内按自然对话顺序展开。',
  inputValue: '',
  lastSyncAt: '',
};

const trendSeries = [
  { key: 'totalTasks', label: '总轮次数', color: '#94a3b8' },
  { key: 'hitTasks', label: '命中知识库轮次', color: '#2563eb' },
];

const knowledgeKindColors = {
  Docs: '#2563eb',
  Rule: '#b45309',
  Skill: '#d94841',
  Agents: '#7c3aed',
  Cursor: '#0891b2',
  Copilot: '#16a34a',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>\"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

function formatFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

function percent(value) {
  const safe = Number.isFinite(value) ? value : 0;
  return (safe * 100).toFixed(1) + '%';
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m + 'm ' + (r < 10 ? '0' + r : r) + 's';
}

function formatTokensN(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

function renderSourceCard() {
  const snapshot = runtime.snapshot || EMBEDDED_SNAPSHOT;
  const kpi = snapshot.metrics?.kpi || {};
  const badges = [
    '<span class="badge ' + (runtime.online ? 'is-online' : 'is-offline') + '">' + (runtime.online ? '在线同步' : '离线快照') + '</span>',
    '<span class="badge">轮次 ' + esc(kpi.totalTaskCount ?? 0) + '</span>',
    '<span class="badge">知识目标 ' + esc(kpi.knowledgeTargetCount ?? 0) + '</span>',
    '<span class="badge is-warn">调用率 ' + esc(percent(kpi.knowledgeCoverageRate ?? 0)) + '</span>',
    snapshot.malformed ? '<span class="badge is-danger">脏数据 ' + esc(snapshot.malformed) + '</span>' : '',
  ].join('');

  const metaBadges = [
    '<span class="badge">生成 ' + esc(formatFull(snapshot.generatedAt)) + '</span>',
    runtime.lastSyncAt ? '<span class="badge is-online">同步 ' + esc(formatFull(runtime.lastSyncAt)) + '</span>' : '',
    runtime.online ? '<span class="badge is-online">自动刷新 60s</span>' : '',
  ].join('');

  const workspaceHtml = snapshot.projectRoot
    ? '<p class="workspace-line">工作区 <code>' + esc(snapshot.projectRoot) + '</code></p>'
    : '';

  return [
    '<div class="source-title">',
      '<div>',
        '<h2>数据源</h2>',
        workspaceHtml,
        '<p>离线时读内嵌快照；在线时优先拉取同目录 snapshot.json。当前聚焦知识库文档、Rule 和 Skill 的轮次级调用率。</p>',
      '</div>',
      '<div class="badges">' + badges + '</div>',
    '</div>',
    '<div class="badges">' + metaBadges + '</div>',
    '<p class="source-note">' + esc(runtime.note) + '</p>',
    '<div class="source-actions">',
      '<input id="remote-input" type="text" placeholder="./snapshot.json 或 https://.../snapshot.json" value="' + esc(runtime.inputValue) + '">',
      '<button class="btn btn-primary" id="connect-btn">连接在线源</button>',
      '<button class="btn btn-secondary" id="refresh-btn">立即刷新</button>',
      '<button class="btn btn-ghost" id="restore-btn">恢复内嵌</button>',
    '</div>',
  ].join('');
}

function statCard(label, value, note) {
  return [
    '<article class="stat-card">',
      '<div class="stat-label">' + esc(label) + '</div>',
      '<div class="stat-value">' + esc(value) + '</div>',
      '<div class="stat-note">' + esc(note) + '</div>',
    '</article>',
  ].join('');
}

function panel(title, subtitle, body, sideNote) {
  return [
    '<section class="panel">',
      '<div class="panel-head">',
        '<div>',
          '<h3>' + esc(title) + '</h3>',
          '<p>' + esc(subtitle) + '</p>',
        '</div>',
        sideNote ? '<div class="panel-side-note">' + esc(sideNote) + '</div>' : '',
      '</div>',
      body,
    '</section>',
  ].join('');
}

function emptyState(text) {
  return '<div class="empty-state">' + esc(text) + '</div>';
}

function renderVerticalBars(items) {
  if (!items || !items.length) return emptyState('暂无分布数据');
  const max = Math.max.apply(null, items.map(function (item) { return item.count || 0; }).concat([1]));

  return '<div class="vbars">' + items.map(function (item) {
    const height = Math.max(8, Math.round((item.count / max) * 100));
    return [
      '<div class="vbar">',
        '<div class="vbar-track"><div class="vbar-fill" style="height:' + height + '%;background:' + esc(item.color) + '"></div></div>',
        '<div class="vbar-value">' + esc(item.count) + '</div>',
        '<div class="vbar-label">' + esc(item.label) + '</div>',
      '</div>',
    ].join('');
  }).join('') + '</div>';
}

function renderLegend(items) {
  return '<div class="chart-legend">' + items.map(function (item) {
    return '<span class="legend-item"><i class="legend-swatch" style="background:' + esc(item.color) + '"></i>' + esc(item.label) + '</span>';
  }).join('') + '</div>';
}

function renderLineChart(items) {
  if (!items || !items.length) return emptyState('暂无按天趋势数据');

  const activeSeries = trendSeries.filter(function (series) {
    return items.some(function (item) { return Number(item[series.key] || 0) > 0; });
  });
  if (!activeSeries.length) return emptyState('暂无按天趋势数据');

  const width = 720;
  const height = 260;
  const pad = { top: 18, right: 18, bottom: 42, left: 42 };
  const maxY = Math.max.apply(null, items.flatMap(function (item) {
    return activeSeries.map(function (series) { return Number(item[series.key] || 0); });
  }).concat([1]));
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const stepX = items.length === 1 ? 0 : chartWidth / (items.length - 1);

  function xAt(index) {
    return pad.left + (items.length === 1 ? chartWidth / 2 : index * stepX);
  }

  function yAt(value) {
    return pad.top + chartHeight - ((Number(value || 0) / maxY) * chartHeight);
  }

  const grid = [0, 0.25, 0.5, 0.75, 1].map(function (ratio) {
    const y = pad.top + chartHeight - (chartHeight * ratio);
    return [
      '<line x1="' + pad.left + '" y1="' + y + '" x2="' + (width - pad.right) + '" y2="' + y + '" stroke="rgba(17,24,39,0.08)" stroke-width="1" />',
      '<text x="' + (pad.left - 8) + '" y="' + (y + 4) + '" text-anchor="end" fill="#5f6b7a" font-size="11">' + Math.round(maxY * ratio) + '</text>',
    ].join('');
  }).join('');

  const labels = items.map(function (item, index) {
    return '<text x="' + xAt(index) + '" y="' + (height - 12) + '" text-anchor="middle" fill="#5f6b7a" font-size="11">' + esc(item.day.slice(5)) + '</text>';
  }).join('');

  const lines = activeSeries.map(function (series) {
    const points = items.map(function (item, index) {
      return xAt(index) + ',' + yAt(item[series.key]);
    }).join(' ');
    const dots = items.map(function (item, index) {
      return '<circle cx="' + xAt(index) + '" cy="' + yAt(item[series.key]) + '" r="3.4" fill="' + esc(series.color) + '" />';
    }).join('');
    return '<polyline fill="none" stroke="' + esc(series.color) + '" stroke-width="2.5" points="' + points + '" />' + dots;
  }).join('');

  return [
    renderLegend(activeSeries),
    '<div class="chart-wrap"><svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" role="img" aria-label="按天趋势">',
      grid,
      lines,
      labels,
    '</svg></div>',
  ].join('');
}

function renderHorizontalBars(items, emptyText, options) {
  if (!items || !items.length) return emptyState(emptyText);
  const opts = options || {};
  const wrapStyle = [
    opts.labelWidth ? '--hbar-label-width:' + opts.labelWidth : '',
    opts.valueWidth ? '--hbar-value-width:' + opts.valueWidth : '',
  ].filter(Boolean).join(';');
  return '<div class="hbars"' + (wrapStyle ? ' style="' + esc(wrapStyle) + '"' : '') + '>' + items.map(function (item) {
    const width = Number.isFinite(item.rate)
      ? Math.max(6, Math.round(item.rate * 100))
      : Math.max(6, Math.round((item.count / Math.max.apply(null, items.map(function (entry) { return entry.count || 0; }).concat([1]))) * 100));
    const rawLabel = item.label || item.file || item.error || item.reason;
    const mainLabel = item.pathBreaks
      ? esc(rawLabel).split('/').join('/<wbr>')
      : esc(rawLabel);
    const labelHtml = item.eyebrow
      ? '<div class="hbar-label hbar-label-wrap">' +
          '<div class="hbar-mainline">' +
            '<span class="hbar-kind-badge' + (item.kindClass ? ' ' + esc(item.kindClass) : '') + '">' + esc(item.eyebrow) + '</span>' +
            '<span class="hbar-main' + (item.ellipsis ? ' is-ellipsis' : '') + (item.pathBreaks ? ' is-path' : '') + '" title="' + esc(rawLabel) + '">' + mainLabel + '</span>' +
          '</div>' +
        '</div>'
      : '<div class="hbar-label">' + esc(rawLabel) + '</div>';
    const valueHtml = item.subValueLabel
      ? '<div class="hbar-value hbar-value-stack">' +
          '<span class="hbar-value-main">' + esc(item.valueLabel || item.count) + '</span>' +
          '<span class="hbar-value-sub">' + esc(item.subValueLabel) + '</span>' +
        '</div>'
      : '<div class="hbar-value">' + esc(item.valueLabel || item.count) + '</div>';
    const bottomHtml = [
      '<div class="hbar-bottom">',
        '<div class="hbar-track"><div class="hbar-fill" style="width:' + width + '%;background:' + esc(item.color || '#2563eb') + '"></div></div>',
        valueHtml,
      '</div>',
    ].join('');
    if (opts.stacked) {
      return [
        '<div class="hbar-row is-stacked">',
          labelHtml,
          bottomHtml,
        '</div>',
      ].join('');
    }
    return [
        '<div class="hbar-row">',
          labelHtml,
          '<div class="hbar-track"><div class="hbar-fill" style="width:' + width + '%;background:' + esc(item.color || '#2563eb') + '"></div></div>',
          valueHtml,
        '</div>',
      ].join('');
  }).join('') + '</div>';
}

function renderMiniList(items, keyName, valueName, emptyText) {
  if (!items || !items.length) return emptyState(emptyText);
  return '<ul class="mini-list">' + items.map(function (item) {
    return '<li><span>' + esc(item[keyName]) + '</span><span>' + esc(item[valueName]) + '</span></li>';
  }).join('') + '</ul>';
}

function toSequenceValue(task) {
  const value = Number(task && task.sequence);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function buildRecentSessionGroups(tasks) {
  const groups = new Map();

  (tasks || []).forEach(function (task) {
    const sessionId = task.sessionId || task.id || '(unknown)';
    if (!groups.has(sessionId)) {
      groups.set(sessionId, {
        sessionId: sessionId,
        latestEnd: '',
        tasks: [],
        knowledgeTaskCount: 0,
        totalEventCount: 0,
        maxContextTokens: 0,
        knowledgeTargets: new Map(),
      });
    }

    const group = groups.get(sessionId);
    group.tasks.push(task);
    group.totalEventCount += Number(task.eventCount || 0);
    group.maxContextTokens = Math.max(group.maxContextTokens, Number(task.maxContextTokens || 0));
    if (Number(task.knowledgeCount || 0) > 0) group.knowledgeTaskCount += 1;
    if (!group.latestEnd || String(task.end || '').localeCompare(group.latestEnd) > 0) {
      group.latestEnd = String(task.end || '');
    }

    (task.knowledgeTargets || []).forEach(function (target) {
      const key = [target.kindLabel, target.label].join('::');
      if (!group.knowledgeTargets.has(key)) group.knowledgeTargets.set(key, target);
    });
  });

  return Array.from(groups.values())
    .map(function (group) {
      const orderedTasks = group.tasks.slice().sort(function (a, b) {
        const seqDiff = toSequenceValue(a) - toSequenceValue(b);
        if (seqDiff !== 0) return seqDiff;
        return String(a.start || '').localeCompare(String(b.start || ''));
      });
      const firstTask = orderedTasks[0] || {};
      const lastTask = orderedTasks[orderedTasks.length - 1] || {};
      const firstSeq = Number(firstTask.sequence);
      const lastSeq = Number(lastTask.sequence);
      const rangeLabel = Number.isFinite(firstSeq) && Number.isFinite(lastSeq)
        ? (firstSeq === lastSeq ? ('轮次 #' + firstSeq) : ('轮次 #' + firstSeq + ' - #' + lastSeq))
        : '轮次序列';

      return {
        sessionId: group.sessionId,
        latestEnd: group.latestEnd,
        taskCount: orderedTasks.length,
        knowledgeTaskCount: group.knowledgeTaskCount,
        totalEventCount: group.totalEventCount,
        maxContextTokens: group.maxContextTokens,
        displayStart: firstTask.displayStart || formatFull(firstTask.start),
        displayEnd: lastTask.displayEnd || formatFull(lastTask.end),
        latestPrompt: lastTask.prompt || '（空轮次）',
        latestTaskLabel: lastTask.taskLabel || '最新轮次',
        rangeLabel: rangeLabel,
        knowledgeTargets: Array.from(group.knowledgeTargets.values())
          .sort(function (a, b) { return String(a.label || '').localeCompare(String(b.label || '')); })
          .slice(0, 8),
        tasks: orderedTasks,
      };
    })
    .sort(function (a, b) {
      return String(b.latestEnd || '').localeCompare(String(a.latestEnd || ''));
    });
}

function renderTaskRows(events) {
  return (events || []).map(function (event) {
    const tag = '<span class="session-event-tag"><i style="background:' + esc(event.color) + '"></i>' + esc(event.label) + '</span>';
    const hitBadge = event.knowledgeHit ? '<span class="session-hit-badge">知识命中</span>' : '';
    return [
      '<tr class="session-row' + (event.knowledgeHit ? ' is-knowledge-hit' : '') + '">',
        '<td class="session-time">' + esc(event.ts) + '</td>',
        '<td>' + tag + '</td>',
        '<td class="session-detail' + (event.knowledgeHit ? ' is-knowledge-hit' : '') + '">' + hitBadge + (hitBadge ? ' ' : '') + esc(event.detail || '—') + '</td>',
      '</tr>',
    ].join('');
  }).join('');
}

function renderDisclosure() {
  return [
    '<span class="disclosure" aria-hidden="true">',
      '<span class="disclosure-text"></span>',
      '<span class="disclosure-icon">',
        '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">',
          '<path d="M2.25 4.5L6 8.25L9.75 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        '</svg>',
      '</span>',
    '</span>',
  ].join('');
}

function renderRecentSessions(tasks) {
  if (!tasks || !tasks.length) return emptyState('还没有可展示的轮次。');

  const sessionGroups = buildRecentSessionGroups(tasks);
  const helper = '<div class="task-helper">说明：这里先按最近活跃的 <code>session_id</code> 分组，再在组内按 <code>#N</code> 正序排列轮次。这样既能先看到“最近有哪些会话活跃”，又不会打乱同一会话里的上下文顺序；其中 <code>session_id#N</code> 里的 <code>#N</code> 表示该会话的第 N 轮。</div>';
  const contextWindow = runtime.snapshot && runtime.snapshot.metrics && runtime.snapshot.metrics.kpi
    ? Number(runtime.snapshot.metrics.kpi.contextWindow) || 0
    : 0;

  return helper + '<div class="sessions">' + sessionGroups.map(function (session, sessionIndex) {
    const sessionContextLabel = contextWindow
      ? formatTokensN(session.maxContextTokens) + ' / ' + percent(session.maxContextTokens / contextWindow)
      : formatTokensN(session.maxContextTokens);
    const sessionContextPill = session.maxContextTokens
      ? '<span class="pill">ctx峰值 ' + esc(sessionContextLabel) + '</span>'
      : '';
    const sessionPills = [
      '<span class="pill">' + esc(session.taskCount) + ' 轮次</span>',
      '<span class="pill">' + esc(session.knowledgeTaskCount) + ' 命中轮次</span>',
      '<span class="pill">' + esc(session.totalEventCount) + ' events</span>',
      sessionContextPill,
    ].filter(Boolean).join('');

    const sessionChips = session.knowledgeTargets && session.knowledgeTargets.length
      ? '<div class="doc-chips">' + session.knowledgeTargets.map(function (item) {
          return '<span class="doc-chip">' + esc(item.kindLabel + ' · ' + item.label) + '</span>';
        }).join('') + '</div>'
      : '';

    const taskCards = session.tasks.map(function (task) {
      const durationLabel = task.durationLabel || formatDurationMs(task.durationMs);
      const tokens = task.tokens || { input: 0, output: 0, cache_read: 0, cache_write: 0 };
      const outputPill = tokens.output
        ? '<span class="pill">累计 out ' + esc(formatTokensN(tokens.output)) + '</span>'
        : '';
      const approvalPill = (task.approvalCount || 0) > 0
        ? '<span class="pill is-approval">审批 ' + esc(task.approvalCount) + '</span>'
        : '';
      const idlePill = (task.idleCount || 0) > 0
        ? '<span class="pill">等待 ' + esc(task.idleCount) + '</span>'
        : '';
      const pills = [
        '<span class="pill">' + esc(task.eventCount) + ' events</span>',
        '<span class="pill">' + esc(task.knowledgeCount) + ' 知识命中</span>',
        '<span class="pill">耗时 ' + esc(durationLabel) + '</span>',
        outputPill,
        approvalPill,
        idlePill,
      ].filter(Boolean).join('');

      const knowledgeChips = task.knowledgeTargets && task.knowledgeTargets.length
        ? '<div class="doc-chips">' + task.knowledgeTargets.map(function (item) {
            return '<span class="doc-chip">' + esc(item.kindLabel + ' · ' + item.label) + '</span>';
          }).join('') + '</div>'
        : '';

      const tokenMetaBits = [];
      if (tokens.input) tokenMetaBits.push('累计 in ' + formatTokensN(tokens.input));
      if (tokens.output) tokenMetaBits.push('累计 out ' + formatTokensN(tokens.output));
      if (tokens.cache_read) tokenMetaBits.push('累计 cache↘ ' + formatTokensN(tokens.cache_read));
      if (tokens.cache_write) tokenMetaBits.push('累计 cache↗ ' + formatTokensN(tokens.cache_write));
      if (task.model) tokenMetaBits.push(task.model);
      const tokenMeta = tokenMetaBits.length
        ? '<div class="token-meta">' + tokenMetaBits.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '</div>'
        : '';

      const replyBlock = task.reply
        ? [
            '<div class="reply-block">',
              '<div class="reply-head">',
                '<span>AI 回复</span>',
                '<span class="reply-meta">' + esc(task.reply.length + ' 字符') + (task.replyTruncated ? ' · 已截断' : '') + '</span>',
              '</div>',
              tokenMeta,
              '<pre class="reply-body">' + esc(task.reply) + '</pre>',
            '</div>',
          ].join('')
        : [
            '<div class="reply-block reply-empty">',
              '本轮未捕获到 AI 文本回复（多为 Stop hook 触发前无文本输出，或历史数据未记录）。',
              tokenMeta,
            '</div>',
          ].join('');

      return [
        '<details class="task-card">',
          '<summary>',
            '<div class="task-main">',
              '<code>' + esc(task.displayId || ((task.sessionId || task.id) + '#' + (task.sequence ?? '?'))) + '</code>',
              '<div class="task-prompt">' + esc(task.prompt || '（空轮次）') + '</div>',
              '<div class="task-range">' + esc(task.displayStart) + ' → ' + esc(task.displayEnd) + ' · 耗时 ' + esc(durationLabel) + '</div>',
            '</div>',
            '<div class="task-meta">' + pills + '</div>',
            '<div class="summary-tail">' +
              (task.knowledgeCount ? '<span class="badge is-online">已命中</span>' : '<span class="badge is-warn">未命中</span>') +
              renderDisclosure() +
            '</div>',
          '</summary>',
          '<div class="task-body">',
            knowledgeChips,
            '<table class="session-table"><tbody>' + renderTaskRows(task.events) + '</tbody></table>',
            replyBlock,
          '</div>',
        '</details>',
      ].join('');
    }).join('');

    return [
      '<details class="session-card">',
        '<summary>',
          '<div class="session-main">',
            '<span class="session-caption">session_id</span>',
            '<code>' + esc(session.sessionId) + '</code>',
            '<span>' + esc(session.rangeLabel + ' · ' + session.displayStart + ' → ' + session.displayEnd) + '</span>',
            '<span>' + esc('最近：' + session.latestTaskLabel + ' · ' + session.latestPrompt) + '</span>',
          '</div>',
          '<div class="session-meta">' + sessionPills + '</div>',
          '<div class="summary-tail">' +
            (session.knowledgeTaskCount ? '<span class="badge is-online">有知识命中</span>' : '<span class="badge is-warn">暂无命中</span>') +
            renderDisclosure() +
          '</div>',
        '</summary>',
        '<div class="session-body">',
          sessionChips,
          '<div class="task-stack">' + taskCards + '</div>',
        '</div>',
      '</details>',
    ].join('');
  }).join('') + '</div>';
}

function renderDashboard(snapshot) {
  if (!snapshot || !snapshot.eventCount) {
    return emptyState('暂无数据。先让 Claude Code 在当前仓库里跑几轮，再执行 pnpm viz。');
  }

  const metrics = snapshot.metrics;
  const kpi = metrics.kpi;

  const stats = [
    statCard('总轮次数', kpi.totalTaskCount, '统计单位是一次 user_prompt 对应的一轮对话。'),
    statCard('命中轮次数', kpi.knowledgeTaskCount, '至少触发过 1 个知识库文档 / Rule / Skill 的轮次数。'),
    statCard('知识库调用率', percent(kpi.knowledgeCoverageRate), '公式：命中知识目标的轮次数 / 总轮次数。'),
    statCard('平均耗时', formatDurationMs(kpi.avgDurationMs || 0), (kpi.durationSampleCount || 0) + ' 个已结束轮次 · 最长 ' + formatDurationMs(kpi.maxDurationMs || 0)),
    (function () {
      const win = Number(kpi.contextWindow) || 0;
      const avg = kpi.avgMaxContextTokens || 0;
      const peak = kpi.peakMaxContextTokens || 0;
      if (!win) {
        return statCard('平均上下文规模', formatTokensN(avg), (kpi.tokenSampleCount || 0) + ' 个采样 · 峰值 ' + formatTokensN(peak) + ' · 未设置上下文窗口基准');
      }
      const pct = avg ? percent(avg / win) : '0.0%';
      const peakPct = peak ? percent(peak / win) : '0.0%';
      return statCard('平均上下文占用', formatTokensN(avg) + ' / ' + pct, (kpi.tokenSampleCount || 0) + ' 个采样 · 峰值 ' + formatTokensN(peak) + ' / ' + peakPct + ' · 基准 ' + formatTokensN(win));
    })(),
    statCard('累计 Output Token', formatTokensN((kpi.totalTokens && kpi.totalTokens.output) || 0), 'Input ' + formatTokensN((kpi.totalTokens && kpi.totalTokens.input) || 0) + ' · Cache 读 ' + formatTokensN((kpi.totalTokens && kpi.totalTokens.cache_read) || 0) + ' · 写 ' + formatTokensN((kpi.totalTokens && kpi.totalTokens.cache_write) || 0)),
    statCard('审批打断次数', kpi.totalApprovalCount || 0, (kpi.approvalTaskCount || 0) + ' 个轮次被打断 · 占比 ' + percent(kpi.approvalTaskRate || 0) + (kpi.topApprovalTool ? ' · Top ' + kpi.topApprovalTool.label : '')),
    statCard('被调用知识目标', kpi.knowledgeTargetCount, '至少被 1 个轮次命中过的知识目标数。'),
    statCard('未命中轮次数', Math.max((kpi.totalTaskCount || 0) - (kpi.knowledgeTaskCount || 0), 0), '这些轮次没有触发任何业务知识目标。'),
    statCard(
      'Top 目标触发率',
      kpi.topTarget ? percent(kpi.topTarget.knowledgeUsageRate) : '0.0%',
      kpi.topTarget
        ? ('知识内口径 · 全局 ' + percent(kpi.topTarget.globalUsageRate) + ' · 分子 ' + kpi.topTarget.taskHits + ' 轮 · ' + kpi.topTarget.label)
        : '知识内口径 · 暂无命中目标'
    ),
  ].join('');

  return [
    '<section class="stats-grid">' + stats + '</section>',
    '<div class="panel-grid two-col">',
      panel('知识库轮次覆盖趋势', '按天看总轮次数，以及其中有多少轮次触发了知识库 / Rule / Skill。', renderLineChart(metrics.taskTrend), '最近事件 ' + formatFull(kpi.lastEventAt)),
      panel('知识类型分布', '按轮次命中次数统计各类知识目标的出现频次。', renderVerticalBars(metrics.knowledgeKinds.map(function (item) { return { label: item.label, count: item.count, color: knowledgeKindColors[item.label] || '#2563eb' }; })), '轮次级统计'),
    '</div>',
    '<div class="panel-grid two-col">',
      panel('知识库调用榜', '双口径展示：条形按知识命中轮次口径，右侧先展示去重分子轮次，再展示知识内 / 全局触发率。', renderHorizontalBars(
        (metrics.knowledgeTargets || []).map(function (item) {
          return {
            eyebrow: item.kindLabel,
            kindClass: 'is-' + item.kind,
            label: item.label,
            pathBreaks: true,
            count: item.taskHits,
            rate: item.knowledgeUsageRate,
            valueLabel: item.taskHits + ' 轮',
            subValueLabel: '知识内 ' + percent(item.knowledgeUsageRate) + ' · 全局 ' + percent(item.globalUsageRate),
            color: knowledgeKindColors[item.kindLabel] || '#2563eb',
          };
        }),
        '暂无知识库调用记录',
        { stacked: true, valueWidth: '168px' }
      ), '分子按轮次去重；分母：全局 ' + kpi.totalTaskCount + ' · 知识命中 ' + kpi.knowledgeTaskCount),
      panel('口径说明', '这块只保留和知识库调用率直接相关的说明，不再展示预加载、StopFailure、Prompt 等次要指标。', [
        '<div class="mini-block">',
          '<h4>当前统计口径</h4>',
          '<ul class="mini-list">',
            '<li><span>轮次</span><span>一次 user_prompt 对应的一轮对话</span></li>',
            '<li><span>知识目标（默认）</span><span>docs/**/*.md、.claude/rules/**/*.md、**/skills/*/**（含 SKILL.md 与 Skill 工具调用）、子模块 AGENTS.md/CLAUDE.md（排除根、.claude/、.agents/）、.cursor/rules/**/*.mdc、.github/copilot-instructions.md</span></li>',
            '<li><span>分子（去重）</span><span>触发该目标的轮次数；同一轮多次命中只记 1 次</span></li>',
            '<li><span>全局触发率</span><span>触发该目标的轮次数 / 总轮次数</span></li>',
            '<li><span>知识内触发率</span><span>触发该目标的轮次数 / 知识命中轮次数</span></li>',
          '</ul>',
        '</div>',
      ].join(''), '轮次级去重'),
    '</div>',
    '<div class="panel-grid two-col">',
      panel('审批触发工具 TOP', '优先统计 PermissionRequest 结构化事件，并兼容历史 notification 审批记录，按被请求的工具聚合。', renderHorizontalBars(
        (metrics.approvalTools || []).map(function (item) {
          return {
            label: item.label,
            count: item.count,
            rate: item.rate,
            valueLabel: item.count + ' 次 · ' + percent(item.rate || 0),
            color: '#f59e0b',
          };
        }),
        '暂无审批打断记录',
        { labelWidth: '132px', valueWidth: '92px' }
      ), '共 ' + (kpi.totalApprovalCount || 0) + ' 次'),
      panel('审批口径说明', '解释这些数据从哪来、怎么算，避免和其他指标混淆。', [
        '<div class="mini-block">',
          '<h4>来源</h4>',
          '<ul class="mini-list">',
            '<li><span>Hook 事件</span><span><code>permission_request</code>（兼容历史 <code>notification</code>）</span></li>',
            '<li><span>匹配规则</span><span>优先结构化字段：<code>event=permission_request</code> / <code>notification_type=permission_prompt</code></span></li>',
            '<li><span>打断轮次</span><span>该轮至少出现一次审批请求</span></li>',
            '<li><span>等待输入</span><span>' + esc(kpi.totalIdleCount || 0) + ' 次（不计入打断）</span></li>',
          '</ul>',
        '</div>',
      ].join(''), '轮次级统计'),
    '</div>',
    '<div class="panel-grid">',
      panel('最近活跃会话', '明细区覆盖最近 50 个轮次，但会先按 session 聚合；你会先看到最近活跃的会话，再在组内按轮次自然顺序回看上下文。', renderRecentSessions(metrics.recentTasks), 'session 按最近活跃排序，组内按 #N 正序'),
    '</div>',
    '<div class="footnote">如果你把这份页面部署到静态站点，且与 <code>' + esc(DEFAULT_REMOTE_FILE) + '</code> 同目录，页面会自动切到在线同步模式并轮询刷新；如果没有在线源，仍然保留这次构建时的离线快照。</div>',
  ].join('');
}

function renderAll() {
  const sourceCard = document.getElementById('source-card');
  const app = document.getElementById('app');
  if (!sourceCard || !app) return;

  sourceCard.innerHTML = renderSourceCard();
  app.innerHTML = renderDashboard(runtime.snapshot);

  const input = document.getElementById('remote-input');
  const connect = document.getElementById('connect-btn');
  const refresh = document.getElementById('refresh-btn');
  const restore = document.getElementById('restore-btn');

  if (input) {
    input.addEventListener('input', function (event) {
      runtime.inputValue = event.target.value;
    });
  }

  if (connect) {
    connect.addEventListener('click', function () {
      const url = (runtime.inputValue || '').trim() || defaultRemoteUrl();
      if (!url) {
        runtime.note = '当前页面不在 HTTP(S) 环境下，无法自动猜测在线源。可以直接填一个完整 snapshot.json URL。';
        renderAll();
        return;
      }
      loadRemote(url, false);
    });
  }

  if (refresh) {
    refresh.addEventListener('click', function () {
      if (runtime.online && runtime.remoteUrl) {
        loadRemote(runtime.remoteUrl, false);
        return;
      }
      runtime.note = '当前还在离线快照模式。连接一个在线 snapshot.json 后，这里会立即刷新远端数据。';
      renderAll();
    });
  }

  if (restore) {
    restore.addEventListener('click', function () {
      stopPolling();
      runtime.snapshot = EMBEDDED_SNAPSHOT;
      runtime.online = false;
      runtime.remoteUrl = '';
      runtime.lastSyncAt = '';
      runtime.note = '已恢复到内嵌快照，当前完全离线可看。';
      renderAll();
    });
  }
}

function validateSnapshot(snapshot) {
  return snapshot &&
    typeof snapshot === 'object' &&
    snapshot.metrics &&
    Array.isArray(snapshot.metrics.knowledgeTargets) &&
    Array.isArray(snapshot.metrics.taskTrend) &&
    Array.isArray(snapshot.metrics.recentTasks);
}

function defaultRemoteUrl() {
  if (!/^https?:$/.test(location.protocol)) return '';
  return new URL(DEFAULT_REMOTE_FILE, location.href).toString();
}

function urlWithBust(url) {
  const next = new URL(url, location.href);
  next.searchParams.set('_', String(Date.now()));
  return next.toString();
}

function stopPolling() {
  if (runtime.pollHandle) {
    clearInterval(runtime.pollHandle);
    runtime.pollHandle = null;
  }
}

function startPolling(url) {
  stopPolling();
  runtime.pollHandle = setInterval(function () {
    loadRemote(url, true);
  }, AUTO_REFRESH_MS);
}

async function loadRemote(url, silent) {
  try {
    const response = await fetch(urlWithBust(url), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const payload = await response.json();
    if (!validateSnapshot(payload)) {
      throw new Error('snapshot 结构不合法');
    }

    runtime.snapshot = payload;
    runtime.online = true;
    runtime.remoteUrl = new URL(url, location.href).toString();
    runtime.inputValue = runtime.remoteUrl;
    runtime.lastSyncAt = new Date().toISOString();
    runtime.note = '已连接在线快照：' + runtime.remoteUrl + '。页面会每 60 秒自动刷新一次。';
    startPolling(runtime.remoteUrl);
    renderAll();
  } catch (error) {
    if (!runtime.online) {
      runtime.snapshot = EMBEDDED_SNAPSHOT;
    }
    runtime.note = '在线同步失败，继续使用当前快照：' + (error && error.message ? error.message : String(error));
    if (!silent) renderAll();
  }
}

function init() {
  const params = new URLSearchParams(location.search);
  const customSource = params.get('source');
  runtime.inputValue = customSource || defaultRemoteUrl();
  renderAll();

  if (customSource) {
    loadRemote(customSource, false);
    return;
  }

  const defaultUrl = defaultRemoteUrl();
  if (defaultUrl) {
    loadRemote(defaultUrl, true);
  }
}

init();
</script>
</body>
</html>`;
}

const NO_DATA_MESSAGE = [
  '暂无本项目的 telemetry 数据。请完成至少一次 Claude Code 对话后，再次运行 /claude-telemetry:open。',
  'No telemetry turns yet for this project. Collect at least one Claude Code turn, then run /claude-telemetry:open again.',
].join('\n');

function eventsFileIsEmpty() {
  if (!existsSync(EVENTS_PATH)) return true;
  try {
    return statSync(EVENTS_PATH).size === 0;
  } catch {
    return true;
  }
}

if (eventsFileIsEmpty()) {
  if (existsSync(OUTPUT_PATH)) {
    console.log(pathToFileURL(OUTPUT_PATH).toString());
  } else {
    console.log(NO_DATA_MESSAGE);
  }
  process.exit(0);
}

const { events, malformed } = await loadEvents();
const enrichedEvents = await backfillEventsFromTranscripts(events);
const snapshot = buildSnapshot(enrichedEvents, malformed);

writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
writeFileSync(OUTPUT_PATH, renderHtml(snapshot));

const totalTaskCount = Number(snapshot?.metrics?.kpi?.totalTaskCount) || 0;
if (totalTaskCount === 0) {
  console.log(NO_DATA_MESSAGE);
  process.exit(0);
}

console.log(pathToFileURL(OUTPUT_PATH).toString());
