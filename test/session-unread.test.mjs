import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.mjs';
import { createSessionActivity } from '../public/session-activity.js';
import { conversationActivity } from '../public/project-navigation.js';
import { messages } from '../public/translations.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-unread-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: join(root, 'Alpha'),
  };
  await Promise.all([options.sessionDir, options.initialCwd].map((p) => mkdir(p)));
  const file = join(options.sessionDir, 'session.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', id: 'session', cwd: options.initialCwd }) + '\n');
  let previous = null;
  async function append(id, role = 'assistant', extra = {}) {
    await appendFile(
      file,
      JSON.stringify({
        type: 'message',
        id,
        parentId: previous,
        message: { role, content: id, stopReason: 'stop', ...extra },
      }) + '\n',
    );
    previous = id;
  }
  await append('initial');
  return { root, options, file, append, store: createStore(options) };
}

test('mark unread persists, stays idempotent and re-reads forward', async (t) => {
  const f = await fixture(t);
  await f.store.overview();
  await f.append('second');
  await f.store.markRead({ id: 'session', answer: 'second' });
  assert.equal((await f.store.history('session')).readState.read, 'second');
  const unread = await f.store.markUnread({ id: 'session' });
  assert.equal(unread.readState.read, '');
  assert.equal(unread.readState.answer, 'second');
  assert.ok(unread.readState.revision > 1);
  const reopened = createStore(f.options);
  assert.equal((await reopened.history('session')).readState.read, '');
  const again = await reopened.markUnread({ id: 'session' });
  assert.equal(again.readState.read, '');
  await reopened.markRead({ id: 'session', answer: 'second' });
  assert.equal((await reopened.history('session')).readState.read, 'second');
});

test('mark unread on a conversation without an answer is a no-op', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-unread-empty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: join(root, 'Alpha'),
  };
  await Promise.all([options.sessionDir, options.initialCwd].map((p) => mkdir(p)));
  await writeFile(
    join(options.sessionDir, 'empty.jsonl'),
    JSON.stringify({ type: 'session', id: 'empty', cwd: options.initialCwd }) + '\n',
  );
  const store = createStore(options);
  const state = await store.markUnread({ id: 'empty' });
  assert.equal(state.readState.answer, '');
  assert.equal(state.readState.read, '');
});

test('mark unread rejects unknown sessions', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.markUnread({ id: 'missing' }), { status: 404 });
});

test('client mark unread reuses shared receipt state for sidebar and wheel', async (t) => {
  const f = await fixture(t);
  await f.store.overview();
  await f.append('second');
  await f.store.markRead({ id: 'session', answer: 'second' });
  const values = new Map();
  const activity = createSessionActivity({
    read: (k, fallback) => values.get(k) ?? fallback,
    write: (k, v) => values.set(k, v),
    loadHistory: (id) => f.store.history(id),
    saveRead: (id, answer) => f.store.markRead({ id, answer }),
    saveUnread: (id) => f.store.markUnread({ id }),
    onChange: () => {},
  });
  activity.initialize(await f.store.overview().then((o) => o.projects.flatMap((p) => p.sessions)));
  activity.observe(await f.store.history('session'));
  assert.equal(activity.isUnread('session'), false);
  assert.equal(await activity.markUnread('session'), true);
  assert.equal(activity.isUnread('session'), true);
  assert.equal(conversationActivity({ id: 'session' }, [], activity.isUnread('session')), 'unread');
  const history = await f.store.history('session');
  activity.observe(history);
  assert.equal(activity.isUnread('session'), true);
});

test('background conversation marks unread without loaded messages', async (t) => {
  const f = await fixture(t);
  await f.store.overview();
  await f.append('second');
  await f.store.markRead({ id: 'session', answer: 'second' });
  const values = new Map();
  const activity = createSessionActivity({
    read: (k, fallback) => values.get(k) ?? fallback,
    write: (k, v) => values.set(k, v),
    saveUnread: (id) => f.store.markUnread({ id }),
    onChange: () => {},
  });
  assert.equal(await activity.markUnread('session'), true);
  assert.equal(activity.isUnread('session'), true);
});

