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

export function classifyKnowledgePath(path, targets, projectRoot) {
  if (typeof path !== 'string' || !path) return null;
  const matched = targets.find((item) => item.test(path, { projectRoot }));
  if (!matched) return null;
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
  return null;
}
