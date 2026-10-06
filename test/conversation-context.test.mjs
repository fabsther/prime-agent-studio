import test from 'node:test';
import assert from 'node:assert/strict';
import { isTechnicalMessage } from '../public/conversation.js';

test('only routine goal continuations join activity, with a narrow legacy fallback', () => {
  const base = { role: 'system', customType: 'goal_context' };
  assert.equal(isTechnicalMessage({ ...base, contextKind: 'continuation', text: 'Notice' }), true);
  for (const text of ['[goal: continuation]\nFull original notice', '[goal: continuation]\r\nFull notice'])
    assert.equal(isTechnicalMessage({ ...base, text }), true);
  for (const contextKind of ['budget_limit', 'objective_updated', 'future_kind'])
    assert.equal(isTechnicalMessage({ ...base, contextKind, text: '[goal: continuation]' }), false);
  for (const text of [
    '[goal: budget-limit]',
    '[goal: objective-updated]',
    'Quoted [goal: continuation]',
    '[goal: continuation] not a native prefix',
  ])
    assert.equal(isTechnicalMessage({ ...base, text }), false);
  for (const override of [
    { role: 'user' },
    { error: 'failed' },
    { isError: true },
    { customType: 'future_notice' },
  ])
    assert.equal(
      isTechnicalMessage({ ...base, contextKind: 'continuation', text: '[goal: continuation]', ...override }),
      false,
    );
});

test('other known technical messages keep grouping; unknown events and errors stay visible', () => {
  for (const customType of [
    'agent_message',
    'async_bash_completion',
    'harness_digest',
    'ipython_state',
    'ipython_state_restored',
    'refinement_notice',
    'git_state',
    'rlm_child_terminal_notice',
  ]) {
    assert.equal(isTechnicalMessage({ role: 'system', customType }), true);
    assert.equal(isTechnicalMessage({ role: 'system', customType, error: 'failure' }), false);
  }
  for (const customType of ['compaction', 'branch_summary', 'new_engine_warning'])
    assert.equal(isTechnicalMessage({ role: 'system', customType }), false);
});

test('subagent end notices of every kind join activity instead of one card each', () => {
  for (const text of [
    '[child-exited: completed child:fix-motion]\n\nLast assistant text: done',
    '[child-exited: no-reply child:review]',
    '[child-exited: cancelled child:audit]',
  ])
    assert.equal(isTechnicalMessage({ role: 'system', customType: 'rlm_child_terminal_notice', text }), true);
});
