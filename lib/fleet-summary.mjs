import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cwdKey } from './store.mjs';

const exec = promisify(execFile);
const CACHE_MS = 5000;
const timestamp = (value) => {
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
const active = (run) => ['running', 'stopping'].includes(run?.status);

/** Same checkout key for HTTPS and SSH remotes; local paths have no fleet key. */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin.trim()) return null;
  const value = origin.trim();
  let host, path;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  } else {
    if (/^[a-z]:[\\/]/i.test(value)) return null;
    const match = /^(?:[^@/\\]+@)?([^:/\\]+):(.+)$/.exec(value);
    if (!match) return null;
    [, host, path] = match;
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !path || /[\s\\?#]/.test(host + path)) return null;
  return `${host}/${path}`.toLowerCase();
}

async function readGit(cwd) {
  const env = { ...process.env };
  // Do not let the Studio process environment redirect Git to another checkout.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  const git = async (...args) => {
    const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
  try {
    const [status, originText, branchText] = await Promise.all([
      git('status', '--porcelain=v1', '-z', '--untracked-files=all'),
      git('config', '--get', 'remote.origin.url').catch(() => ''),
      git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
    ]);
    const entries = status.split('\0');
    let changedFiles = 0;
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) continue;
      changedFiles++;
      // Porcelain -z emits a second path for a rename/copy, not a second change.
      if (/[RC]/.test(entries[i].slice(0, 2))) i++;
    }
    const origin = originText.trim() || null;
    return {
      origin,
      originKey: normalizeOrigin(origin),
      branch: branchText.trim() || null,
      dirty: changedFiles > 0,
      changedFiles,
    };
  } catch {
    // Missing Git, non-repository, inaccessible folder, timeout or output limit.
    return null;
  }
}

function sessionStatus(run, inspection) {
  if (active(run)) {
    if (
      run.interactions?.some((request) => request.status === 'pending') ||
      inspection?.session?.status === 'waiting'
    )
      return 'waiting';
    return 'running';
  }
  if (run?.status === 'failed' || ['failed', 'error'].includes(inspection?.session?.status)) return 'error';
  return 'idle';
}

/** Pollable read-only summary. Reuses store and inspector, never starts an agent. */
export function createFleetSummary({ store, inspector, getRuns, identity }) {
  const gitCache = new Map();
  let cached;
  function gitInfo(cwd) {
    const key = cwdKey(cwd),
      previous = gitCache.get(key);
    if (previous && (previous.pending || Date.now() - previous.at < CACHE_MS)) return previous.promise;
    const entry = { at: Date.now(), pending: true, promise: null };
    entry.promise = readGit(cwd).finally(() => {
      entry.pending = false;
      entry.at = Date.now();
    });
    gitCache.set(key, entry);
    if (gitCache.size > 200) gitCache.delete(gitCache.keys().next().value);
    return entry.promise;
  }
  async function build() {
    const [overview, runs, machine] = await Promise.all([
      store.overview(),
      getRuns(),
      typeof identity === 'function' ? identity() : identity,
    ]);
    const bySession = new Map();
    for (const run of runs) {
      const previous = bySession.get(run.sessionId);
      if (!previous || active(run) || !active(previous)) bySession.set(run.sessionId, run);
    }
    const projects = [];
    for (const project of overview.projects) {
      const recent = [...project.sessions]
        .sort(
          (a, b) => (timestamp(b.updatedAt) ?? 0) - (timestamp(a.updatedAt) ?? 0) || a.id.localeCompare(b.id),
        )
        .slice(0, 50);
      const sessions = [];
      const git = gitInfo(project.cwd);
      // Four inspector calls at a time bound filesystem/daemon pressure.
      for (let start = 0; start < recent.length; start += 4) {
        sessions.push(
          ...(await Promise.all(
            recent.slice(start, start + 4).map(async (session) => {
              const run = bySession.get(session.id);
              const inspection = await inspector
                .inspect(session.cwd || project.cwd, session.id)
                .catch(() => null);
              const agents = (inspection?.agents || []).slice(0, 201).map((agent) => ({
                id: agent.id,
                parentId: agent.parentId ?? null,
                name: agent.name,
                status: agent.status,
                model: agent.model ?? null,
                progressNote: agent.progressNote ?? null,
                lastActivityAt:
                  timestamp(agent.lastActivityAt) ??
                  timestamp(agent.updatedAt) ??
                  (agent.id === session.id ? timestamp(session.updatedAt) : null),
              }));
              const link = session.roadmapLink || run?.roadmapLink;
              return {
                id: session.id,
                title: session.title,
                status: sessionStatus(run, inspection),
                updatedAt: timestamp(session.updatedAt),
                runId: run?.id ?? null,
                roadmapLink: link
                  ? { planId: link.planId, stepId: link.stepId, ownerMachineId: link.ownerMachineId }
                  : null,
                agents,
              };
            }),
          )),
        );
      }
      const projectRuns = runs.filter((run) => cwdKey(run.projectCwd || run.cwd) === cwdKey(project.cwd));
      const activity = [
        ...project.sessions.map((session) => timestamp(session.updatedAt)),
        ...projectRuns.flatMap((run) => [timestamp(run.startedAt), timestamp(run.endedAt)]),
        ...sessions.flatMap((session) => session.agents.map((agent) => agent.lastActivityAt)),
      ].filter((at) => at !== null);
      projects.push({
        cwd: project.cwd,
        name: project.name,
        git: await git,
        activeRuns: projectRuns.filter(active).length,
        lastActivityAt: activity.reduce((latest, at) => (latest === null ? at : Math.max(latest, at)), null),
        sessions,
      });
    }
    return { machine, generatedAt: Date.now(), projects };
  }
  function get() {
    if (cached && (cached.pending || Date.now() - cached.at < CACHE_MS)) return cached.promise;
    const entry = { at: Date.now(), pending: true, promise: null };
    entry.promise = build().then(
      (result) => {
        entry.pending = false;
        entry.at = Date.now();
        return result;
      },
      (error) => {
        if (cached === entry) cached = null;
        throw error;
      },
    );
    cached = entry;
    return entry.promise;
  }
  return { get, gitInfo };
}
