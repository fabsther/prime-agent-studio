// Aligns a project's working copy on the Git state recorded by a conversation.
// Safe by design: never discards work. Refuses on local changes, on a local
// branch ahead of or diverged from the recorded commit, and on unknown commits.
// Only fetch, switch and fast-forward are used; hooks are disabled.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitBaseEnv } from './worktrees.mjs';
import { HttpError } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const exec = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

export async function alignGit({ cwd, branch, commit, dataDir, fetch = true }) {
  if (!COMMIT_RE.test(commit || '')) throw new HttpError(400, tr('git.align_no_commit'));
  if (branch && !BRANCH_RE.test(branch)) throw new HttpError(400, tr('server.valeur_invalide'));
  const hooks = join(dataDir, 'git-nohooks');
  await mkdir(hooks, { recursive: true });
  const git = async (args, timeout = 30_000) =>
    String(
      (
        await exec(
          'git',
          ['-c', `core.hooksPath=${hooks.replace(/\\/g, '/')}`, '-c', 'submodule.recurse=false', ...args],
          { cwd, windowsHide: true, shell: false, timeout, maxBuffer: 4 << 20, env: gitBaseEnv() },
        )
      ).stdout,
    ).trim();
  const ok = (args) =>
    git(args).then(
      () => true,
      () => false,
    );
  const refuse = (key, values) => {
    throw new HttpError(409, tr(key, values));
  };
  try {
    await git(['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(500, tr('git.align_unavailable'));
    refuse('git.align_not_repo');
  }
  if (await git(['status', '--porcelain', '--untracked-files=no'])) refuse('git.align_dirty');
  const current = {
    branch: await git(['branch', '--show-current']),
    commit: await git(['rev-parse', 'HEAD']),
  };
  if (current.commit === commit && (!branch || current.branch === branch))
    return { state: 'already', branch: current.branch, commit };
  // The recorded commit may only exist on the other PC's push: fetch first.
  if (fetch) await git(['fetch', '--quiet', '--prune', 'origin'], 120_000).catch(() => {});
  if (!(await ok(['cat-file', '-e', `${commit}^{commit}`]))) refuse('git.align_missing');
  if (!branch) {
    await git(['switch', '--quiet', '--detach', commit]);
    return { state: 'detached', branch: null, commit };
  }
  if (current.branch !== branch) {
    if (await ok(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]))
      await git(['switch', '--quiet', branch]);
    else if (await ok(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]))
      await git(['switch', '--quiet', '--track', '-c', branch, `origin/${branch}`]);
    else await git(['switch', '--quiet', '-c', branch, commit]);
  }
  const head = await git(['rev-parse', 'HEAD']);
  if (head !== commit) {
    if (await ok(['merge-base', '--is-ancestor', head, commit]))
      await git(['merge', '--quiet', '--ff-only', commit]);
    else if (await ok(['merge-base', '--is-ancestor', commit, head]))
      return { state: 'ahead', branch, commit: head };
    else refuse('git.align_diverged', { value1: branch });
  }
  return { state: 'aligned', branch, commit };
}
