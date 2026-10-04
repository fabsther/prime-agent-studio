import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConversationSync, normalizeGitRemote } from '../lib/conversation-sync.mjs';
import { localStore } from '../lib/sync-store.mjs';
import { mergeEntries, parse, serialize } from '../lib/sync-merge.mjs';
import { discoverCli } from '../lib/agent.mjs';

const zero = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text, image) => ({
  role: 'user',
  timestamp: Date.now(),
  content: [
    { type: 'text', text },
    ...(image ? [{ type: 'image', data: image, mimeType: 'image/png' }] : []),
  ],
});
const reply = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'openai-responses',
  provider: 'fixture',
  model: 'fixture',
  usage: zero,
  stopReason: 'stop',
  timestamp: Date.now(),
});
const pause = () => new Promise((r) => setTimeout(r, 15));
const URL_ = 'https://account.r2.cloudflarestorage.com/bucket';

async function createMachine(root, objectStore, active, name, projects) {
  const dataDir = join(root, name, 'data'),
    sessionDir = join(root, name, 'sessions');
  const list = [];
  for (const [project, sync, git] of projects) {
    const cwd = join(root, name, project);
    await mkdir(cwd, { recursive: true });
    if (git) {
      await mkdir(join(cwd, '.git'), { recursive: true });
      await writeFile(
        join(cwd, '.git', 'config'),
        `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${git}\n`,
      );
    }
    list.push({ cwd, name: project, sync, exists: true });
  }
  await mkdir(sessionDir, { recursive: true });
  const meta = {};
  const sessions = async () => {
    const out = [];
    for (const name of await readdir(sessionDir)) {
      const header = parse(await readFile(join(sessionDir, name), 'utf8'))[0];
      const info = await stat(join(sessionDir, name));
      out.push({
        id: header.id,
        cwd: header.cwd,
        file: join(sessionDir, name),
        updatedAt: info.mtime.toISOString(),
      });
    }
    return out;
  };
  const store = {
    overview: async () => {
      const all = await sessions();
      return { projects: list.map((p) => ({ ...p, sessions: all.filter((s) => s.cwd === p.cwd) })) };
    },
    history: async (id) => (await sessions()).find((s) => s.id === id),
    sessionMeta: (id) => ({ pinned: false, archived: false, metaAt: 0, ...meta[id] }),
    applySessionMeta: async (id, next) => {
      if (!(next.metaAt > (meta[id]?.metaAt || 0))) return false;
      meta[id] = { ...next };
      return true;
    },
    pin: (id, pinned) => (meta[id] = { ...meta[id], pinned, archived: false, metaAt: Date.now() }),
    setProjectSyncId: async (cwd, syncId) => {
      const p = list.find((x) => x.cwd === cwd);
      p.syncId = syncId;
      delete p.syncManual;
    },
    link: (project, syncId) =>
      Object.assign(
        list.find((x) => x.name === project),
        { syncId, syncManual: true },
      ),
  };
  const sync = createConversationSync({
    dataDir,
    sessionDir,
    store,
    objectStore,
    isSessionActive: (id) => active.has(`${name}:${id}`),
  });
  return { name, dataDir, sessionDir, store, cwd: (p) => list.find((x) => x.name === p).cwd, sync };
}

test('merge keeps both offline branches, converges and remaps colliding short ids', () => {
  const t = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const header = { type: 'session', id: 'S', cwd: '/p' };
  const base = [
    { id: 'a', parentId: null, timestamp: t(1) },
    { id: 'b', parentId: 'a', timestamp: t(2) },
  ];
  const mine = [...base, { id: 'c', parentId: 'b', timestamp: t(3), v: 'mine' }];
  const theirs = [
    ...base,
    { id: 'c', parentId: 'b', timestamp: t(4), v: 'theirs' },
    { id: 'd', parentId: 'c', timestamp: t(5) },
  ];
  const merged = mergeEntries([header, ...mine], theirs, 'd');
  assert.equal(merged.remapped, 1);
  assert.equal(merged.entries.length, 6);
  const last = merged.entries.at(-1);
  assert.equal(merged.active, last.id);
  const parent = merged.entries.find((e) => e.id === last.parentId);
  assert.equal(parent.v, 'theirs', 'remapped entry keeps its child chain');
  assert.equal(mergeEntries(merged.entries, theirs.slice(0, 2), 'b').added, 0, 'idempotent');
});

