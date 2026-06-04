import { homedir } from 'node:os';
import { basename, resolve, sep } from 'node:path';

export function shortenHome(path, home = homedir()) {
  if (typeof path !== 'string' || !path) return '';
  if (home && (path === home || path.startsWith(home + sep))) {
    return '~' + path.slice(home.length);
  }
  return path;
}

export function compactPath(path, projectRoot) {
  if (typeof path !== 'string' || !path) return '';
  if (path === projectRoot) return '.';
  const rootWithSep = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
  if (path.startsWith(rootWithSep)) {
    return path.slice(rootWithSep.length);
  }
  const parts = path.split('/');
  return parts.slice(-3).join('/');
}

export function extractSkillName(path) {
  if (typeof path !== 'string' || !path) return null;
  const match = /\/skills\/([^/]+)\//i.exec(path);
  return match ? match[1] : null;
}

function shellCommandSegments(command) {
  if (typeof command !== 'string' || !command.trim()) return [];

  const segments = [];
  let words = [];
  let current = '';
  let quote = '';
  let escaped = false;

  const pushWord = () => {
    if (!current) return;
    words.push(current);
    current = '';
  };

  const pushSegment = () => {
    pushWord();
    if (!words.length) return;
    segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      pushWord();
      if (ch === '\n') pushSegment();
      continue;
    }

    if (ch === ';' || ch === '|') {
      pushSegment();
      if (ch === '|' && command[index + 1] === '|') index += 1;
      continue;
    }

    if (ch === '&') {
      if (current.endsWith('>') || current.endsWith('<')) {
        current += ch;
        continue;
      }
      pushSegment();
      if (command[index + 1] === '&') index += 1;
      continue;
    }

    current += ch;
  }

  pushSegment();
  return segments;
}

function isAssignmentToken(value) {
  return typeof value === 'string' && /^[A-Z_][A-Z0-9_]*=/.test(value);
}

function isLikelyPath(value) {
  return typeof value === 'string' &&
    value &&
    !value.startsWith('-') &&
    !isAssignmentToken(value) &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
    (value.includes('/') || value.includes('.') || /^[A-Za-z0-9_-]+\.(md|mdc|txt|json|toml|ya?ml)$/i.test(value));
}

function isRedirectionToken(value) {
  return typeof value === 'string' && /^(?:\d*)[<>]/.test(value);
}

function redirectTarget(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:\d*)<([^<&].*)$/.exec(value);
  return match ? match[1] : null;
}

function redirectionNeedsSeparateTarget(value) {
  return /^(?:\d*)[<>]+$/.test(value);
}

function commandStartIndex(words) {
  let index = 0;
  while (index < words.length && isAssignmentToken(words[index])) index += 1;

  const first = basename(words[index] || '');
  if (first === 'env') {
    index += 1;
    while (index < words.length && (isAssignmentToken(words[index]) || words[index].startsWith('-'))) index += 1;
  }

  const wrapper = basename(words[index] || '');
  if (wrapper === 'command' || wrapper === 'builtin') index += 1;

  return index;
}

function pathArgs(words) {
  const out = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const inputRedirectTarget = redirectTarget(word);
    if (inputRedirectTarget) {
      if (isLikelyPath(inputRedirectTarget)) out.push(inputRedirectTarget);
      continue;
    }

    if (isRedirectionToken(word)) {
      if ((word === '<' || word === '0<') && isLikelyPath(words[index + 1])) {
        out.push(words[index + 1]);
      }
      if (redirectionNeedsSeparateTarget(word)) index += 1;
      continue;
    }

    if (isLikelyPath(word)) out.push(word);
  }
  return out;
}

function sedPathArgs(words) {
  const out = [];
  let scriptSeen = false;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const inputRedirectTarget = redirectTarget(word);
    if (inputRedirectTarget) {
      if (isLikelyPath(inputRedirectTarget)) out.push(inputRedirectTarget);
      continue;
    }

    if (isRedirectionToken(word)) {
      if ((word === '<' || word === '0<') && isLikelyPath(words[index + 1])) {
        out.push(words[index + 1]);
      }
      if (redirectionNeedsSeparateTarget(word)) index += 1;
      continue;
    }

    if (word === '-e' || word === '-f') {
      scriptSeen = true;
      index += 1;
      continue;
    }

    if (word.startsWith('-e') || word.startsWith('-f')) {
      scriptSeen = true;
      continue;
    }

    if (word.startsWith('-')) continue;

    if (!scriptSeen) {
      scriptSeen = true;
      continue;
    }

    if (isLikelyPath(word)) out.push(word);
  }

  return out;
}

function resolveCommandPath(path, cwd) {
  if (typeof path !== 'string' || !path) return null;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return resolve(cwd || process.cwd(), path);
}

export function extractReadFilesFromShellCommand(command, cwd) {
  const readCommands = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'less', 'more']);
  const files = new Map();

  for (const words of shellCommandSegments(command)) {
    const executableIndex = commandStartIndex(words);
    const executable = basename(words[executableIndex] || '');
    if (!readCommands.has(executable)) continue;

    const args = words.slice(executableIndex + 1);
    const candidates = executable === 'sed' ? sedPathArgs(args) : pathArgs(args);
    for (const candidate of candidates) {
      const path = resolveCommandPath(candidate, cwd);
      if (path && !files.has(path)) files.set(path, path);
    }
  }

  return [...files.values()];
}

export function classifyKnowledgePath(path, targets, projectRoot) {
  if (typeof path !== 'string' || !path) return null;
  const matched = targets.find((item) => item.test(path, { projectRoot }));
  if (!matched) return null;
  if (matched.kind === 'skill') {
    const name = extractSkillName(path);
    if (name) {
      return {
        key: `skill:${name}`,
        label: name,
        kind: 'skill',
        kindLabel: matched.label,
      };
    }
  }
  return {
    key: path,
    label: compactPath(path, projectRoot),
    kind: matched.kind,
    kindLabel: matched.label,
  };
}

export function extractKnowledgeTargets(event, targets, projectRoot) {
  if (!event || typeof event !== 'object') return [];
  if (event.event === 'tool_read') {
    const target = classifyKnowledgePath(event.file, targets, projectRoot);
    return target ? [{ ...target, source: 'tool_read' }] : [];
  }
  if (event.event === 'instructions_loaded') {
    const target = classifyKnowledgePath(event.raw?.file_path, targets, projectRoot);
    return target ? [{ ...target, source: 'instructions_loaded' }] : [];
  }
  if (event.event === 'skill_invoked' && typeof event.skill === 'string' && event.skill) {
    const skillTarget = targets.find((t) => t.kind === 'skill');
    if (!skillTarget) return [];
    return [{
      key: `skill:${event.skill}`,
      label: event.skill,
      kind: 'skill',
      kindLabel: skillTarget.label,
      source: 'skill_invoked',
    }];
  }
  if (event.event === 'tool_bash') {
    const targetsByKey = new Map();
    for (const file of extractReadFilesFromShellCommand(event.command, projectRoot)) {
      const target = classifyKnowledgePath(file, targets, projectRoot);
      if (target && !targetsByKey.has(target.key)) {
        targetsByKey.set(target.key, { ...target, source: 'tool_bash' });
      }
    }
    return [...targetsByKey.values()];
  }
  return [];
}

export function extractKnowledgeTarget(event, targets, projectRoot) {
  const targetsOut = extractKnowledgeTargets(event, targets, projectRoot);
  return Array.isArray(targetsOut) && targetsOut.length ? targetsOut[0] : null;
}
