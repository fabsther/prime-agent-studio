import test from 'node:test';
import assert from 'node:assert/strict';
import { recentConversations } from '../public/session-wheel.js';
import { conversationActivity } from '../public/project-navigation.js';

test('six recent conversations are selected before alphabetical sorting, across projects', () => {
  const projects = [
    {
      cwd: 'C:/Alpha',
      name: 'Alpha',
      color: '#7fa6c9',
      sessions: [
        { id: 'old', title: 'A very old conversation', updatedAt: 1 },
        { id: 'archived', title: 'Archive', updatedAt: 100, archived: true },
        { id: '6', title: 'Zulu', updatedAt: 6, cwd: 'C:/worktrees/task' },
        { id: '5', title: 'Éclair', updatedAt: 5 },
        { id: '4', title: 'Delta', updatedAt: 4 },
      ],
    },
    {
      cwd: 'C:/Beta',
      color: 'transparent',
      sessions: [
        { id: '3', title: 'Bravo 10', updatedAt: 3 },
        { id: '2', title: 'Bravo 2', updatedAt: 2 },
        { id: '7', title: 'Alpha', updatedAt: '2026-09-28T00:00:00Z' },
      ],
    },
  ];
  const before = structuredClone(projects);
  const rows = recentConversations(projects, 'fr');
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['7', '2', '3', '4', '5', '6'],
  );
  assert.deepEqual(rows.at(-1), {
    id: '6',
    cwd: 'C:/Alpha',
    title: 'Zulu',
    updatedAt: 6,
    projectName: 'Alpha',
    color: '#3b82f6',
  });
  assert.equal(rows[0].projectName, 'Beta');
  assert.equal(rows[0].color, '');
  assert.deepEqual(projects, before, 'opening the wheel never changes sidebar order');
  assert.deepEqual(recentConversations([], 'en'), []);
  assert.equal(recentConversations([{ cwd: '/one', sessions: [{ id: 'one' }] }], 'en').length, 1);
});

test('sidebar and wheel share activity priority: question, running, unread, idle', () => {
  const session = { id: 'conversation' };
  const run = { id: 'run', sessionId: session.id, status: 'running' };
  const question = { ...run, interactions: [{ status: 'pending' }] };
  assert.equal(conversationActivity(session, [question], true), 'question');
  assert.equal(conversationActivity(session, [run], true), 'running');
  assert.equal(conversationActivity(session, [{ ...question, status: 'stopping' }], true), 'running');
  assert.equal(conversationActivity(session, [{ ...run, status: 'completed' }], true), 'unread');
  assert.equal(conversationActivity(session, [], true), 'unread');
  assert.equal(conversationActivity(session, [], false), 'idle');
  assert.equal(conversationActivity(session, [{ ...question, sessionId: 'other' }], false), 'idle');
  assert.equal(conversationActivity(session, [run, question], true), 'question');
  assert.equal(conversationActivity({ runId: 'run' }, [question], false), 'question');
});
