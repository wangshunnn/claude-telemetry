import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_KNOWLEDGE_TARGETS = [
  { kind: 'doc', label: 'Docs', test: (path) => /\/docs\/.*\.md$/i.test(path) },
  { kind: 'rule', label: 'Rule', test: (path) => /\/\.(claude|codex)\/rules\/.*\.md$/i.test(path) },
  { kind: 'skill', label: 'Skill', test: (path) => /\/skills\/[^/]+\/.+/i.test(path) },
  {
    kind: 'agents',
    label: 'Agents',
    test: (path, ctx) => {
      if (!/^(AGENTS|CLAUDE)\.md$/i.test(basename(path))) return false;
      const parent = dirname(path);
      if (parent === ctx.projectRoot) return false;
      // .claude/CLAUDE.md and .agents/AGENTS.md auto-load every session too — treat as root.
      if (dirname(parent) === ctx.projectRoot && /^\.(claude|agents)$/i.test(basename(parent))) return false;
      return true;
    },
  },
  { kind: 'cursor', label: 'Cursor', test: (path) => /\/\.cursor\/rules\/.+\.mdc$/i.test(path) },
  { kind: 'copilot', label: 'Copilot', test: (path) => /\/\.github\/copilot-instructions\.md$/i.test(path) },
];

const CONFIG_CANDIDATES = [
  ['.claude', 'telemetry.config.mjs'],
  ['.claude', 'telemetry.config.js'],
];

function isValidTarget(t) {
  return (
    t &&
    typeof t.kind === 'string' &&
    typeof t.label === 'string' &&
    typeof t.test === 'function'
  );
}

export async function loadKnowledgeTargets(projectRoot) {
  for (const parts of CONFIG_CANDIDATES) {
    const p = resolve(projectRoot, ...parts);
    if (!existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const raw = mod.knowledgeTargets;
      if (!Array.isArray(raw) || raw.length === 0) {
        console.warn(`[claude-telemetry] ${p} must export a non-empty \`knowledgeTargets\` array; using defaults.`);
        return DEFAULT_KNOWLEDGE_TARGETS;
      }
      const valid = raw.filter(isValidTarget);
      if (valid.length !== raw.length) {
        console.warn(`[claude-telemetry] ${raw.length - valid.length} invalid knowledge target(s) in ${p} ignored.`);
      }
      return valid.length ? valid : DEFAULT_KNOWLEDGE_TARGETS;
    } catch (err) {
      console.warn(`[claude-telemetry] failed to load ${p}: ${err.message}. Using defaults.`);
      return DEFAULT_KNOWLEDGE_TARGETS;
    }
  }
  return DEFAULT_KNOWLEDGE_TARGETS;
}