test('two machines sync through an encrypted passive store', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const { SessionManager } = await import(
    pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const active = new Set();
  const machine = (name, projects) => createMachine(root, objectStore, active, name, projects);
  const A = await machine('A', [['Projet'], ['Privé', false]]);
  const B = await machine('B', [['Projet'], ['Privé']]);
  const passphrase = 'correct horse battery staple';
  await A.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC A',
  });
  await assert.rejects(
    B.sync.configure({
      url: URL_,
      accessKeyId: 'id',
      secretAccessKey: 'secret',
      passphrase: 'wrong passphrase!!',
    }),
    { status: 400 },
  );
  await B.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC B',
  });
  const status = await A.sync.status();
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('secret"'), false, 'secrets are never returned');
  assert.equal(status.hasSecret, true);

  const sm = SessionManager.create(A.cwd('Projet'), A.sessionDir);
  const image = randomBytes(120_000).toString('base64');
  sm.appendMessage(user('capture', image));
  sm.appendMessage(reply('vu'));
  const file = basename(sm.getSessionFile());
  const hidden = SessionManager.create(A.cwd('Privé'), A.sessionDir);
  hidden.appendMessage(user('privé'));
  hidden.appendMessage(reply('reste local'));
  const context = (m) =>
    SessionManager.open(join(m.sessionDir, file), m.sessionDir)
      .buildSessionContext()
      .messages.map((x) => JSON.stringify(x.content));

  const first = (await A.sync.run()).lastSync;
  assert.equal(first.ok, true);
  assert.equal(first.pushed, 2, 'only the synced project is sent');
  await B.sync.run();
  assert.deepEqual(context(B), context(A));
  assert.equal(parse(await readFile(join(B.sessionDir, file), 'utf8'))[0].cwd, B.cwd('Projet'));
  assert.deepEqual(await readdir(B.sessionDir), [file], 'opted-out project stays local');
  // Stored objects are encrypted: no plaintext text or image in the bucket.
  for (const name of await readdir(join(root, 'r2', 'objects'))) {
    const raw = await readFile(join(root, 'r2', 'objects', name));
    assert.equal(raw.includes('capture'), false);
    assert.equal(raw.includes(image.slice(0, 64)), false);
  }
  // Nothing changed: nothing sent. Same image again: only text is sent.
  assert.equal((await A.sync.run()).lastSync.sent, 0);
  const a = SessionManager.open(join(A.sessionDir, file), A.sessionDir);
  await pause();
  a.appendMessage(user('encore', image));
  await pause();
  a.appendMessage(reply('identique'));
  const delta = (await A.sync.run()).lastSync;
  assert.ok(delta.sent < 4096, `delta sent ${delta.sent} bytes`);
  await B.sync.run();
  // Both machines work offline, then converge on the newest branch.
  await pause();
  a.appendMessage(user('A hors ligne'));
  a.appendMessage(reply('A ok'));
  const b = SessionManager.open(join(B.sessionDir, file), B.sessionDir);
  await pause();
  b.appendMessage(user('B hors ligne'));
  b.appendMessage(reply('B ok'));
  await A.sync.run();
  await B.sync.run();
  await A.sync.run();
  assert.deepEqual(context(A), context(B));
  assert.match(context(A).at(-1), /B ok/);
  // A running conversation is never rewritten by a pull.
  active.add(`B:${sm.getSessionId?.() ?? parse(await readFile(join(A.sessionDir, file), 'utf8'))[0].id}`);
  await pause();
  a.appendMessage(user('pendant exécution'));
  a.appendMessage(reply('ok'));
  const before = await readFile(join(B.sessionDir, file), 'utf8');
  await A.sync.run();
  const skipped = (await B.sync.run()).lastSync;
  assert.equal(await readFile(join(B.sessionDir, file), 'utf8'), before);
  assert.ok(skipped.skipped >= 1);
  active.clear();
  await B.sync.run();
  assert.deepEqual(context(B), context(A));
  // Status, pinned metadata and the quick per-conversation check.
  const sid = parse(await readFile(join(A.sessionDir, file), 'utf8'))[0].id;
  // State written by an older build (no ids/mtime): one run restores 'synced'.
  const statePath = join(A.dataDir, 'sync-state.json');
  const oldState = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(
    statePath,
    JSON.stringify({ ...oldState, ids: undefined, mtime: undefined, meta: undefined }),
  );
  assert.equal((await A.sync.status()).sessions[sid], 'pending');
  assert.equal((await A.sync.run()).lastSync.sent, 0);
  assert.equal((await A.sync.status()).sessions[sid], 'synced');
  A.store.pin(sid, true);
  assert.equal((await A.sync.status()).sessions[sid], 'pending', 'local pin waits to be sent');
  assert.equal((await A.sync.checkSession(sid)).state, 'synced');
  const seen = await B.sync.checkSession(sid);
  assert.equal(seen.changed, true);
  assert.equal(B.store.sessionMeta(sid).pinned, true, 'pin arrives on the other PC');
  await pause();
  a.appendMessage(user('vérifiée à l’ouverture'));
  a.appendMessage(reply('ok'));
  await A.sync.checkSession(sid);
  assert.equal((await B.sync.checkSession(sid)).changed, true);
  assert.deepEqual(context(B), context(A));
  assert.equal((await B.sync.checkSession(sid)).changed, false);
  assert.equal((await A.sync.checkSession(hidden.getSessionId())).state, 'off');
  await A.sync.forget();
  assert.equal((await A.sync.status()).configured, false);
  // Reconnecting the same bucket keeps this PC's identity and sends nothing again.
  await A.sync.configure({
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase,
    device: 'PC A',
  });
  const again = (await A.sync.run()).lastSync;
  assert.equal(again.sent, 0);
  assert.equal(again.received, 0);
  assert.equal((await readdir(join(root, 'r2', 'refs'))).length, 2, 'no orphan ref for the same PC');
});

