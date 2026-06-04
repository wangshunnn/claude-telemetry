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
import { ensureTelemetryDir, normalizeAgent, resolveProjectRoot, resolveTelemetryPaths } from './paths.mjs';
import { renderHtml } from './dashboard.mjs';
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
  extractKnowledgeTarget as _extractKnowledgeTarget,
  extractKnowledgeTargets as _extractKnowledgeTargets,
} from './metrics.mjs';

function agentFromArgs(argv = process.argv.slice(2)) {
  const agentFlag = argv.find((arg) => arg.startsWith('--agent='));
  if (agentFlag) return normalizeAgent(agentFlag.slice('--agent='.length));
  const index = argv.indexOf('--agent');
  if (index >= 0) return normalizeAgent(argv[index + 1]);
  return 'claude';
}

const AGENT = agentFromArgs();
const AGENT_LABEL = AGENT === 'codex' ? 'Codex' : 'Claude Code';
const PROJECT_ROOT = resolveProjectRoot(AGENT);
const {
  events: EVENTS_PATH,
  html: OUTPUT_PATH,
  snapshot: SNAPSHOT_PATH,
} = ensureTelemetryDir(resolveTelemetryPaths(PROJECT_ROOT, null, { agent: AGENT }));
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
  tool_bash: {
    label: 'Bash',
    shortLabel: 'bash',
    color: '#475569',
  },
  tool_write: {
    label: 'Write',
    shortLabel: 'write',
    color: '#dc2626',
  },
  tool_use: {
    label: 'Tool',
    shortLabel: 'tool',
    color: '#64748b',
  },
  tool_failure: {
    label: 'Tool Failure',
    shortLabel: 'tool_failure',
    color: '#d94841',
  },
  skill_invoked: {
    label: 'Skill',
    shortLabel: 'skill',
    color: '#d94841',
  },
  subagent_request: {
    label: 'Subagent Request',
    shortLabel: 'agent:request',
    color: '#7c3aed',
  },
  subagent_start: {
    label: 'Subagent Start',
    shortLabel: 'agent:start',
    color: '#14866d',
  },
  subagent_stop: {
    label: 'Subagent Stop',
    shortLabel: 'agent:stop',
    color: '#6b7280',
  },
  subagent_result: {
    label: 'Subagent Result',
    shortLabel: 'agent:result',
    color: '#0891b2',
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
  if (AGENT !== 'claude') return events;

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

const compactPath = (p) => _compactPath(p, PROJECT_ROOT);

const extractKnowledgeTarget = (e) => _extractKnowledgeTarget(e, KNOWLEDGE_TARGET_DEFS, PROJECT_ROOT);
const extractKnowledgeTargets = (e) => _extractKnowledgeTargets(e, KNOWLEDGE_TARGET_DEFS, PROJECT_ROOT) || [];

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function recordKnowledgeTarget(map, target) {
  if (!target) return;
  if (!map.has(target.key)) {
    map.set(target.key, {
      ...target,
      sources: new Set([target.source]),
    });
  } else {
    map.get(target.key).sources.add(target.source);
  }
}

function recordKnowledgeTargets(map, event) {
  for (const target of extractKnowledgeTargets(event)) {
    recordKnowledgeTarget(map, target);
  }
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
  const knowledgeTarget = extractKnowledgeTarget(event);
  let label = meta.shortLabel;
  let detail = '';
  const agentType = typeof event.agent_type === 'string' ? event.agent_type : '';
  const agentId = typeof event.agent_id === 'string' ? event.agent_id : '';
  const toolLabel = (base) => agentType ? `${agentType}:${base}` : base;

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
      label = toolLabel('read');
      detail = compactPath(event.file);
      break;
    case 'tool_search':
      label = event.tool ? toolLabel(`search:${String(event.tool).toLowerCase()}`) : toolLabel(label);
      detail = [event.pattern, event.glob, compactPath(event.path)].filter(Boolean).join(' · ');
      break;
    case 'tool_bash':
      label = toolLabel('bash');
      detail = truncate(event.description || event.command || '', 140);
      break;
    case 'tool_write':
      label = event.tool ? toolLabel(`write:${String(event.tool).toLowerCase()}`) : toolLabel(label);
      detail = compactPath(event.file);
      break;
    case 'tool_use':
      label = event.tool ? toolLabel(`tool:${String(event.tool).toLowerCase()}`) : toolLabel(label);
      detail = truncate(event.input?.description || event.input?.command || event.input?.path || event.input?.query || '', 140);
      break;
    case 'tool_failure':
      label = event.tool ? toolLabel(`fail:${String(event.tool).toLowerCase()}`) : toolLabel('fail');
      detail = truncate(event.error || event.input?.description || event.input?.command || '', 140);
      break;
    case 'skill_invoked':
      label = event.skill ? toolLabel(`skill:${event.skill}`) : toolLabel(label);
      detail = typeof event.args === 'string' ? truncate(event.args, 140) : '';
      break;
    case 'subagent_request':
      detail = [event.agent_type || '', event.description || event.prompt || event.model || '']
        .filter(Boolean)
        .map((item) => truncate(item, 140))
        .join(' · ');
      break;
    case 'subagent_start':
      detail = [event.agent_type || '', event.agent_id || ''].filter(Boolean).join(' · ');
      break;
    case 'subagent_stop':
      detail = [event.agent_type || '', event.reply || event.agent_id || compactPath(event.agent_transcript_path)]
        .filter(Boolean)
        .map((item) => truncate(item, 140))
        .join(' · ');
      break;
    case 'subagent_result':
      detail = [event.agent_type || '', event.response || event.description || '']
        .filter(Boolean)
        .map((item) => truncate(item, 140))
        .join(' · ');
      break;
    case 'permission_request':
      label = event.tool ? toolLabel(`approval:${event.tool}`) : toolLabel('approval');
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
    agentId,
    agentType,
    knowledgeHit: Boolean(knowledgeTarget),
    knowledgeKind: knowledgeTarget?.kind ?? '',
    knowledgeKindLabel: knowledgeTarget?.kindLabel ?? '',
  };
}

