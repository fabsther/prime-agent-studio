import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignGit } from '../lib/git-align.mjs';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    windowsHide: true,
  })
    .toString()
    .trim();

test('git alignment fetches, switches and fast-forwards, but never loses work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-git-align-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const origin = join(root, 'origin.git'),
    a = join(root, 'a'),
    b = join(root, 'b');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, a);
  await writeFile(join(a, 'f.txt'), '1');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'one');
  git(a, 'push', '--quiet', 'origin', 'HEAD:main');
  git(root, 'clone', '--quiet', origin, b);
  // PC A works on a new branch and pushes it.
  git(a, 'switch', '--quiet', '-c', 'feature');
  await writeFile(join(a, 'f.txt'), '2');
  git(a, 'commit', '--quiet', '-am', 'two');
  git(a, 'push', '--quiet', '-u', 'origin', 'feature');
  const recorded = { branch: 'feature', commit: git(a, 'rev-parse', 'HEAD') };
  const dataDir = join(root, 'data');
  // PC B: local changes block alignment, untouched.
  await writeFile(join(b, 'f.txt'), 'local edit');
  await assert.rejects(alignGit({ cwd: b, ...recorded, dataDir }), { status: 409 });
  assert.equal(git(b, 'branch', '--show-current'), 'main');
  git(b, 'checkout', '--quiet', '--', 'f.txt');
  // Clean: fetch + switch to the tracked branch at the recorded commit.
  assert.equal((await alignGit({ cwd: b, ...recorded, dataDir })).state, 'aligned');
  assert.equal(git(b, 'branch', '--show-current'), 'feature');
  assert.equal(git(b, 'rev-parse', 'HEAD'), recorded.commit);
  assert.equal((await alignGit({ cwd: b, ...recorded, dataDir })).state, 'already');
  // Behind: fast-forward. Ahead: left as is. Diverged: refused.
  await writeFile(join(a, 'f.txt'), '3');
  git(a, 'commit', '--quiet', '-am', 'three');
  git(a, 'push', '--quiet');
  const newer = { branch: 'feature', commit: git(a, 'rev-parse', 'HEAD') };
  assert.equal((await alignGit({ cwd: b, ...newer, dataDir })).state, 'aligned');
  assert.equal((await alignGit({ cwd: b, ...recorded, dataDir })).state, 'ahead');
  assert.equal(git(b, 'rev-parse', 'HEAD'), newer.commit);
  await writeFile(join(b, 'g.txt'), 'b only');
  git(b, 'add', '.');
  git(b, 'commit', '--quiet', '-m', 'b');
  await writeFile(join(a, 'f.txt'), '4');
  git(a, 'commit', '--quiet', '-am', 'four');
  git(a, 'push', '--quiet');
  const diverged = { branch: 'feature', commit: git(a, 'rev-parse', 'HEAD') };
  const bHead = git(b, 'rev-parse', 'HEAD');
  await assert.rejects(alignGit({ cwd: b, ...diverged, dataDir }), { status: 409 });
  assert.equal(git(b, 'rev-parse', 'HEAD'), bHead, 'local commit kept');
  // Unknown commit (not pushed): refused.
  await assert.rejects(alignGit({ cwd: b, branch: 'feature', commit: 'f'.repeat(40), dataDir }), {
    status: 409,
  });
});
