import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createProjectGit } from '../lib/project-git.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

process.env.GIT_CONFIG_NOSYSTEM = '1';

const exec = promisify(execFile);
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  GIT_EDITOR: 'true',
  GIT_CONFIG_NOSYSTEM: '1',
});

async function git(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd,
    windowsHide: true,
    shell: false,
    timeout: 20000,
    maxBuffer: 4 << 20,
    env: gitEnv(),
  });
  return String(stdout).trim();
}

async function initClone(dir) {
  await git(dir, ['config', 'user.name', 'panel-test']);
  await git(dir, ['config', 'user.email', 'panel@test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
}

async function commitFile(dir, name, content, message) {
  await writeFile(join(dir, name), content);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// Bare origin + two clones. w1 owns main and a pushed feature branch.
async function setupPair(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-project-git-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const origin = join(root, 'origin.git');
  const w1 = join(root, 'w1');
  const w2 = join(root, 'w2');
  await git(root, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  await git(root, ['clone', '--quiet', origin, w1]);
  await initClone(w1);
  await commitFile(w1, 'a.txt', 'a1\n', 'add a');
  await commitFile(w1, 'b.txt', 'b1\n', 'add b');
  await git(w1, ['push', '--quiet', '-u', 'origin', 'main']);
  await git(w1, ['switch', '--quiet', '-c', 'feature']);
  await commitFile(w1, 'a.txt', 'a2-feature\n', 'feature work');
  await git(w1, ['push', '--quiet', '-u', 'origin', 'feature']);
  await git(w1, ['switch', '--quiet', 'main']);
  await git(root, ['clone', '--quiet', origin, w2]);
  await initClone(w2);
  const store = { findProject: async (cwd) => ({ cwd }) };
  const projectFiles = createProjectFiles({ store, protectedRoots: [] });
  const service = createProjectGit({
    store,
    filesFor: () => projectFiles,
    dataDir: join(root, 'data'),
  });
  return { root, origin, w1, w2, service };
}

async function statusCode(promise) {
  try {
    await promise;
    assert.fail('expected an HttpError');
  } catch (error) {
    assert.ok(Number.isInteger(error?.status), `expected status, got: ${error?.message}`);
    return error;
  }
}

test('status reports branch, head, upstream, counts, remote and branch lists', async (t) => {
  const { w1, service } = await setupPair(t);
  const seen = await service.status(w1);
  assert.equal(seen.git, true);
  assert.equal(seen.branch, 'main');
  assert.match(seen.head, /^[0-9a-f]{40}$/);
  assert.equal(seen.upstream, 'origin/main');
  assert.equal(seen.ahead, 0);
  assert.equal(seen.behind, 0);
  assert.equal(seen.remote, true);
  assert.equal(seen.dirty, false);
  assert.ok(seen.branches.local.includes('main'));
  assert.ok(seen.branches.local.includes('feature'));
  assert.ok(seen.branches.remote.includes('main'));
  assert.ok(seen.branches.remote.includes('feature'));
  assert.ok(!seen.branches.remote.some((name) => name === 'HEAD' || name.includes('HEAD')));
  await writeFile(join(w1, 'a.txt'), 'dirty\n');
  assert.equal((await service.status(w1)).dirty, true);
  await git(w1, ['checkout', '--quiet', '--', 'a.txt']);
  await commitFile(w1, 'a.txt', 'a-ahead\n', 'ahead commit');
  const ahead = await service.status(w1);
  assert.equal(ahead.ahead, 1);
  assert.equal(ahead.behind, 0);
});

test('status on a plain folder reports git false with a reason', async (t) => {
  const { root, service } = await setupPair(t);
  const plain = join(root, 'plain');
  await mkdir(plain);
  const seen = await service.status(plain);
  assert.equal(seen.git, false);
  assert.ok(typeof seen.reason === 'string' && seen.reason.length > 0);
});

test('fetch prunes and reports behind without moving HEAD', async (t) => {
  const { w1, w2, service } = await setupPair(t);
  const before = await git(w1, ['rev-parse', 'HEAD']);
  const pushed = await commitFile(w2, 'a.txt', 'a-remote\n', 'remote moves on');
  await git(w2, ['push', '--quiet']);
  const seen = await service.fetch(w1);
  assert.equal(seen.git, true);
  assert.equal(seen.behind, 1);
  assert.equal(await git(w1, ['rev-parse', 'origin/main']), pushed);
  assert.equal(await git(w1, ['rev-parse', 'HEAD']), before);
});

test('switch moves between local, remote-only and created branches', async (t) => {
  const { root, origin, w1, service } = await setupPair(t);
  assert.equal((await service.switchBranch(w1, { branch: 'feature' })).branch, 'feature');
  assert.equal(await git(w1, ['branch', '--show-current']), 'feature');
  // Remote-only branch in a fresh clone tracks origin on switch.
  const w3 = join(root, 'w3');
  await git(root, ['clone', '--quiet', origin, w3]);
  await initClone(w3);
  const tracked = await service.switchBranch(w3, { branch: 'feature' });
  assert.equal(tracked.branch, 'feature');
  assert.equal(tracked.upstream, 'origin/feature');
  const created = await service.switchBranch(w1, { branch: 'topic/new', create: true });
  assert.equal(created.branch, 'topic/new');
  assert.ok(created.branches.local.includes('topic/new'));
  assert.equal((await statusCode(service.switchBranch(w1, { branch: 'missing' }))).status, 404);
  assert.equal((await statusCode(service.switchBranch(w1, { branch: '../evil' }))).status, 400);
  assert.equal((await statusCode(service.switchBranch(w1, { branch: '' }))).status, 400);
});

test('switch refuses when local changes would be overwritten', async (t) => {
  const { w1, service } = await setupPair(t);
  await writeFile(join(w1, 'a.txt'), 'local edit\n');
  const head = await git(w1, ['rev-parse', 'HEAD']);
  const failure = await statusCode(service.switchBranch(w1, { branch: 'feature' }));
  assert.equal(failure.status, 409);
  assert.equal(await git(w1, ['branch', '--show-current']), 'main');
  assert.equal(await git(w1, ['rev-parse', 'HEAD']), head);
});

test('commit stages only the chosen files', async (t) => {
  const { w1, service } = await setupPair(t);
  await writeFile(join(w1, 'a.txt'), 'a-changed\n');
  await writeFile(join(w1, 'b.txt'), 'b-changed\n');
  const done = await service.commit(w1, { message: 'part of the work', paths: ['a.txt'] });
  assert.equal(done.ok, true);
  assert.match(done.commit, /^[0-9a-f]{40}$/);
  assert.ok(done.summary.includes('part of the work'));
  assert.equal(done.status.dirty, true);
  assert.equal((await git(w1, ['status', '--porcelain', '--', 'a.txt'])).trim(), '');
  assert.ok((await git(w1, ['status', '--porcelain', '--', 'b.txt'])).trim() !== '');
  const rest = await service.commit(w1, { message: 'rest of the work', paths: ['b.txt'] });
  assert.equal(rest.status.dirty, false);
});

test('commit handles deletions and renames', async (t) => {
  const { w1, service } = await setupPair(t);
  await unlink(join(w1, 'b.txt'));
  await writeFile(join(w1, 'renamed-a.txt'), 'a1\n');
  await unlink(join(w1, 'a.txt'));
  const done = await service.commit(w1, {
    message: 'delete and rename',
    paths: ['b.txt', 'a.txt', 'renamed-a.txt'],
  });
  assert.equal(done.ok, true);
  assert.equal((await git(w1, ['status', '--porcelain'])).trim(), '');
});

test('commit rejects empty messages and unknown paths', async (t) => {
  const { w1, service } = await setupPair(t);
  await writeFile(join(w1, 'a.txt'), 'a-changed\n');
  assert.equal(
    (await statusCode(service.commit(w1, { message: '  ', paths: ['a.txt'] }))).status,
    400,
  );
  assert.equal(
    (await statusCode(service.commit(w1, { message: 'work', paths: ['nope.txt'] }))).status,
    400,
  );
  assert.equal((await statusCode(service.commit(w1, { message: 'work', paths: [] }))).status, 400);
});

test('commit with a failing hook reports 409 and restores the index', async (t) => {
  const { w1, service } = await setupPair(t);
  await writeFile(
    join(w1, '.git', 'hooks', 'pre-commit'),
    '#!/bin/sh\necho hook-blocked-marker >&2\nexit 1\n',
  );
  await writeFile(join(w1, 'a.txt'), 'a-changed\n');
  await writeFile(join(w1, 'b.txt'), 'b-changed\n');
  await git(w1, ['add', '--', 'b.txt']);
  const failure = await statusCode(
    service.commit(w1, { message: 'blocked by hook', paths: ['a.txt', 'b.txt'] }),
  );
  assert.equal(failure.status, 409);
  assert.match(failure.message, /hook-blocked-marker/);
  // Only the file Studio staged is unstaged again; the previously staged file stays staged.
  assert.equal(await git(w1, ['diff', '--cached', '--name-only']), 'b.txt');
  assert.equal(await git(w1, ['status', '--porcelain', '--', 'a.txt']), 'M a.txt');
  await unlink(join(w1, '.git', 'hooks', 'pre-commit'));
});

test('pull fast-forwards and refuses diverged branches', async (t) => {
  const { w1, w2, service } = await setupPair(t);
  const pushed = await commitFile(w2, 'a.txt', 'a-remote\n', 'remote moves on');
  await git(w2, ['push', '--quiet']);
  const pulled = await service.pull(w1);
  assert.equal(pulled.head, pushed);
  assert.equal(pulled.ahead, 0);
  assert.equal(pulled.behind, 0);
  await commitFile(w1, 'a.txt', 'a-local\n', 'local moves on');
  await commitFile(w2, 'a.txt', 'a-remote-again\n', 'remote moves again');
  await git(w2, ['push', '--quiet']);
  const w1Head = await git(w1, ['rev-parse', 'HEAD']);
  const failure = await statusCode(service.pull(w1));
  assert.equal(failure.status, 409);
  assert.match(failure.message, /diverg/i);
  assert.equal(await git(w1, ['rev-parse', 'HEAD']), w1Head);
});

test('pull without an upstream branch is refused', async (t) => {
  const { w1, service } = await setupPair(t);
  await git(w1, ['switch', '--quiet', '-c', 'lonely']);
  await commitFile(w1, 'a.txt', 'a-lonely\n', 'lonely work');
  const failure = await statusCode(service.pull(w1));
  assert.equal(failure.status, 409);
  assert.match(failure.message, /upstream|distante/i);
});

test('push of a new branch sets the upstream', async (t) => {
  const { origin, w1, service } = await setupPair(t);
  await git(w1, ['switch', '--quiet', '-c', 'push-me']);
  await commitFile(w1, 'a.txt', 'a-push\n', 'push work');
  const seen = await service.push(w1);
  assert.equal(seen.upstream, 'origin/push-me');
  assert.equal(seen.ahead, 0);
  await git(origin, ['show-ref', '--verify', '--quiet', 'refs/heads/push-me']);
});

test('push rejected by a moved remote reports to pull first', async (t) => {
  const { w1, w2, service } = await setupPair(t);
  await commitFile(w1, 'a.txt', 'a-local\n', 'local moves on');
  await commitFile(w2, 'a.txt', 'a-remote\n', 'remote moves on');
  await git(w2, ['push', '--quiet']);
  const failure = await statusCode(service.push(w1));
  assert.equal(failure.status, 409);
  assert.match(failure.message, /pull/i);
});

test('push to an unreachable remote reports a remote failure', async (t) => {
  const { w1, service } = await setupPair(t);
  await git(w1, ['switch', '--quiet', '-c', 'doomed']);
  await commitFile(w1, 'a.txt', 'a-doomed\n', 'doomed work');
  await git(w1, ['remote', 'set-url', 'origin', join(w1, 'missing.git')]);
  const failure = await statusCode(service.push(w1));
  assert.equal(failure.status, 409);
  assert.ok(failure.message.length > 0);
});

function fakeRuntime() {
  const controls = [];
  return {
    controls,
    async getStatus() {
      return { available: true, version: 'fixture', nodeVersion: process.versions.node };
    },
    async getModels() {
      return { models: [], default: { model: 'fixture/no-provider' } };
    },
    async start(input) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const control = {
        input,
        done,
        cancelCalls: 0,
        emit(event) {
          input.onEvent(event);
        },
        finish(result = { status: 'completed', code: 0 }) {
          input.onEvent({ kind: 'done', ...result });
          resolveDone(result);
        },
        async cancel() {
          control.cancelCalls++;
          control.finish({ status: 'stopped', code: 130 });
          return done;
        },
      };
      controls.push(control);
      return control;
    },
    async close() {
      await Promise.all(controls.map((control) => control.cancel()));
    },
  };
}

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const payload =
      body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
    const outgoing = {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    };
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: outgoing }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* Non-JSON response. */
        }
        done({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function serverFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-project-git-'));
  const cwd = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(join(root, 'agent'))]);
  await git(cwd, ['init', '-b', 'main']);
  await initClone(cwd);
  await commitFile(cwd, 'a.txt', 'a1\n', 'initial');
  await writeFile(
    join(sessionDir, 'native-session.jsonl'),
    [
      { type: 'session', id: 'native-session', cwd, timestamp: '2026-09-04T00:00:00.000Z' },
      {
        type: 'message',
        id: 'initial-message',
        parentId: null,
        message: { role: 'user', content: 'Existing conversation' },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  const runtime = fakeRuntime();
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, cwd, runtime, port, api: (path, options) => http(port, path, options) };
}

test('project-git routes refuse switch and pull while an agent run is active', async (t) => {
  const f = await serverFixture(t);
  const at = (path) => `${path}?cwd=${encodeURIComponent(f.cwd)}`;
  const idle = await f.api(at('/api/project-git'));
  assert.equal(idle.status, 200);
  assert.equal(idle.json.git, true);
  assert.equal(idle.json.branch, 'main');
  const started = await f.api('/api/runs', { method: 'POST', body: { cwd: f.cwd, message: 'busy' } });
  assert.equal(started.status, 201);
  assert.equal(
    (await f.api('/api/project-git/switch', { method: 'POST', body: { cwd: f.cwd, branch: 'main' } }))
      .status,
    409,
  );
  assert.equal(
    (await f.api('/api/project-git/pull', { method: 'POST', body: { cwd: f.cwd } })).status,
    409,
  );
  // Commit stays allowed during a run: an empty message reaches validation, not the guard.
  assert.equal(
    (
      await f.api('/api/project-git/commit', {
        method: 'POST',
        body: { cwd: f.cwd, message: '  ', paths: ['a.txt'] },
      })
    ).status,
    400,
  );
  f.runtime.controls[0].finish();
  for (let attempt = 0; attempt < 200; attempt++) {
    const runs = await f.api('/api/runs');
    if (runs.json.runs.length === 0) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const switched = await f.api('/api/project-git/switch', {
    method: 'POST',
    body: { cwd: f.cwd, branch: 'panel-branch', create: true },
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.json.branch, 'panel-branch');
});

const ACCESS_CODE = '49283175';

async function lanFixture(t, readOnly) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-project-git-lan-'));
  const origin = join(root, 'origin.git');
  const cwd = join(root, 'proj');
  const sessionDir = join(root, 'sessions');
  await mkdir(sessionDir);
  await git(root, ['init', '--quiet', '--bare', '-b', 'main', origin]);
  await git(root, ['clone', '--quiet', origin, cwd]);
  await initClone(cwd);
  await commitFile(cwd, 'a.txt', 'a1\n', 'initial');
  await git(cwd, ['push', '--quiet', '-u', 'origin', 'main']);
  await writeFile(
    join(sessionDir, 'native-session.jsonl'),
    [
      { type: 'session', id: 'native-session', cwd, timestamp: '2026-09-04T00:00:00.000Z' },
      {
        type: 'message',
        id: 'initial-message',
        parentId: null,
        message: { role: 'user', content: 'Existing conversation' },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n',
  );
  const runtime = fakeRuntime();
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir,
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime,
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const upstreamPort = app.server.address().port;
  const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort,
    config: { salt, codeHash: hashAccessCode(ACCESS_CODE, salt), readOnly },
  });
  await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
  const port = gateway.address().port;
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((done, reject) => gateway.close((error) => (error ? reject(error) : done())));
    await app.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = (path, options) => http(port, path, options);
  const login = () =>
    api('/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: ACCESS_CODE }).toString(),
    });
  const response = await login();
  assert.equal(response.status, 303);
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  return { api, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, cwd };
}

test('remote gateway reads git state in consultation but refuses writes', async (t) => {
  const at = (cwd) => `/api/project-git?cwd=${encodeURIComponent(cwd)}`;
  const ro = await lanFixture(t, true);
  const readable = await ro.api(at(ro.cwd), { headers: ro.headers });
  assert.equal(readable.status, 200);
  assert.equal(readable.json.git, true);
  for (const path of [
    '/api/project-git/fetch',
    '/api/project-git/switch',
    '/api/project-git/commit',
    '/api/project-git/pull',
    '/api/project-git/push',
  ]) {
    const refused = await ro.api(path, {
      method: 'POST',
      headers: ro.headers,
      body: { cwd: ro.cwd },
    });
    assert.equal(refused.status, 405, path);
  }
  const full = await lanFixture(t, false);
  assert.equal((await full.api(at(full.cwd), { headers: full.headers })).status, 200);
  const fetched = await full.api('/api/project-git/fetch', {
    method: 'POST',
    headers: full.headers,
    body: { cwd: full.cwd },
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.git, true);
});
