import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function resolveTelemetryPaths(projectRoot = resolveProjectRoot()) {
  const dir = resolve(projectRoot, '.claude', 'telemetry');
  return {
    projectRoot,
    dir,
    events: resolve(dir, 'events.jsonl'),
    html: resolve(dir, 'index.html'),
    snapshot: resolve(dir, 'snapshot.json'),
  };
}

export function ensureTelemetryDir(paths = resolveTelemetryPaths()) {
  try {
    mkdirSync(paths.dir, { recursive: true });
  } catch {}
  return paths;
}
