import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopNotifications } from '../lib/desktop-notifications.mjs';

function run(id, sessionId, cwd = '/tmp/proj', status = 'running') {
  return { id, sessionId, cwd, status, interactions: [] };
}

test('publish carries the session id for native click routing', () => {
  const feed = createDesktopNotifications();
  feed.publish('turnComplete', run('r1', 'sess_abc-123'));
  const snap = feed.snapshot(0, new Map());
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].sessionId, 'sess_abc-123');
  assert.equal(snap.events[0].runId, 'r1');
});

test('publish without a session stays focus-only (null)', () => {
  const feed = createDesktopNotifications();
  feed.publish('turnComplete', { id: 'r2', cwd: '/tmp/proj', status: 'completed' });
  const snap = feed.snapshot(0, new Map());
  assert.equal(snap.events[0].sessionId, null);
});

test('question events still filter on pending interactions', () => {
  const feed = createDesktopNotifications();
  const r = run('r3', 'sess_q');
  r.interactions = [{ id: 'q1', status: 'pending' }];
  const runs = new Map([['r3', r]]);
  feed.publish('question', r, 'q1');
  assert.equal(feed.snapshot(0, runs).events.length, 1);
  assert.equal(feed.snapshot(0, runs).events[0].sessionId, 'sess_q');
  r.interactions[0].status = 'answered';
  assert.equal(feed.snapshot(0, runs).events.length, 0);
});

test('cursor consumes events so no replay burst', () => {
  const feed = createDesktopNotifications();
  feed.publish('turnComplete', run('r4', 's4'));
  const first = feed.snapshot(0, new Map());
  assert.equal(first.events.length, 1);
  const second = feed.snapshot(first.sequence, new Map());
  assert.equal(second.events.length, 0);
});
