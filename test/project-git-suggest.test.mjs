import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProjectFiles } from '../lib/project-files.mjs';
import {
  createProjectGitSuggest,
  collectSuggestDiff,
  detectSuggestLanguage,
  buildSuggestPrompt,
  cleanSuggestMessage,
  readRecentSubjects,
  SUGGEST_DIFF_LIMIT,
} from '../lib/project-git-suggest.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';
const exec = promisify(execFile);
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
});
const git = (cwd, args) =>
  exec('git', args, { cwd, windowsHide: true, shell: false, timeout: 20000, maxBuffer: 4 << 20, env: gitEnv() });

async function initRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-git-suggest-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const cwd = join(root, 'atelier');
  await mkdir(cwd, { recursive: true });
  await git(root, ['init', '--quiet', '-b', 'main', cwd]);
  await git(cwd, ['config', 'user.name', 'suggest-test']);
  await git(cwd, ['config', 'user.email', 'suggest@test']);
  await git(cwd, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(cwd, 'a.txt'), 'a1\n');
  await writeFile(join(cwd, 'b.txt'), 'b1\n');
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-qm', 'Ajoute la base']);
  return cwd;
}

function serviceFor(cwd) {
  const store = { findProject: async () => ({ cwd }) };
  const projectFiles = createProjectFiles({ store, protectedRoots: [] });
  const service = createProjectGitSuggest({ store, filesFor: () => projectFiles });
  return { store, projectFiles, service };
}

test('suggest uses exactly the checked paths', async (t) => {
  const cwd = await initRepo(t);
  await writeFile(join(cwd, 'a.txt'), 'a-changed-marker\n');
  await writeFile(join(cwd, 'b.txt'), 'b-other-marker\n');
  const { service } = serviceFor(cwd);
  let seen = null;
  const complete = async (input) => {
    seen = input;
    return 'fix: corrige le titre';
  };
  const result = await service.suggestMessage(cwd, { paths: ['a.txt'] }, { complete });
  assert.equal(result.message, 'fix: corrige le titre');
  assert.ok(seen.user.includes('a-changed-marker'), 'diff carries the checked file');
  assert.ok(!seen.user.includes('b-other-marker'), 'unchecked file stays out of the prompt');
});

test('diff is bounded at 60 KB with a truncation note', async (t) => {
  const cwd = await initRepo(t);
  await writeFile(join(cwd, 'big.txt'), `${'x'.repeat(1000)}\n`.repeat(200));
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-qm', 'add big']);
  await writeFile(join(cwd, 'big.txt'), `${'y'.repeat(1000)}\n`.repeat(200));
  const { projectFiles } = serviceFor(cwd);
  const bundle = await collectSuggestDiff(cwd, ['big.txt'], () => projectFiles);
  assert.equal(bundle.truncated, true);
  assert.ok(bundle.diffText.length <= SUGGEST_DIFF_LIMIT + 200, `bounded, got ${bundle.diffText.length}`);
  assert.ok(bundle.diffText.includes('truncated to 60 KB'), 'truncation note present');
});

test('binary files are listed by name only', async (t) => {
  const cwd = await initRepo(t);
  await writeFile(join(cwd, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0x00]));
  const { projectFiles } = serviceFor(cwd);
  const bundle = await collectSuggestDiff(cwd, ['image.png'], () => projectFiles);
  assert.ok(bundle.binaries.includes('image.png'));
  assert.ok(bundle.diffText.includes('image.png'));
});

test('language hint follows recent commit subjects', async (t) => {
  const cwd = await initRepo(t);
  const subjects = await readRecentSubjects(cwd);
  assert.ok(subjects.includes('Ajoute la base'));
  assert.equal(detectSuggestLanguage(subjects), 'fr');
  assert.equal(detectSuggestLanguage(['Add login page', 'Fix header overlap', 'Update docs']), 'en');
  const frPrompt = buildSuggestPrompt({ diffText: 'd', truncated: false, binaries: [], subjects, language: 'fr' });
  assert.ok(frPrompt.user.includes('fran'), 'french instruction');
  const enPrompt = buildSuggestPrompt({
    diffText: 'd',
    truncated: false,
    binaries: [],
    subjects: ['Add login'],
    language: 'en',
  });
  assert.ok(enPrompt.user.includes('English'), 'english instruction');
});

test('empty selection is a 400', async (t) => {
  const cwd = await initRepo(t);
  const { service } = serviceFor(cwd);
  await assert.rejects(service.suggestMessage(cwd, { paths: [] }, { complete: async () => 'x' }), {
    status: 400,
  });
  await assert.rejects(service.suggestMessage(cwd, {}, { complete: async () => 'x' }), { status: 400 });
});

test('message cleanup strips fences, caps the subject and drops em dashes', () => {
  assert.equal(cleanSuggestMessage('```\nfix: ok\n```'), 'fix: ok');
  const long = `feat: ${'a'.repeat(100)}`;
  assert.ok(cleanSuggestMessage(long).split('\n')[0].length <= 72);
  assert.ok(!cleanSuggestMessage('fix: a \u2014 b').includes('\u2014'), 'no em dashes');
});