function recordSubagent(task, event) {
  const id = typeof event?.agent_id === 'string' ? event.agent_id : '';
  if (!id) return;
  if (!task.subagents.has(id)) {
    task.subagents.set(id, {
      id,
      type: typeof event.agent_type === 'string' ? event.agent_type : '',
    });
    return;
  }
  const current = task.subagents.get(id);
  if (!current.type && typeof event.agent_type === 'string') current.type = event.agent_type;
}

function isPostStopContinuationEvent(event) {
  const eventName = event?.event;
  if (!eventName) return false;
  return ![
    'user_prompt',
    'session_stop',
    'session_start',
    'notification',
    'instructions_loaded',
  ].includes(eventName);
}

function computeTerminalStopIndexes(sortedEvents) {
  const bySession = new Map();
  for (const item of sortedEvents) {
    const sessionId = item.event.session_id ?? '(unknown)';
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(item);
  }

  const terminalStopIndexes = new Set();
  for (const items of bySession.values()) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.event.event !== 'session_stop') continue;

      let isTerminal = true;
      for (let nextIndex = index + 1; nextIndex < items.length; nextIndex += 1) {
        const nextEvent = items[nextIndex].event;
        if (nextEvent.event === 'user_prompt') break;
        if (isPostStopContinuationEvent(nextEvent)) {
          isTerminal = false;
          break;
        }
      }
      if (isTerminal) terminalStopIndexes.add(item.index);
    }
  }
  return terminalStopIndexes;
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
  const terminalStopIndexes = computeTerminalStopIndexes(sortedEvents);

  const sessionState = new Map();
  const tasks = [];
  let lastEventAt = null;

  for (const { event, index } of sortedEvents) {
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
        recordKnowledgeTargets(knowledgeTargets, preludeEvent);
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
        status: 'open',
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
        subagents: new Map(),
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
    recordSubagent(task, event);

    recordKnowledgeTargets(task.knowledgeTargets, event);

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

    if (event.event === 'session_stop' && terminalStopIndexes.has(index)) {
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
            kind: target.kind,
            kindLabel: target.kindLabel,
          }))
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, 8),
        events: task.events,
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
        subagentCount: task.subagents?.size || 0,
        subagents: [...(task.subagents || new Map()).values()]
          .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''))),
      })),
  };
}

function buildSnapshot(events, malformed) {
  const snapshot = {
    version: 2,
    agent: AGENT,
    generatedAt: new Date().toISOString(),
    projectRoot: shortenHome(PROJECT_ROOT),
    sourceFile: compactPath(EVENTS_PATH),
    eventCount: events.length,
    malformed,
    metrics: computeMetrics(events),
  };
  return applyPrivacyMode(snapshot, privacyModeFromEnv());
}

function privacyModeFromEnv() {
  return process.env.CLAUDE_TELEMETRY_PRIVACY === 'redacted' ? 'redacted' : 'full';
}

function redactText(value, placeholder) {
  return typeof value === 'string' && value ? placeholder : value;
}

