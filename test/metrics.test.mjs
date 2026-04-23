import { describe, it, expect } from 'vitest';
import {
  shortenHome,
  compactPath,
  classifyKnowledgePath,
  extractKnowledgeTarget,
} from '../scripts/metrics.mjs';
import { DEFAULT_KNOWLEDGE_TARGETS } from '../scripts/config.mjs';

describe('shortenHome', () => {
  const home = '/Users/dev';

  it('replaces HOME prefix with ~', () => {
    expect(shortenHome('/Users/dev/code/app', home)).toBe('~/code/app');
  });

  it('returns exactly ~ when path equals HOME', () => {
    expect(shortenHome('/Users/dev', home)).toBe('~');
  });

  it('leaves paths outside HOME untouched', () => {
    expect(shortenHome('/tmp/foo', home)).toBe('/tmp/foo');
  });

  it('does not trim prefix substrings that are not a directory boundary', () => {
    expect(shortenHome('/Users/devops/foo', home)).toBe('/Users/devops/foo');
  });

  it('returns empty string for non-string or empty input', () => {
    expect(shortenHome('', home)).toBe('');
    expect(shortenHome(null, home)).toBe('');
    expect(shortenHome(undefined, home)).toBe('');
  });

  it('defaults home to os.homedir() when omitted', () => {
    expect(typeof shortenHome('/tmp/x')).toBe('string');
  });
});

describe('compactPath', () => {
  const root = '/Users/dev/proj';

  it('maps the project root itself to "."', () => {
    expect(compactPath(root, root)).toBe('.');
  });

  it('strips the root prefix for paths inside the project', () => {
    expect(compactPath(`${root}/src/app.js`, root)).toBe('src/app.js');
    expect(compactPath(`${root}/docs/guide.md`, root)).toBe('docs/guide.md');
  });

  it('handles a root that already ends with a separator', () => {
    expect(compactPath(`${root}/src/a.js`, `${root}/`)).toBe('src/a.js');
  });

  it('returns the last 3 segments for paths outside the root', () => {
    expect(compactPath('/Users/other/foo/bar/baz.md', root)).toBe('foo/bar/baz.md');
  });

  it('returns empty string for non-string or empty input', () => {
    expect(compactPath('', root)).toBe('');
    expect(compactPath(null, root)).toBe('');
  });
});

describe('classifyKnowledgePath', () => {
  const root = '/tmp/proj';

  it('returns null for non-matching paths', () => {
    expect(classifyKnowledgePath('/tmp/proj/random.txt', DEFAULT_KNOWLEDGE_TARGETS, root)).toBeNull();
  });

  it('returns the matched kind/label plus a compact label', () => {
    const result = classifyKnowledgePath('/tmp/proj/docs/guide.md', DEFAULT_KNOWLEDGE_TARGETS, root);
    expect(result).toEqual({
      key: '/tmp/proj/docs/guide.md',
      label: 'docs/guide.md',
      kind: 'doc',
      kindLabel: 'Docs',
    });
  });

  it('picks the first matching target when multiple could match', () => {
    const customTargets = [
      { kind: 'first',  label: 'First',  test: () => true },
      { kind: 'second', label: 'Second', test: () => true },
    ];
    const result = classifyKnowledgePath('/tmp/proj/anything.md', customTargets, root);
    expect(result.kind).toBe('first');
  });

  it('passes projectRoot into the target test via ctx', () => {
    let seenCtx;
    const spy = [{
      kind: 'spy', label: 'Spy',
      test: (_p, ctx) => { seenCtx = ctx; return false; },
    }];
    classifyKnowledgePath('/tmp/proj/x.md', spy, root);
    expect(seenCtx).toEqual({ projectRoot: root });
  });

  it('returns null for falsy/non-string input', () => {
    expect(classifyKnowledgePath('', DEFAULT_KNOWLEDGE_TARGETS, root)).toBeNull();
    expect(classifyKnowledgePath(null, DEFAULT_KNOWLEDGE_TARGETS, root)).toBeNull();
  });
});

describe('extractKnowledgeTarget', () => {
  const root = '/tmp/proj';
  const targets = DEFAULT_KNOWLEDGE_TARGETS;

  it('tags tool_read events with source="tool_read"', () => {
    const ev = { event: 'tool_read', file: '/tmp/proj/docs/a.md' };
    const out = extractKnowledgeTarget(ev, targets, root);
    expect(out?.source).toBe('tool_read');
    expect(out?.kind).toBe('doc');
  });

  it('tags instructions_loaded events with source="instructions_loaded"', () => {
    const ev = { event: 'instructions_loaded', raw: { file_path: '/tmp/proj/.claude/rules/x.md' } };
    const out = extractKnowledgeTarget(ev, targets, root);
    expect(out?.source).toBe('instructions_loaded');
    expect(out?.kind).toBe('rule');
  });

  it('returns null for unrelated event types', () => {
    expect(extractKnowledgeTarget({ event: 'tool_write', file: '/tmp/proj/docs/a.md' }, targets, root)).toBeNull();
    expect(extractKnowledgeTarget({ event: 'user_prompt' }, targets, root)).toBeNull();
  });

  it('returns null when the referenced file does not match any target', () => {
    const ev = { event: 'tool_read', file: '/tmp/proj/src/code.ts' };
    expect(extractKnowledgeTarget(ev, targets, root)).toBeNull();
  });

  it('tolerates missing raw/file_path on instructions_loaded', () => {
    expect(extractKnowledgeTarget({ event: 'instructions_loaded' }, targets, root)).toBeNull();
    expect(extractKnowledgeTarget({ event: 'instructions_loaded', raw: {} }, targets, root)).toBeNull();
  });

  it('returns null for falsy input', () => {
    expect(extractKnowledgeTarget(null, targets, root)).toBeNull();
    expect(extractKnowledgeTarget('not an event', targets, root)).toBeNull();
  });
});