test('git remotes normalize to the same project id', () => {
  for (const url of [
    'git@github.com:Me/Repo.git',
    'https://github.com/me/repo',
    'https://user:token@github.com/me/repo.git/',
    'ssh://git@github.com/me/repo.git',
  ])
    assert.equal(normalizeGitRemote(url), 'github.com/me/repo');
  assert.equal(normalizeGitRemote(''), null);
});

test('projects match across PCs by id, Git remote, then name, or an explicit link', async (t) => {
  const cli = discoverCli();
  if (!cli?.packageDir) return t.skip('Prime Agent engine unavailable');
  const { SessionManager } = await import(
    pathToFileURL(join(cli.packageDir, 'dist/core/session-manager.js')).href
  );
  const root = await mkdtemp(join(tmpdir(), 'studio-sync-link-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const objectStore = localStore(join(root, 'r2'));
  const A = await createMachine(root, objectStore, new Set(), 'A', [
    ['Alpha', true, 'git@github.com:me/repo.git'],
    ['Beta'],
    ['Delta'],
  ]);
  const B = await createMachine(root, objectStore, new Set(), 'B', [
    ['Renamed', true, 'https://github.com/me/repo'],
    ['Beta'],
    ['Other'],
  ]);
  const config = {
    url: URL_,
    accessKeyId: 'id',
    secretAccessKey: 'secret',
    passphrase: 'correct horse battery staple',
  };
  await A.sync.configure({ ...config, device: 'PC A' });
  await B.sync.configure({ ...config, device: 'PC B' });
  const talk = (m, project, text) => {
    const sm = SessionManager.create(m.cwd(project), m.sessionDir);
    sm.appendMessage(user(text));
    sm.appendMessage(reply(`${text} ok`));
    return sm.getSessionId();
  };
  const alpha = talk(A, 'Alpha', 'alpha'),
    beta = talk(A, 'Beta', 'beta'),
    delta = talk(A, 'Delta', 'delta');
  await A.sync.run();
  await B.sync.run();
  const headers = async (m) =>
    Object.fromEntries(
      await Promise.all(
        (await readdir(m.sessionDir)).map(async (f) => {
          const h = parse(await readFile(join(m.sessionDir, f), 'utf8'))[0];
          return [h.id, h.cwd];
        }),
      ),
    );
  let onB = await headers(B);
  assert.equal(onB[alpha], B.cwd('Renamed'), 'same Git remote, different name');
  assert.equal(onB[beta], B.cwd('Beta'), 'same name');
  assert.equal(onB[delta], undefined, 'no match: stays available');
  const status = await B.sync.status();
  assert.equal(status.projectLinks[B.cwd('Renamed')].via, 'git');
  assert.equal(status.projectLinks[B.cwd('Beta')].via, 'name');
  const remoteDelta = status.remoteProjects.find((p) => p.name === 'Delta');
  assert.equal(remoteDelta.local, null);
  assert.deepEqual(remoteDelta.devices, ['PC A']);
  assert.equal(remoteDelta.sessions, 1);
  // Explicit link: a differently named project receives the remote conversations.
  B.store.link('Other', remoteDelta.id);
  await B.sync.run();
  onB = await headers(B);
  assert.equal(onB[delta], B.cwd('Other'));
  assert.equal((await B.sync.status()).projectLinks[B.cwd('Other')].via, 'manual');
  // Ids are stable: B's new conversations land in A's projects too.
  const back = talk(B, 'Renamed', 'retour');
  await B.sync.run();
  await A.sync.run();
  assert.equal((await headers(A))[back], A.cwd('Alpha'));
});
