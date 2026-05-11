import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export const SUPPORTED_AGENTS = ['claude', 'codex'];

export function normalizeAgent(agent = process.env.CLAUDE_TELEMETRY_AGENT || 'claude') {
  return agent === 'codex' ? 'codex' : 'claude';
}

export function agentTelemetryDirName(agent = 'claude') {
  return normalizeAgent(agent) === 'codex' ? '.codex' : '.claude';
}

export function resolveProjectRoot(agent = process.env.CLAUDE_TELEMETRY_AGENT || 'claude') {
  const normalizedAgent = normalizeAgent(agent);
  const agentProjectDir = normalizedAgent === 'codex'
    ? process.env.CODEX_PROJECT_DIR
    : process.env.CLAUDE_PROJECT_DIR;
  return resolve(
    agentProjectDir ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CODEX_PROJECT_DIR ||
    process.cwd()
  );
}

export function resolveTelemetryRoot(projectRoot = resolveProjectRoot(), agent = 'claude') {
  const normalizedRoot = resolve(projectRoot);
  const normalizedAgent = normalizeAgent(agent);
  const override = normalizedAgent === 'codex'
    ? (process.env.CODEX_TELEMETRY_ROOT || process.env.CLAUDE_TELEMETRY_ROOT)
    : process.env.CLAUDE_TELEMETRY_ROOT;
  return override
    ? resolve(normalizedRoot, override)
    : resolve(normalizedRoot, agentTelemetryDirName(normalizedAgent), 'telemetry');
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
  telemetryRoot = null,
  options = {}
) {
  const agent = normalizeAgent(options.agent);
  const normalizedRoot = resolve(projectRoot);
  const normalizedTelemetryRoot = resolve(telemetryRoot || resolveTelemetryRoot(normalizedRoot, agent));
  const localTelemetryRoot = resolve(normalizedRoot, agentTelemetryDirName(agent), 'telemetry');
  const useSharedBuckets = normalizedTelemetryRoot !== localTelemetryRoot;
  const projectsDir = useSharedBuckets
    ? resolve(normalizedTelemetryRoot, 'projects')
    : normalizedTelemetryRoot;
  const bucketName = useSharedBuckets
    ? projectBucketName(normalizedRoot, normalizedTelemetryRoot)
    : null;
  const dir = useSharedBuckets
    ? resolve(projectsDir, bucketName)
    : normalizedTelemetryRoot;
  return {
    agent,
    projectRoot: normalizedRoot,
    telemetryRoot: normalizedTelemetryRoot,
    storageMode: useSharedBuckets ? 'shared' : 'project',
    projectsDir,
    bucketName,
    dir,
    events: resolve(dir, 'events.jsonl'),
    html: resolve(dir, 'index.html'),
    snapshot: resolve(dir, 'snapshot.json'),
    meta: useSharedBuckets ? resolve(dir, 'meta.json') : null,
  };
}

export function ensureTelemetryDir(paths = resolveTelemetryPaths()) {
  try {
    mkdirSync(paths.projectsDir, { recursive: true });
    mkdirSync(paths.dir, { recursive: true });
    if (paths.storageMode === 'shared') {
      writeProjectMeta(paths);
    }
  } catch {}
  return paths;
}

export function writeProjectMeta(paths = resolveTelemetryPaths()) {
  if (paths.storageMode !== 'shared' || !paths.meta) return null;
  const now = new Date().toISOString();
  const current = readProjectMeta(paths.meta);
  const projectName = basename(paths.projectRoot) || paths.projectRoot;
  const next = {
    agent: paths.agent || 'claude',
    projectRoot: paths.projectRoot,
    projectName,
    storageMode: paths.storageMode,
    telemetryRoot: paths.telemetryRoot,
    createdAt: typeof current?.createdAt === 'string' && current.createdAt ? current.createdAt : now,
    lastSeenAt: now,
  };
  if (paths.bucketName) next.bucketName = paths.bucketName;
  writeFileSync(paths.meta, JSON.stringify(next, null, 2) + '\n');
  return next;
}
