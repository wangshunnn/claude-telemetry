const SNAPSHOT_FILE_NAME = 'snapshot.json';
const AUTO_REFRESH_MS = 60_000;

function safeJson(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

function htmlEsc(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function dashboardAgentMeta(agent) {
  if (agent === 'codex') {
    return {
      key: 'codex',
      name: 'Codex',
      short: 'CX',
      storage: '.codex/telemetry',
      detail: '来自 Codex hook 采集的本地日志',
    };
  }

  return {
    key: 'claude',
    name: 'Claude Code',
    short: 'CC',
    storage: '.claude/telemetry',
    detail: '来自 Claude Code hook 采集的本地日志',
  };
}

function renderPlatformCallout(platform) {
  return [
    '<section class="platform-callout is-' + htmlEsc(platform.key) + '" aria-label="当前 Agent 平台">',
      '<span class="platform-mark" aria-hidden="true">' + htmlEsc(platform.short) + '</span>',
      '<span class="platform-copy">',
        '<span class="platform-eyebrow">当前日志平台</span>',
        '<span class="platform-name">' + htmlEsc(platform.name) + '</span>',
        '<span class="platform-detail">' + htmlEsc(platform.detail) + ' · <code>' + htmlEsc(platform.storage) + '</code></span>',
      '</span>',
    '</section>',
  ].join('');
}

export function dashboardTaskMatchesFilter(task, filter = 'all', query = '') {
  const mode = filter || 'all';
  const knowledgeCount = Number(task?.knowledgeCount || 0);
  const approvalCount = Number(task?.approvalCount || 0);
  const status = String(task?.status || 'success');

  if (mode === 'hit' && knowledgeCount <= 0) return false;
  if (mode === 'miss' && knowledgeCount > 0) return false;
  if (mode === 'approval' && approvalCount <= 0) return false;
  if (mode === 'attention' && status === 'success') return false;

  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;

  const haystack = [
    task?.sessionId,
    task?.displayId,
    task?.prompt,
    task?.status,
    ...(Array.isArray(task?.knowledgeTargets)
      ? task.knowledgeTargets.flatMap((target) => [target.label, target.kind, target.kindLabel])
      : []),
    ...(Array.isArray(task?.subagents)
      ? task.subagents.flatMap((agent) => [agent.id, agent.type])
      : []),
    ...(Array.isArray(task?.events)
      ? task.events.flatMap((event) => [event.label, event.detail, event.key, event.agentId, event.agentType, event.knowledgeKind, event.knowledgeKindLabel])
      : []),
  ].filter(Boolean).join(' ').toLowerCase();

  return haystack.includes(needle);
}

export function renderHtml(snapshot, options = {}) {
  const sourceFile = htmlEsc(options.sourceFile || snapshot.sourceFile || '');
  const outputFile = htmlEsc(options.outputFile || '');
  const snapshotFile = htmlEsc(options.snapshotFile || SNAPSHOT_FILE_NAME);
  const initialPlatform = dashboardAgentMeta(snapshot?.agent);
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEsc(initialPlatform.name)} Telemetry</title>
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
    --skill: #d94841;
    --skill-soft: rgba(217, 72, 65, 0.1);
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
    grid-template-columns: minmax(0, 1.05fr) minmax(360px, 0.95fr);
    gap: 16px;
    margin-bottom: 16px;
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
    padding: 22px 24px;
    position: relative;
    overflow: hidden;
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
    font-size: clamp(28px, 3.2vw, 38px);
    line-height: 1.1;
    font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", serif;
    text-wrap: balance;
  }

  .hero-copy p {
    margin: 14px 0 0;
    max-width: 760px;
    color: var(--muted);
    line-height: 1.65;
    font-size: 15px;
  }

  .source-card {
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .platform-callout {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 14px;
    align-items: center;
    padding: 15px 16px;
    border-radius: var(--radius-lg);
    color: #fff;
    background:
      linear-gradient(135deg, rgba(31, 41, 55, 0.96), rgba(20, 83, 45, 0.9)),
      var(--ink);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
  }

  .platform-callout.is-codex {
    background:
      linear-gradient(135deg, rgba(17, 24, 39, 0.96), rgba(29, 78, 216, 0.88)),
      var(--ink);
  }

  .platform-mark {
    width: 48px;
    aspect-ratio: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.12);
    font-size: 16px;
    font-weight: 900;
    letter-spacing: 0.04em;
  }

  .platform-copy {
    min-width: 0;
  }

  .platform-eyebrow {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.72;
  }

  .platform-name {
    display: block;
    font-size: clamp(24px, 3vw, 32px);
    line-height: 1.05;
    font-weight: 900;
  }

  .platform-detail {
    display: block;
    margin-top: 7px;
    color: rgba(255, 255, 255, 0.76);
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
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
  .badge.is-agent { background: rgba(17, 24, 39, 0.1); color: var(--ink); }

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

  .privacy-note {
    margin: 0;
    padding: 11px 13px;
    border-radius: var(--radius-md);
    border: 1px solid rgba(194, 65, 12, 0.16);
    background: rgba(194, 65, 12, 0.08);
    color: var(--danger);
    font-size: 12px;
    line-height: 1.6;
    font-weight: 700;
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

  .kpi-grid,
  .diagnostic-grid {
    display: grid;
    gap: 14px;
  }

  .kpi-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 14px;
  }

  .diagnostic-grid {
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-bottom: 16px;
  }

  .stat-card {
    padding: 18px;
    border-radius: var(--radius-lg);
    background: var(--panel-strong);
  }

  .stat-card.is-primary {
    border-color: rgba(20, 83, 45, 0.22);
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

  .stat-card.is-primary .stat-value {
    font-size: clamp(34px, 4.2vw, 46px);
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
    color: var(--skill);
    background: var(--skill-soft);
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

  .sessions {
    display: grid;
    gap: 12px;
  }

  .task-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 360px);
    gap: 12px;
    align-items: center;
    margin-bottom: 12px;
  }

  .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .segmented button {
    border: 1px solid rgba(17, 24, 39, 0.1);
    border-radius: 999px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.68);
    color: var(--muted);
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
  }

  .segmented button.is-active {
    background: var(--ink);
    border-color: var(--ink);
    color: #fff;
  }

  .task-search {
    width: 100%;
    border: 1px solid rgba(31, 41, 55, 0.16);
    border-radius: 999px;
    padding: 10px 14px;
    background: rgba(255, 255, 255, 0.82);
    color: var(--ink);
    font-size: 13px;
    outline: none;
  }

  .task-search:focus {
    border-color: rgba(29, 78, 216, 0.46);
    box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.08);
  }

  .task-count-note {
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
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

  .doc-chip.is-skill {
    background: var(--skill-soft);
    color: var(--skill);
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

  .session-agent-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 7px;
    border-radius: 999px;
    background: rgba(124, 58, 237, 0.1);
    color: #6d28d9;
    font-size: 11px;
    font-weight: 800;
    margin-right: 6px;
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

  .session-row.is-knowledge-hit.is-skill-hit td {
    background: rgba(217, 72, 65, 0.07);
  }

  .session-row.is-knowledge-hit.is-skill-hit td:first-child {
    box-shadow: inset 3px 0 0 rgba(217, 72, 65, 0.76);
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

  .session-hit-badge.is-skill {
    background: var(--skill-soft);
    color: var(--skill);
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
    .kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .diagnostic-grid {
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
    .kpi-grid,
    .diagnostic-grid,
    .source-actions,
    .task-toolbar {
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
        <div class="eyebrow" id="platform-eyebrow">${htmlEsc(initialPlatform.name)} Hooks Telemetry</div>
        <h1 id="platform-title">${htmlEsc(initialPlatform.name)} 遥测看板</h1>
        <p>一屏审计当前 Agent 的知识调用是否健康，向下追到需要复盘的轮次。页面默认离线可看；如果要托管到 HTTP(S) 静态站点共享，请优先用 <code>CLAUDE_TELEMETRY_PRIVACY=redacted</code> 生成脱敏快照。</p>
      </article>
      <aside class="source-card" id="source-card">${renderPlatformCallout(initialPlatform)}</aside>
    </section>

    <main id="app"></main>
    <footer>源数据 <code>${sourceFile}</code> · 输出 <code>${outputFile}</code> / <code>${snapshotFile}</code></footer>
  </div>

<script>
const EMBEDDED_SNAPSHOT = ${safeJson(snapshot)};
const AUTO_REFRESH_MS = ${AUTO_REFRESH_MS};
const DEFAULT_REMOTE_FILE = ${JSON.stringify(SNAPSHOT_FILE_NAME)};

${dashboardTaskMatchesFilter.toString()}

const runtime = {
  snapshot: EMBEDDED_SNAPSHOT,
  online: false,
  remoteUrl: '',
  pollHandle: null,
  note: '当前显示构建时内嵌快照。首页主指标按全历史轮次统计；明细区覆盖最近 50 个轮次，每轮展示全部事件明细。',
  inputValue: '',
  lastSyncAt: '',
  viewFilter: 'all',
  searchQuery: '',
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

function knowledgeKindClass(kind, kindLabel) {
  const raw = String(kind || kindLabel || '').trim().toLowerCase();
  const classes = {
    doc: 'is-doc',
    docs: 'is-doc',
    skill: 'is-skill',
  };
  return classes[raw] || '';
}

function targetChip(item) {
  const kindClass = knowledgeKindClass(item && item.kind, item && item.kindLabel);
  return '<span class="doc-chip' + (kindClass ? ' ' + kindClass : '') + '">' + esc(item.kindLabel + ' · ' + item.label) + '</span>';
}

function eventKnowledgeHitClass(event) {
  if (!event || !event.knowledgeHit) return '';
  const kindClass = knowledgeKindClass(event.knowledgeKind, event.knowledgeKindLabel);
  return ['is-knowledge-hit', kindClass ? kindClass + '-hit' : ''].filter(Boolean).join(' ');
}

function eventKnowledgeHitBadge(event) {
  if (!event || !event.knowledgeHit) return '';
  const kindClass = knowledgeKindClass(event.knowledgeKind, event.knowledgeKindLabel);
  const label = kindClass === 'is-skill'
    ? (event.knowledgeKindLabel || 'Skill') + ' 命中'
    : '知识命中';
  return '<span class="session-hit-badge' + (kindClass ? ' ' + kindClass : '') + '">' + esc(label) + '</span>';
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

function agentMeta(snapshot) {
  const agent = snapshot && snapshot.agent === 'codex' ? 'codex' : 'claude';
  if (agent === 'codex') {
    return {
      key: 'codex',
      name: 'Codex',
      short: 'CX',
      storage: '.codex/telemetry',
      detail: '来自 Codex hook 采集的本地日志',
    };
  }

  return {
    key: 'claude',
    name: 'Claude Code',
    short: 'CC',
    storage: '.claude/telemetry',
    detail: '来自 Claude Code hook 采集的本地日志',
  };
}

function renderSourceCard() {
  const snapshot = runtime.snapshot || EMBEDDED_SNAPSHOT;
  const kpi = snapshot.metrics?.kpi || {};
  const privacyMode = snapshot.privacyMode || 'full';
  const platform = agentMeta(snapshot);
  const platformHtml = [
    '<section class="platform-callout is-' + esc(platform.key) + '" aria-label="当前 Agent 平台">',
      '<span class="platform-mark" aria-hidden="true">' + esc(platform.short) + '</span>',
      '<span class="platform-copy">',
        '<span class="platform-eyebrow">当前日志平台</span>',
        '<span class="platform-name">' + esc(platform.name) + '</span>',
        '<span class="platform-detail">' + esc(platform.detail) + ' · <code>' + esc(platform.storage) + '</code></span>',
      '</span>',
    '</section>',
  ].join('');
  const badges = [
    '<span class="badge is-agent">Agent ' + esc(platform.name) + '</span>',
    '<span class="badge ' + (runtime.online ? 'is-online' : 'is-offline') + '">' + (runtime.online ? '在线同步' : '离线快照') + '</span>',
    '<span class="badge ' + (privacyMode === 'redacted' ? 'is-online' : 'is-danger') + '">隐私 ' + esc(privacyMode === 'redacted' ? '已脱敏' : '完整') + '</span>',
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
  const privacyHtml = privacyMode === 'redacted'
    ? '<p class="privacy-note">当前快照已脱敏：prompt、AI 回复、路径和事件明细已隐藏，适合更安全地共享趋势和计数。</p>'
    : '<p class="privacy-note">完整快照可能包含 prompt、AI 回复、绝对路径和审批命令。共享或托管前建议用 <code>CLAUDE_TELEMETRY_PRIVACY=redacted</code> 重新生成。</p>';

  return [
    platformHtml,
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
      privacyHtml,
	    '<div class="source-actions">',
      '<input id="remote-input" type="text" placeholder="./snapshot.json 或 https://.../snapshot.json" value="' + esc(runtime.inputValue) + '">',
      '<button class="btn btn-primary" id="connect-btn">连接在线源</button>',
      '<button class="btn btn-secondary" id="refresh-btn">立即刷新</button>',
      '<button class="btn btn-ghost" id="restore-btn">恢复内嵌</button>',
    '</div>',
  ].join('');
}

function statCard(label, value, note, className) {
  return [
    '<article class="stat-card' + (className ? ' ' + esc(className) : '') + '">',
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
    const hitClass = eventKnowledgeHitClass(event);
    const hitBadge = eventKnowledgeHitBadge(event);
    const agentBadge = event.agentType
      ? '<span class="session-agent-badge">' + esc(event.agentType) + '</span>'
      : '';
    return [
      '<tr class="session-row' + (hitClass ? ' ' + hitClass : '') + '">',
        '<td class="session-time">' + esc(event.ts) + '</td>',
        '<td>' + tag + '</td>',
        '<td class="session-detail' + (hitClass ? ' ' + hitClass : '') + '">' + agentBadge + hitBadge + (hitBadge ? ' ' : '') + esc(event.detail || '—') + '</td>',
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

  const filterOptions = [
    ['all', '全部'],
    ['hit', '已命中'],
    ['miss', '未命中'],
    ['approval', '审批'],
    ['attention', '失败/未结束'],
  ];
  const toolbar = [
    '<div class="task-toolbar">',
      '<div class="segmented" role="group" aria-label="轮次筛选">',
        filterOptions.map(function (item) {
          const key = item[0];
          const label = item[1];
          return '<button type="button" class="' + (runtime.viewFilter === key ? 'is-active' : '') + '" data-task-filter="' + esc(key) + '">' + esc(label) + '</button>';
        }).join(''),
      '</div>',
      '<input class="task-search" id="task-search" type="search" placeholder="搜索 session / target / prompt / event" value="' + esc(runtime.searchQuery) + '">',
    '</div>',
  ].join('');

  const filteredTasks = tasks.filter(function (task) {
    return dashboardTaskMatchesFilter(task, runtime.viewFilter, runtime.searchQuery);
  });
  const countNote = '<div class="task-count-note">显示 ' + esc(filteredTasks.length) + ' / ' + esc(tasks.length) + ' 个最近轮次；快照最多保留最近 50 轮，每轮展示全部事件明细。</div>';
  if (!filteredTasks.length) {
    return toolbar + countNote + emptyState('没有匹配当前筛选条件的轮次。');
  }

  const sessionGroups = buildRecentSessionGroups(filteredTasks);
  const helper = '<div class="task-helper">说明：这里先按最近活跃的 <code>session_id</code> 分组，再在组内按 <code>#N</code> 正序排列轮次。这样既能先看到“最近有哪些会话活跃”，又不会打乱同一会话里的上下文顺序。</div>';
  const contextWindow = runtime.snapshot && runtime.snapshot.metrics && runtime.snapshot.metrics.kpi
    ? Number(runtime.snapshot.metrics.kpi.contextWindow) || 0
    : 0;

  return toolbar + countNote + helper + '<div class="sessions">' + sessionGroups.map(function (session, sessionIndex) {
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
          return targetChip(item);
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
      const subagentPill = (task.subagentCount || 0) > 0
        ? '<span class="pill">subagents ' + esc(task.subagentCount) + '</span>'
        : '';
      const pills = [
        '<span class="pill">' + esc(task.eventCount) + ' events</span>',
        '<span class="pill">' + esc(task.knowledgeCount) + ' 知识命中</span>',
        subagentPill,
        '<span class="pill">耗时 ' + esc(durationLabel) + '</span>',
        outputPill,
        approvalPill,
        idlePill,
      ].filter(Boolean).join('');

      const knowledgeChips = task.knowledgeTargets && task.knowledgeTargets.length
        ? '<div class="doc-chips">' + task.knowledgeTargets.map(function (item) {
            return targetChip(item);
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

  const primaryStats = [
    statCard('知识库调用率', percent(kpi.knowledgeCoverageRate), '命中知识目标的轮次数 / 总轮次数。', 'is-primary'),
    statCard('未命中轮次数', Math.max((kpi.totalTaskCount || 0) - (kpi.knowledgeTaskCount || 0), 0), '这些轮次没有触发任何业务知识目标。', 'is-primary'),
    statCard(
      'Top 目标触发率',
      kpi.topTarget ? percent(kpi.topTarget.knowledgeUsageRate) : '0.0%',
      kpi.topTarget
        ? ('知识内口径 · 全局 ' + percent(kpi.topTarget.globalUsageRate) + ' · ' + kpi.topTarget.label)
        : '知识内口径 · 暂无命中目标',
      'is-primary'
    ),
    statCard('审批打断次数', kpi.totalApprovalCount || 0, (kpi.approvalTaskCount || 0) + ' 个轮次被打断 · 占比 ' + percent(kpi.approvalTaskRate || 0) + (kpi.topApprovalTool ? ' · Top ' + kpi.topApprovalTool.label : ''), 'is-primary'),
  ].join('');

  const diagnosticStats = [
    statCard('总轮次数', kpi.totalTaskCount, '统计单位是一次 user_prompt 对应的一轮对话。'),
    statCard('命中轮次数', kpi.knowledgeTaskCount, '至少触发过 1 个知识库文档 / Rule / Skill 的轮次数。'),
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
    statCard('被调用知识目标', kpi.knowledgeTargetCount, '至少被 1 个轮次命中过的知识目标数。'),
  ].join('');

  return [
    '<section class="kpi-grid">' + primaryStats + '</section>',
    '<section class="diagnostic-grid">' + diagnosticStats + '</section>',
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
      panel('最近活跃会话', '可按命中、未命中、审批、失败/未结束筛选，也可搜索 session、知识目标、prompt 或事件明细。', renderRecentSessions(metrics.recentTasks), '最近 50 轮 · 每轮全部事件'),
    '</div>',
    '<div class="footnote">如果你把这份页面部署到静态站点，且与 <code>' + esc(DEFAULT_REMOTE_FILE) + '</code> 同目录，页面会自动切到在线同步模式并轮询刷新；如果没有在线源，仍然保留这次构建时的离线快照。</div>',
  ].join('');
}

function renderAll(options) {
  const opts = options || {};
  const sourceCard = document.getElementById('source-card');
  const app = document.getElementById('app');
  if (!sourceCard || !app) return;
  const platform = agentMeta(runtime.snapshot);
  const platformTitle = document.getElementById('platform-title');
  const platformEyebrow = document.getElementById('platform-eyebrow');

  if (platformTitle) platformTitle.textContent = platform.name + ' 遥测看板';
  if (platformEyebrow) platformEyebrow.textContent = platform.name + ' Hooks Telemetry';
  document.title = platform.name + ' Telemetry';
  sourceCard.innerHTML = renderSourceCard();
  app.innerHTML = renderDashboard(runtime.snapshot);

  const input = document.getElementById('remote-input');
  const connect = document.getElementById('connect-btn');
  const refresh = document.getElementById('refresh-btn');
  const restore = document.getElementById('restore-btn');
  const taskSearch = document.getElementById('task-search');

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

  document.querySelectorAll('[data-task-filter]').forEach(function (button) {
    button.addEventListener('click', function () {
      runtime.viewFilter = button.getAttribute('data-task-filter') || 'all';
      renderAll();
    });
  });

  if (taskSearch) {
    taskSearch.addEventListener('input', function (event) {
      runtime.searchQuery = event.target.value;
      renderAll({ focusSearch: true });
    });
    if (opts.focusSearch) {
      taskSearch.focus();
      const pos = taskSearch.value.length;
      taskSearch.setSelectionRange(pos, pos);
    }
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
    runtime.note = '已连接在线快照：' + runtime.remoteUrl + '。页面会每 60 秒自动刷新一次；共享前请确认隐私模式是否符合预期。';
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