function applyPrivacyMode(snapshot, privacyMode) {
  const out = structuredClone(snapshot);
  out.privacyMode = privacyMode;
  if (privacyMode !== 'redacted') return out;

  out.projectRoot = '[redacted workspace]';
  out.sourceFile = '[redacted events.jsonl]';

  const targetLabels = new Map();
  const targetRedactedKeys = new Map();
  let targetIndex = 0;
  function redactTarget(target) {
    if (!target || typeof target !== 'object') return target;
    const key = target.key || `${target.kindLabel || target.kind || 'target'}:${target.label || targetIndex}`;
    const labelKey = target.label ? `${target.kindLabel || target.kind || 'Target'}:${target.label}` : '';
    const existingLabel = targetLabels.get(key) || (labelKey ? targetLabels.get(labelKey) : '');
    const existingKey = targetRedactedKeys.get(key) || (labelKey ? targetRedactedKeys.get(labelKey) : '');
    if (!existingLabel) {
      targetIndex += 1;
      const label = `${target.kindLabel || target.kind || 'Target'} #${targetIndex}`;
      const redactedKey = `redacted:${targetIndex}`;
      targetLabels.set(key, label);
      targetRedactedKeys.set(key, redactedKey);
      if (labelKey) targetLabels.set(labelKey, label);
      if (labelKey) targetRedactedKeys.set(labelKey, redactedKey);
    }
    return {
      ...target,
      key: existingKey || targetRedactedKeys.get(key) || targetRedactedKeys.get(labelKey),
      label: targetLabels.get(key) || targetLabels.get(labelKey),
    };
  }

  const metrics = out.metrics || {};
  if (metrics.kpi?.topTarget) metrics.kpi.topTarget = redactTarget(metrics.kpi.topTarget);
  if (Array.isArray(metrics.knowledgeTargets)) {
    metrics.knowledgeTargets = metrics.knowledgeTargets.map(redactTarget);
  }
  if (Array.isArray(metrics.recentTasks)) {
    const sessionLabels = new Map();
    metrics.recentTasks = metrics.recentTasks.map((task, index) => {
      const sessionKey = task.sessionId || task.id || `task-${index + 1}`;
      if (!sessionLabels.has(sessionKey)) {
        sessionLabels.set(sessionKey, `redacted-session-${sessionLabels.size + 1}`);
      }
      const sessionId = sessionLabels.get(sessionKey);
      return {
        ...task,
        id: `${sessionId}::${task.sequence ?? index + 1}`,
        sessionId,
        displayId: `${sessionId}#${task.sequence ?? '?'}`,
        prompt: redactText(task.prompt, '[redacted prompt]'),
        reply: redactText(task.reply, '[redacted reply]'),
        model: redactText(task.model, '[redacted model]'),
        subagents: Array.isArray(task.subagents)
          ? task.subagents.map((_subagent, subagentIndex) => ({
              id: `redacted-subagent-${subagentIndex + 1}`,
              type: '[redacted subagent]',
            }))
          : [],
        knowledgeTargets: Array.isArray(task.knowledgeTargets)
          ? task.knowledgeTargets.map(redactTarget)
          : [],
        events: Array.isArray(task.events)
          ? task.events.map((event) => ({
              ...event,
              label: event.agentType ? String(event.label || '').replace(String(event.agentType), '[redacted subagent]') : event.label,
              detail: redactText(event.detail, '[redacted detail]'),
              agentId: redactText(event.agentId, '[redacted subagent]'),
              agentType: redactText(event.agentType, '[redacted subagent]'),
            }))
          : [],
      };
    });
  }
  return out;
}

const NO_DATA_MESSAGE = [
  AGENT === 'claude'
    ? '暂无本项目的 telemetry 数据。请完成至少一次 Claude Code 对话后，再次运行 /claude-telemetry:open。'
    : '暂无本项目的 Codex telemetry 数据。请完成至少一次 Codex 对话后，再次运行 claude-telemetry open codex。',
  AGENT === 'claude'
    ? 'No telemetry turns yet for this project. Collect at least one Claude Code turn, then run /claude-telemetry:open again.'
    : 'No Codex telemetry turns yet for this project. Collect at least one Codex turn, then run claude-telemetry open codex again.',
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
writeFileSync(OUTPUT_PATH, renderHtml(snapshot, {
  sourceFile: snapshot.privacyMode === 'redacted' ? snapshot.sourceFile : compactPath(EVENTS_PATH),
  outputFile: snapshot.privacyMode === 'redacted' ? '[redacted index.html]' : compactPath(OUTPUT_PATH),
  snapshotFile: snapshot.privacyMode === 'redacted' ? '[redacted snapshot.json]' : compactPath(SNAPSHOT_PATH),
}));

const totalTaskCount = Number(snapshot?.metrics?.kpi?.totalTaskCount) || 0;
if (totalTaskCount === 0) {
  console.log(NO_DATA_MESSAGE);
  process.exit(0);
}

console.log(pathToFileURL(OUTPUT_PATH).toString());
