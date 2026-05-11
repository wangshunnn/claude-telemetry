import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAgent, resolveProjectRoot, resolveTelemetryPaths, SUPPORTED_AGENTS } from './paths.mjs';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

function eventStats(eventsPath) {
  if (!existsSync(eventsPath)) return { count: 0, updatedAt: '' };
  const text = readFileSync(eventsPath, 'utf8');
  let updatedAt = '';
  try {
    updatedAt = statSync(eventsPath).mtime.toISOString();
  } catch {}
  return {
    count: text.split('\n').filter((line) => line.trim()).length,
    updatedAt,
  };
}

export function agentTelemetrySummary(agent, projectRoot = resolveProjectRoot(agent)) {
  const normalizedAgent = normalizeAgent(agent);
  const paths = resolveTelemetryPaths(projectRoot, null, { agent: normalizedAgent });
  return {
    agent: normalizedAgent,
    label: normalizedAgent === 'codex' ? 'Codex' : 'Claude',
    paths,
    ...eventStats(paths.events),
  };
}

function bestDefaultAgent(summaries) {
  const withEvents = summaries.filter((item) => item.count > 0);
  if (!withEvents.length) return summaries[0]?.agent || 'codex';
  return withEvents
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0].agent;
}

function shouldColorize() {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

function color(code, value, enabled = shouldColorize()) {
  return enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

function platformColor(agent) {
  return agent === 'codex' ? '36;1' : '35;1';
}

export function formatSelectorItem(item, selected, options = {}) {
  const colors = options.colors ?? shouldColorize();
  const marker = selected ? color('32;1', '>', colors) : color('2', ' ', colors);
  const label = selected
    ? color(platformColor(item.agent), item.label, colors)
    : color('1', item.label, colors);
  const count = color(item.count > 0 ? '33;1' : '2', String(item.count).padStart(4), colors);
  const updated = item.updatedAt
    ? color('34', item.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z'), colors)
    : color('2', 'no events', colors);
  const path = color('2', item.paths.dir, colors);

  return [
    `${marker} ${label}`,
    `    ${count} event(s)  ${updated}`,
    `    ${path}`,
  ].join('\n');
}

export function renderSelectorText(summaries, selectedIndex, options = {}) {
  const colors = options.colors ?? shouldColorize();
  return [
    color('1', '选择要打开的 telemetry 看板', colors),
    color('2', '↑/↓ 选择，Enter 打开，q 退出', colors),
    '',
    summaries.map((item, index) => (
      formatSelectorItem(item, index === selectedIndex, { colors })
    )).join('\n\n'),
    '',
  ].join('\n');
}

function printedLineCount(text) {
  return (text.match(/\n/g) || []).length;
}

function renderSelector(summaries, selectedIndex, previousLineCount = 0) {
  const text = renderSelectorText(summaries, selectedIndex);
  if (previousLineCount > 0) {
    process.stdout.write(`\x1b[${previousLineCount}F\x1b[J`);
  }
  process.stdout.write(text);
  return printedLineCount(text);
}

export function selectAgentInteractively(summaries) {
  return new Promise((resolveSelection) => {
    const defaultAgent = bestDefaultAgent(summaries);
    let selectedIndex = Math.max(0, summaries.findIndex((item) => item.agent === defaultAgent));
    let selectorLineCount = 0;
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    const cleanup = () => {
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    selectorLineCount = renderSelector(summaries, selectedIndex);
    stdin.setEncoding('utf8');
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', function onData(chunk) {
      if (chunk === '\u0003' || chunk === 'q') {
        stdin.off('data', onData);
        cleanup();
        resolveSelection(null);
        return;
      }
      if (chunk === '\r' || chunk === '\n') {
        stdin.off('data', onData);
        cleanup();
        resolveSelection(summaries[selectedIndex].agent);
        return;
      }
      if (chunk === '\u001b[A') selectedIndex = Math.max(0, selectedIndex - 1);
      if (chunk === '\u001b[B') selectedIndex = Math.min(summaries.length - 1, selectedIndex + 1);
      selectorLineCount = renderSelector(summaries, selectedIndex, selectorLineCount);
    });
  });
}

function openUrl(url) {
  if (!url || process.env.CLAUDE_TELEMETRY_NO_BROWSER === '1') return;
  const platform = process.platform;
  if (platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else if (platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

export function runBuildForAgent(agent, options = {}) {
  const normalizedAgent = normalizeAgent(agent);
  const result = spawnSync(process.execPath, [resolve(REPO_ROOT, 'scripts', 'build.mjs'), '--agent', normalizedAgent], {
    cwd: options.cwd || process.cwd(),
    env: {
      ...process.env,
      CLAUDE_TELEMETRY_AGENT: normalizedAgent,
    },
    encoding: 'utf8',
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const url = stdout.trim().split('\n').find((line) => /^file:\/\//.test(line));
  if (result.status === 0 && url) openUrl(url);
  return result.status || 0;
}

export async function openDashboard(agentArg) {
  if (agentArg) return runBuildForAgent(agentArg);

  const projectRoot = resolveProjectRoot('codex');
  const summaries = SUPPORTED_AGENTS.map((agent) => agentTelemetrySummary(agent, projectRoot));
  const withEvents = summaries.filter((item) => item.count > 0);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (withEvents.length === 1) return runBuildForAgent(withEvents[0].agent);
    process.stdout.write('Please choose a telemetry agent explicitly: claude-telemetry open codex or claude-telemetry open claude\n');
    return 1;
  }

  const selected = await selectAgentInteractively(summaries);
  if (!selected) return 1;
  return runBuildForAgent(selected);
}
