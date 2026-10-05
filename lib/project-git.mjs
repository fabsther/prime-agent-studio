// Git panel service for the Files tab (branch, commit, pull, push).
// Only fast-forward pull and plain push are used; push never forces.
// Commit and push RUN the repository hooks. Switch, pull, fetch and status
// DISABLE hooks through an empty hooks dir (same pattern as lib/git-align.mjs).
// Switch never discards work: git itself refuses when local changes would be
// overwritten, and that refusal surfaces as HTTP 409. All git commands run via
// execFile (no shell) with prompting disabled (GIT_TERMINAL_PROMPT=0).
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitBaseEnv } from './worktrees.mjs';
import { HttpError } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const exec = promisify(execFile);
const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const LOCAL_TIMEOUT = 30_000;
const REMOTE_TIMEOUT = 120_000;
const SUMMARY_LIMIT = 2000;

const stderrOf = (error) => String(error?.stderr || '').trim();
const firstLine = (value, max) => String(value || '').split('\n')[0].slice(0, max);

// Infrastructure failures shared by every operation: missing git, timeouts,
// oversized output, or an HttpError that is already translated (store lookup).
function infraError(error) {
  if (error?.status) return error;
  if (error?.code === 'ENOENT') return new HttpError(500, tr('git.panel_no_git'));
  if (error?.killed)
    return new HttpError(504, tr('server.git_met_trop_de_temps_a_repondre_reessayez'));
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return new HttpError(413, tr('server.le_resultat_git_est_trop_volumineux'));
  return null;
}

function validBranch(name) {
  if (typeof name !== 'string') return false;
  const branch = name.trim();
  if (!branch || !BRANCH_RE.test(branch)) return false;
  if (
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('@{')
  )
    return false;
  return true;
}