test('translations provide FR and EN mark as unread labels', () => {
  assert.equal(messages['ui.marquer_comme_non_lu'].fr, 'Marquer comme non lu');
  assert.equal(messages['ui.marquer_comme_non_lu'].en, 'Mark as unread');
});

test('mark unread failure propagates and leaves shared state unchanged', async () => {
  const values = new Map();
  let changes = 0;
  const activity = createSessionActivity({
    read: (k, fallback) => values.get(k) ?? fallback,
    write: (k, v) => values.set(k, v),
    saveUnread: () => Promise.reject(new Error('unread failed')),
    onChange: () => {
      changes++;
    },
  });
  activity.observe({
    id: 'session',
    updatedAt: '2026-09-28T00:00:00Z',
    messageCount: 1,
    messages: [{ id: 'a', role: 'assistant', text: 'hi' }],
    readState: { answer: 'a', read: 'a', revision: 1 },
  });
  assert.equal(activity.isUnread('session'), false);
  await assert.rejects(activity.markUnread('session'), /unread failed/);
  assert.equal(activity.isUnread('session'), false);
  assert.equal(values.get('session-activity.session').unread, false);
  assert.equal(changes, 0);
});

test('in-flight read settles before explicit unread so unread wins', async () => {
  const values = new Map();
  const order = [];
  let resolveRead;
  const readGate = new Promise((resolve) => {
    resolveRead = resolve;
  });
  let saveUnreadCalls = 0;
  const activity = createSessionActivity({
    read: (k, fallback) => values.get(k) ?? fallback,
    write: (k, v) => values.set(k, v),
    saveRead: () => {
      order.push('saveRead-called');
      return readGate.then((result) => {
        order.push('saveRead-resolved');
        return result;
      });
    },
    saveUnread: () => {
      saveUnreadCalls++;
      order.push('saveUnread-called');
      return Promise.resolve({ readState: { answer: 'a', read: '', revision: 3 } });
    },
    onChange: () => {},
  });
  const messages = [{ id: 'a', role: 'assistant', text: 'hi' }];
  activity.observe({
    id: 'session',
    updatedAt: '2026-09-28T00:00:00Z',
    messageCount: 1,
    messages,
    readState: { answer: 'a', read: '', revision: 1 },
  });
  assert.equal(activity.isUnread('session'), true);
  assert.equal(activity.markRead('session', messages), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['saveRead-called']);
  const unreadPromise = activity.markUnread('session');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveUnreadCalls, 0);
  resolveRead({ readState: { answer: 'a', read: 'a', revision: 2 } });
  assert.equal(await unreadPromise, true);
  assert.deepEqual(order, ['saveRead-called', 'saveRead-resolved', 'saveUnread-called']);
  assert.equal(activity.isUnread('session'), true);
});

test('read completion plus unread failure leaves no stale guard', async () => {
  const values = new Map();
  const activity = createSessionActivity({
    read: (k, fallback) => values.get(k) ?? fallback,
    write: (k, v) => values.set(k, v),
    saveRead: (id, answer) => Promise.resolve({ readState: { answer, read: answer, revision: 99 } }),
    saveUnread: () => Promise.reject(new Error('unread failed')),
    onChange: () => {},
  });
  activity.observe({
    id: 'session',
    updatedAt: '2026-09-28T00:00:00Z',
    messageCount: 1,
    messages: [{ id: 'a', role: 'assistant', text: 'hi' }],
    readState: { answer: 'a', read: '', revision: 1 },
  });
  assert.equal(activity.markRead('session', [{ id: 'a', role: 'assistant', text: 'hi' }]), true);
  await assert.rejects(activity.markUnread('session'), /unread failed/);
  activity.observe({
    id: 'session',
    updatedAt: '2026-09-28T00:00:01Z',
    messageCount: 2,
    messages: [{ id: 'b', role: 'assistant', text: 'next' }],
    readState: { answer: 'b', read: 'a', revision: 2 },
  });
  assert.equal(activity.isUnread('session'), true);
  assert.equal(activity.markRead('session', [{ id: 'b', role: 'assistant', text: 'next' }]), true);
});
