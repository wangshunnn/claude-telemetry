import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

export function resolveProjectRoot() {
  return resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

export function resolveTelemetryRoot(home = homedir()) {
  return resolve(home, '.claude', 'claude-telemetry');
}

export function projectBucketStem(projectRoot) {
  return String(projectRoot)
    .replace(/:/g, '-')
    .replace(/[\\/]+/g, '-');
}

function shortHash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function readProjectMeta(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isEmptyDir(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function bucketMatchesProject(path, projectRoot) {
  const meta = readProjectMeta(path);
  return meta && meta.projectRoot === projectRoot;
}

export function projectBucketName(projectRoot = resolveProjectRoot(), telemetryRoot = resolveTelemetryRoot()) {
  const normalizedRoot = resolve(projectRoot);
  const projectsDir = resolve(telemetryRoot, 'projects');
  const stem = projectBucketStem(normalizedRoot);
  const candidateDir = resolve(projectsDir, stem);
  const candidateMetaPath = resolve(candidateDir, 'meta.json');

  if (!existsSync(candidateDir)) return stem;
  if (bucketMatchesProject(candidateMetaPath, normalizedRoot) || isEmptyDir(candidateDir)) return stem;

  const hashedStem = `${stem}--${shortHash(normalizedRoot)}`;
  const hashedDir = resolve(projectsDir, hashedStem);
  const hashedMetaPath = resolve(hashedDir, 'meta.json');

  if (!existsSync(hashedDir)) return hashedStem;
  if (bucketMatchesProject(hashedMetaPath, normalizedRoot) || isEmptyDir(hashedDir)) return hashedStem;

  let suffix = 2;
  while (true) {
    const nextStem = `${hashedStem}-${suffix}`;
    const nextDir = resolve(projectsDir, nextStem);
    const nextMetaPath = resolve(nextDir, 'meta.json');
    if (!existsSync(nextDir)) return nextStem;
    if (bucketMatchesProject(nextMetaPath, normalizedRoot) || isEmptyDir(nextDir)) return nextStem;
    suffix += 1;
  }
}

export function resolveTelemetryPaths(
  projectRoot = resolveProjectRoot(),
  telemetryRoot = resolveTelemetryRoot()
) {
  const normalizedRoot = resolve(projectRoot);
  const projectsDir = resolve(telemetryRoot, 'projects');
  const bucketName = projectBucketName(normalizedRoot, telemetryRoot);
  const dir = resolve(projectsDir, bucketName);
  return {
    projectRoot: normalizedRoot,
    telemetryRoot,
    projectsDir,
    bucketName,
    dir,
    events: resolve(dir, 'events.jsonl'),
    html: resolve(dir, 'index.html'),
    snapshot: resolve(dir, 'snapshot.json'),
    meta: resolve(dir, 'meta.json'),
  };
}

export function ensureTelemetryDir(paths = resolveTelemetryPaths()) {
  try {
    mkdirSync(paths.projectsDir, { recursive: true });
    mkdirSync(paths.dir, { recursive: true });
    writeProjectMeta(paths);
  } catch {}
  return paths;
}

export function writeProjectMeta(paths = resolveTelemetryPaths()) {
  const now = new Date().toISOString();
  const current = readProjectMeta(paths.meta);
  const projectName = basename(paths.projectRoot) || paths.projectRoot;
  const next = {
    projectRoot: paths.projectRoot,
    bucketName: paths.bucketName,
    projectName,
    createdAt: typeof current?.createdAt === 'string' && current.createdAt ? current.createdAt : now,
    lastSeenAt: now,
  };
  writeFileSync(paths.meta, JSON.stringify(next, null, 2) + '\n');
  return next;
}