export function createProjectGit({ store, filesFor, dataDir }) {
  const hooksRoot = dataDir || join(tmpdir(), 'prime-agent-studio');
  let hooksReady = null;
  const hooksDir = () => {
    hooksReady ??= mkdir(join(hooksRoot, 'git-nohooks'), { recursive: true }).then(() =>
      join(hooksRoot, 'git-nohooks'),
    );
    return hooksReady;
  };
  const run = async (cwd, args, { hooks = false, timeout = LOCAL_TIMEOUT } = {}) => {
    const head = hooks
      ? ['-c', 'submodule.recurse=false']
      : [
          '-c',
          `core.hooksPath=${(await hooksDir()).replace(/\\/g, '/')}`,
          '-c',
          'submodule.recurse=false',
        ];
    try {
      const { stdout } = await exec('git', [...head, ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        timeout,
        maxBuffer: 4 << 20,
        env: gitBaseEnv(),
      });
      return String(stdout);
    } catch (error) {
      throw infraError(error) || error;
    }
  };
  const plain = (cwd, args, options) => run(cwd, args, { hooks: true, ...(options || {}) });
  const quiet = (cwd, args, options) => run(cwd, args, { hooks: false, ...(options || {}) });
  const exists = async (cwd, ref) => {
    try {
      await quiet(cwd, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  };
  const upstreamOf = async (cwd) => {
    try {
      const upstream = (
        await quiet(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      ).trim();
      return upstream || null;
    } catch {
      return null;
    }
  };
  const countsOf = async (cwd) => {
    try {
      const raw = (await quiet(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']))
        .trim()
        .split(/\s+/);
      return { ahead: Number(raw[0]) || 0, behind: Number(raw[1]) || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  };
  const remoteError = (error) =>
    new HttpError(
      409,
      tr('git.panel_remote_failed', {
        value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
      }),
    );

  async function status(cwd) {
    const project = await store.findProject(cwd);
    const root = project.cwd;
    try {
      await quiet(root, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (error?.status) throw error;
      if (error?.code === 'ENOENT') throw new HttpError(500, tr('git.panel_no_git'));
      return { git: false, reason: tr('server.ce_projet_n_est_pas_un_depot_git') };
    }
    const branch = (await quiet(root, ['branch', '--show-current'])).trim() || null;
    let head = null;
    try {
      head = (await quiet(root, ['rev-parse', 'HEAD'])).trim() || null;
    } catch {
      head = null;
    }
    const upstream = await upstreamOf(root);
    const { ahead, behind } = upstream ? await countsOf(root) : { ahead: 0, behind: 0 };
    let remote = false;
    try {
      await quiet(root, ['remote', 'get-url', 'origin']);
      remote = true;
    } catch {
      remote = false;
    }
    const dirty =
      (await quiet(root, ['status', '--porcelain', '--', '.'])).trim() !== '';
    const local = (await quiet(root, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const remoteBranches = (await quiet(root, ['branch', '-r', '--format=%(refname:short)']))
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith('origin/') &&
          line !== 'origin/HEAD' &&
          !line.includes('->') &&
          line.slice('origin/'.length),
      )
      .map((line) => line.slice('origin/'.length));
    return {
      git: true,
      branch,
      head,
      upstream,
      ahead,
      behind,
      remote,
      dirty,
      branches: { local, remote: remoteBranches },
    };
  }

  async function ensureRepo(root) {
    try {
      await quiet(root, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (error?.status) throw error;
      if (error?.code === 'ENOENT') throw new HttpError(500, tr('git.panel_no_git'));
      throw new HttpError(409, tr('git.align_not_repo'));
    }
  }

  async function fetch(cwd) {
    const project = await store.findProject(cwd);
    await ensureRepo(project.cwd);
    try {
      await quiet(project.cwd, ['fetch', '--prune', 'origin'], { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      throw remoteError(error);
    }
    return status(project.cwd);
  }

  async function switchBranch(cwd, { branch, create } = {}) {
    const project = await store.findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    const name = typeof branch === 'string' ? branch.trim() : '';
    if (!validBranch(name)) throw new HttpError(400, tr('git.panel_bad_branch'));
    let args;
    if (await exists(root, `refs/heads/${name}`)) args = ['switch', name];
    else if (await exists(root, `refs/remotes/origin/${name}`))
      args = ['switch', '--track', '-c', name, `origin/${name}`];
    else if (create) args = ['switch', '-c', name];
    else throw new HttpError(404, tr('git.panel_bad_branch'));
    try {
      await quiet(root, args);
    } catch (error) {
      if (error?.status) throw error;
      if (/would be overwritten|local changes/i.test(stderrOf(error)))
        throw new HttpError(409, tr('git.panel_switch_dirty'));
      throw new HttpError(
        409,
        tr('git.panel_switch_failed', {
          value1: stderrOf(error).slice(0, 500) || firstLine(error?.message, 200),
        }),
      );
    }
    return status(root);
  }

  async function commit(cwd, { message, paths } = {}) {
    const project = await store.findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    if (typeof message !== 'string' || !message.trim())
      throw new HttpError(400, tr('git.panel_commit_message'));
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((path) => typeof path !== 'string' || !path)
    )
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const wanted = [...new Set(paths)];
    const changes = await filesFor(root).changes(root);
    if (!changes.git) throw new HttpError(409, tr('git.align_not_repo'));
    const listed = new Set(changes.entries.map((entry) => entry.path));
    if (!wanted.every((path) => listed.has(path)))
      throw new HttpError(400, tr('git.panel_commit_paths'));
    const stagedBefore = new Set(
      changes.entries.filter((entry) => entry.staged).map((entry) => entry.path),
    );
    const restoreIndex = async () => {
      const added = wanted.filter((path) => !stagedBefore.has(path));
      if (!added.length) return;
      try {
        await quiet(root, ['reset', '-q', 'HEAD', '--', ...added]);
      } catch {
        /* Best effort: the commit error below stays the reported failure. */
      }
    };
    try {
      await plain(root, ['add', '--', ...wanted]);
    } catch (error) {
      if (!error?.status) await restoreIndex();
      if (error?.status) throw error;
      throw new HttpError(
        409,
        tr('git.panel_commit_failed', {
          value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
        }),
      );
    }
    try {
      await plain(root, ['commit', '-m', message], { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (!error?.status) await restoreIndex();
      if (error?.status) throw error;
      throw new HttpError(
        409,
        tr('git.panel_commit_failed', {
          value1: stderrOf(error).slice(0, SUMMARY_LIMIT) || firstLine(error?.message, 200),
        }),
      );
    }
    const sha = (await quiet(root, ['rev-parse', 'HEAD'])).trim();
    const summary = (await quiet(root, ['show', '--stat', '--oneline', 'HEAD', '--']))
      .trim()
      .slice(0, SUMMARY_LIMIT);
    return { ok: true, commit: sha, summary, status: await status(root) };
  }

  async function pull(cwd) {
    const project = await store.findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    if (!(await upstreamOf(root))) throw new HttpError(409, tr('git.panel_no_upstream'));
    try {
      await quiet(root, ['pull', '--ff-only'], { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      const stderr = stderrOf(error);
      if (/not possible to fast-forward|divergent|have diverged/i.test(stderr))
        throw new HttpError(409, tr('git.panel_pull_diverged'));
      const { ahead, behind } = await countsOf(root);
      if (ahead > 0 && behind > 0) throw new HttpError(409, tr('git.panel_pull_diverged'));
      if (/local changes.*would be overwritten/i.test(stderr))
        throw new HttpError(409, tr('git.panel_local_changes'));
      throw remoteError(error);
    }
    return status(root);
  }

  async function push(cwd) {
    const project = await store.findProject(cwd);
    const root = project.cwd;
    await ensureRepo(root);
    const branch =
      (await quiet(root, ['branch', '--show-current']).catch(() => '')).trim() || null;
    const upstream = await upstreamOf(root);
    const args = upstream ? ['push'] : branch ? ['push', '-u', 'origin', branch] : ['push'];
    try {
      await plain(root, args, { timeout: REMOTE_TIMEOUT });
    } catch (error) {
      if (error?.status) throw error;
      if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i.test(stderrOf(error)))
        throw new HttpError(409, tr('git.panel_push_rejected'));
      throw remoteError(error);
    }
    return status(root);
  }

  return { status, fetch, switchBranch, commit, pull, push };
}
