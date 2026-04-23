import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_KNOWLEDGE_TARGETS, loadKnowledgeTargets } from '../scripts/config.mjs';

const byKind = (kind) => DEFAULT_KNOWLEDGE_TARGETS.find((t) => t.kind === kind);

describe('DEFAULT_KNOWLEDGE_TARGETS', () => {
  it('exposes the 6 expected kinds in order', () => {
    expect(DEFAULT_KNOWLEDGE_TARGETS.map((t) => t.kind)).toEqual([
      'doc', 'rule', 'skill', 'agents', 'cursor', 'copilot',
    ]);
  });

  describe('Docs', () => {
    const doc = byKind('doc');
    it('matches markdown under docs/', () => {
      expect(doc.test('/proj/docs/guide.md')).toBe(true);
      expect(doc.test('/proj/docs/nested/deep.md')).toBe(true);
    });
    it('rejects other markdown', () => {
      expect(doc.test('/proj/README.md')).toBe(false);
      expect(doc.test('/proj/src/notes.md')).toBe(false);
    });
  });

  describe('Rule', () => {
    const rule = byKind('rule');
    it('matches .claude/rules/**/*.md', () => {
      expect(rule.test('/proj/.claude/rules/api.md')).toBe(true);
      expect(rule.test('/proj/.claude/rules/sub/nested.md')).toBe(true);
    });
    it('rejects non-rule files under .claude/', () => {
      expect(rule.test('/proj/.claude/CLAUDE.md')).toBe(false);
      expect(rule.test('/proj/rules/api.md')).toBe(false);
    });
  });

  describe('Skill', () => {
    const skill = byKind('skill');
    it('matches any skills/<name>/SKILL.md', () => {
      expect(skill.test('/proj/.claude/skills/deploy/SKILL.md')).toBe(true);
      expect(skill.test('/proj/plugin/skills/review/SKILL.md')).toBe(true);
    });
    it('rejects other files inside skills/', () => {
      expect(skill.test('/proj/skills/deploy/README.md')).toBe(false);
    });
  });

  describe('Agents (excludes auto-loaded root locations)', () => {
    const agents = byKind('agents');
    const root = '/tmp/proj';
    const ctx = { projectRoot: root };

    it.each([
      [`${root}/CLAUDE.md`,                       false, 'root CLAUDE.md'],
      [`${root}/AGENTS.md`,                       false, 'root AGENTS.md'],
      [`${root}/.claude/CLAUDE.md`,               false, '.claude/CLAUDE.md'],
      [`${root}/.claude/AGENTS.md`,               false, '.claude/AGENTS.md'],
      [`${root}/.agents/AGENTS.md`,               false, '.agents/AGENTS.md'],
      [`${root}/.agents/CLAUDE.md`,               false, '.agents/CLAUDE.md'],
      [`${root}/packages/foo/CLAUDE.md`,          true,  'nested package CLAUDE.md'],
      [`${root}/src/mod/AGENTS.md`,               true,  'nested src AGENTS.md'],
      [`${root}/apps/.claude/CLAUDE.md`,          true,  'nested apps/.claude (not root-level)'],
      [`${root}/.github/CLAUDE.md`,               true,  '.github/CLAUDE.md (not auto-loaded)'],
    ])('%s → %s  %s', (path, expected) => {
      expect(agents.test(path, ctx)).toBe(expected);
    });

    it('rejects non-AGENTS/CLAUDE file names', () => {
      expect(agents.test(`${root}/packages/foo/NOTES.md`, ctx)).toBe(false);
    });

    it('is case-insensitive on the filename', () => {
      expect(agents.test(`${root}/packages/foo/agents.md`, ctx)).toBe(true);
      expect(agents.test(`${root}/packages/foo/Claude.MD`, ctx)).toBe(true);
    });
  });

  describe('Cursor', () => {
    const cursor = byKind('cursor');
    it('matches .cursor/rules/*.mdc', () => {
      expect(cursor.test('/proj/.cursor/rules/api.mdc')).toBe(true);
      expect(cursor.test('/proj/.cursor/rules/sub/nested.mdc')).toBe(true);
    });
    it('rejects .md (wrong extension)', () => {
      expect(cursor.test('/proj/.cursor/rules/api.md')).toBe(false);
    });
  });

  describe('Copilot', () => {
    const copilot = byKind('copilot');
    it('matches .github/copilot-instructions.md', () => {
      expect(copilot.test('/proj/.github/copilot-instructions.md')).toBe(true);
    });
    it('rejects other files', () => {
      expect(copilot.test('/proj/.github/copilot.md')).toBe(false);
      expect(copilot.test('/proj/copilot-instructions.md')).toBe(false);
    });
  });
});

describe('loadKnowledgeTargets', () => {
  let sandbox;
  let warnSpy;

  beforeEach(() => {
    sandbox = resolve(tmpdir(), `claude-tel-cfg-${process.pid}-${Math.random().toString(36).slice(2)}`);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  function writeConfig(content) {
    const dir = resolve(sandbox, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'telemetry.config.mjs'), content);
  }

  it('returns defaults when no config file exists', async () => {
    expect(await loadKnowledgeTargets(sandbox)).toBe(DEFAULT_KNOWLEDGE_TARGETS);
  });

  it('uses a valid user override', async () => {
    writeConfig(`
      export const knowledgeTargets = [
        { kind: 'custom', label: 'Custom', test: (p) => p.endsWith('.md') },
      ];
    `);
    const targets = await loadKnowledgeTargets(sandbox);
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('custom');
  });

  it('falls back to defaults when knowledgeTargets export is missing', async () => {
    writeConfig(`export const notThis = [];`);
    expect(await loadKnowledgeTargets(sandbox)).toBe(DEFAULT_KNOWLEDGE_TARGETS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to defaults when the file throws on import', async () => {
    writeConfig(`syntax error !!!`);
    expect(await loadKnowledgeTargets(sandbox)).toBe(DEFAULT_KNOWLEDGE_TARGETS);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('filters invalid entries but keeps valid ones', async () => {
    writeConfig(`
      export const knowledgeTargets = [
        { kind: 'ok', label: 'OK', test: () => false },
        { kind: 'bad', label: 123 },
        null,
      ];
    `);
    const targets = await loadKnowledgeTargets(sandbox);
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
  });
});
