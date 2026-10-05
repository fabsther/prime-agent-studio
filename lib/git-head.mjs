// Read-only Git context from the .git files: no git process, no network.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function gitDirs(cwd) {
  let gitDir = join(cwd, '.git');
  const info = await stat(gitDir);
  let common = gitDir;
  if (info.isFile()) {
    // Worktree or submodule: HEAD lives in gitdir, shared refs in commondir.
    const pointer = /gitdir:\s*(.+)/.exec(await readFile(gitDir, 'utf8'))?.[1]?.trim();
    if (!pointer) return null;
    gitDir = common = resolve(cwd, pointer);
    const shared = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
    if (shared) common = resolve(gitDir, shared);
  }
  return { gitDir, common };
}

async function gitHead(cwd) {
  try {
    const dirs = await gitDirs(cwd);
    if (!dirs) return null;
    const head = (await readFile(join(dirs.gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*(refs\/heads\/(.+))$/.exec(head);
    if (!ref) return /^[0-9a-f]{40,64}$/.test(head) ? { branch: null, commit: head } : null;
    let commit = '';
    for (const dir of [dirs.gitDir, dirs.common]) {
      commit = (await readFile(join(dir, ref[1]), 'utf8').catch(() => '')).trim();
      if (commit) break;
    }
    if (!commit) {
      const packed = await readFile(join(dirs.common, 'packed-refs'), 'utf8').catch(() => '');
      commit =
        packed
          .split('\n')
          .find((line) => line.endsWith(` ${ref[1]}`))
          ?.split(' ')[0] || '';
    }
    return { branch: ref[2], commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null };
  } catch {
    return null;
  }
}

const cache = new Map();
// Overview polls often: reuse each project's answer for a few seconds.
export async function cachedGitHead(cwd, ttl = 10_000) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await gitHead(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}
export const forgetGitHead = (cwd) => cache.delete(cwd);
