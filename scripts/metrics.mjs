import { homedir } from 'node:os';
import { sep } from 'node:path';

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

export function extractKnowledgeTarget(event, targets, projectRoot) {
  if (!event || typeof event !== 'object') return null;
  if (event.event === 'tool_read') {
    const target = classifyKnowledgePath(event.file, targets, projectRoot);
    return target ? { ...target, source: 'tool_read' } : null;
  }
  if (event.event === 'instructions_loaded') {
    const target = classifyKnowledgePath(event.raw?.file_path, targets, projectRoot);
    return target ? { ...target, source: 'instructions_loaded' } : null;
  }
  if (event.event === 'skill_invoked' && typeof event.skill === 'string' && event.skill) {
    const skillTarget = targets.find((t) => t.kind === 'skill');
    if (!skillTarget) return null;
    return {
      key: `skill:${event.skill}`,
      label: event.skill,
      kind: 'skill',
      kindLabel: skillTarget.label,
      source: 'skill_invoked',
    };
  }
  return null;
}
