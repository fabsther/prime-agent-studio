import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCli } from '../lib/agent.mjs';
import { transformChildCompletion, initialize, load } from '../runtime/session-quiescence.mjs';

const MARKER = '/* Studio: progress replies do not replace child completion. */';
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const engine = (async () => {
  const root = discoverCli()?.packageDir;
  assert.ok(root, 'native engine must be available');
  const core = await readFile(join(root, 'dist/core/agent-session.js'), 'utf8');
  let bundle;
  for (const name of await readdir(join(root, 'dist/bundle'))) {
    if (!name.endsWith('.js')) continue;
    const text = await readFile(join(root, 'dist/bundle', name), 'utf8');
    if (text.includes('async _startRlmChildRun(')) {
      bundle = text;
      break;
    }
  }
  assert.ok(bundle, 'native bundled AgentSession must be available');
  const { createRlmChildTerminalNoticeMessage } = await import(
    pathToFileURL(join(root, 'dist/core/messages.js'))
  );
  return { root, core, bundle, createRlmChildTerminalNoticeMessage };
})();

function completionBlock(source) {
  const start = source.indexOf('const parentReplyCountBeforeRun = child._parentReplyCount;');
  assert.ok(start > 0);
  const register = source.indexOf('if (!this.registerRlmChildSession(', start);
  assert.ok(register > start);
  return source.slice(source.lastIndexOf('if (!run', register), register).trim();
}

async function runCompletion(
  source,
  {
    replies = 0,
    baseline = 0,
    deleted = false,
    suppressed = false,
    text = 'FINAL_RESULT',
    factory,
    parent = { isStreaming: false, _pendingNextTurnMessages: [] },
  } = {},
) {
  const block = completionBlock(source);
  const runName = block.match(/^if \(!(run\d*)\./)[1];
  const execute = new AsyncFunction(
    runName,
    'child',
    'parentReplyCountBeforeRun',
    'createRlmChildTerminalNoticeMessage',
    'compactRlmText',
    'deliverTerminalMessageToParent',
    'sessionName',
    block,
  );
  const notices = [];
  await execute.call(
    parent,
    { id: 'child-fixture', detachedDeletion: deleted, suppressTerminalNotice: suppressed },
    { _parentReplyCount: replies, getLastAssistantText: () => text },
    baseline,
    factory ?? (await engine).createRlmChildTerminalNoticeMessage,
    (value) => value.slice(0, 500),
    async (notice) => {
      notices.push(notice);
    },
    'reviewer',
  );
  return notices;
}

test('native bug: an earlier progress reply suppresses the child completion handoff', async () => {
  const { core, bundle } = await engine;
  for (const source of [core, bundle]) {
    assert.equal((await runCompletion(source)).length, 1);
    assert.equal((await runCompletion(source, { replies: 1 })).length, 0);
  }
});

test('progress then silent exit and explicit final replies both retain one neutral completion', async () => {
  const { core, bundle } = await engine;
  for (const source of [core, bundle]) {
    const patched = transformChildCompletion(source).source;
    for (const replies of [1, 4]) {
      const notices = await runCompletion(patched, { replies });
      assert.equal(notices.length, 1);
      assert.equal(notices[0].customType, 'rlm_child_terminal_notice');
      assert.equal(notices[0].details.kind, 'completed');
      assert.equal(notices[0].details.childId, 'child-fixture');
      assert.equal(notices[0].details.lastAssistantTextPreview, 'FINAL_RESULT');
      assert.match(notices[0].content, /^\[child-exited: completed child:reviewer\]/);
      assert.match(notices[0].content, /Last assistant text: FINAL_RESULT/);
      assert.doesNotMatch(notices[0].content, /no-reply/);
    }
    // An existing count from an earlier task is not a reply to this run.
    const [noReply] = await runCompletion(patched, { replies: 4, baseline: 4 });
    assert.equal(noReply.details.kind, 'completed_without_reply');
    assert.match(noReply.content, /^\[child-exited: no-reply child:reviewer\]/);
    assert.equal(
      (await runCompletion(patched, { replies: 1, text: '' }))[0].details.lastAssistantTextPreview,
      undefined,
    );
  }
});

test('changed native notice headers fail explicitly instead of mislabeling a completion', async () => {
  const { core, createRlmChildTerminalNoticeMessage } = await engine;
  await assert.rejects(
    runCompletion(transformChildCompletion(core).source, {
      replies: 1,
      factory: (details) => ({
        ...createRlmChildTerminalNoticeMessage(details),
        content: 'Changed native header',
      }),
    }),
    /child completion notice changed/,
  );
});

test('explicitly deleted and suppressed child runs retain native notice suppression', async () => {
  const { core, bundle } = await engine;
  for (const source of [core, bundle]) {
    for (const replies of [0, 1]) {
      const patched = transformChildCompletion(source).source;
      assert.deepEqual(await runCompletion(patched, { replies, deleted: true }), []);
      assert.deepEqual(await runCompletion(patched, { replies, suppressed: true }), []);
    }
  }
});

test('completion transform is narrow, idempotent and leaves failure/cancel/retention paths unchanged', async () => {
  const { core, bundle } = await engine;
  for (const source of [core, bundle]) {
    const patched = transformChildCompletion(source);
    assert.equal(patched.changed, true);
    assert.equal(patched.source.split(MARKER).length - 1, 1);
    assert.equal(patched.source.replace(completionBlock(patched.source), completionBlock(source)), source);
    assert.deepEqual(transformChildCompletion(patched.source), { source: patched.source, changed: false });
  }
});

test('completion transform rejects changed layouts and partial or duplicate patches', async () => {
  const { core } = await engine;
  const unrelated = 'export const value = 1;';
  assert.deepEqual(transformChildCompletion(unrelated), { source: unrelated, changed: false });
  assert.throws(
    () => transformChildCompletion(unrelated, { required: true }),
    /child completion layout changed/,
  );
  assert.throws(
    () =>
      transformChildCompletion(core.replace('child._parentReplyCount === parentReplyCountBeforeRun', 'true')),
    /child completion layout changed/,
  );
  assert.throws(
    () => transformChildCompletion(core.replace('kind: "completed_without_reply"', 'kind: "unexpected"')),
    /child completion layout changed/,
  );
  assert.throws(() => transformChildCompletion(`${core}\n${core}`), /child completion layout changed/);
  assert.throws(() => transformChildCompletion(`${MARKER}\n${core}`), /child completion layout changed/);
  const patched = transformChildCompletion(core).source;
  assert.throws(
    () =>
      transformChildCompletion(
        patched.replace('notice.details.kind = "completed"', 'notice.details.kind = "cancelled"'),
      ),
    /child completion layout changed/,
  );
});

test('Studio-owned loader composes all three lifecycle fixes for core and bundle only', async () => {
  const { root, core, bundle } = await engine;
  initialize({ packageRoot: root });
  for (const [path, source] of [
    ['dist/core/agent-session.js', core],
    ['dist/bundle/fixture.js', bundle],
  ]) {
    const url = pathToFileURL(join(root, path)).href;
    const result = await load(url, {}, async () => ({ format: 'module', source: Buffer.from(source) }));
    assert.ok(result.source.includes(MARKER));
    assert.ok(result.source.includes('/* Studio: child cancellation is not parent cancellation. */'));
    assert.ok(result.source.includes('/* Studio: admit the initial child task before agent messages. */'));
    const again = await load(url, {}, async () => result);
    assert.equal(again, result);
  }
  for (const path of ['dist/core/messages.js', '../outside/dist/core/agent-session.js']) {
    const result = { format: 'module', source: core };
    assert.equal(await load(pathToFileURL(join(root, path)).href, {}, async () => result), result);
  }
});

test('a busy parent that already has the reply gets next-turn context, not a follow-up model call', async () => {
  const { core, bundle } = await engine;
  for (const source of [core, bundle]) {
    const patched = transformChildCompletion(source).source;
    const parent = { isStreaming: true, _pendingNextTurnMessages: [] };
    assert.deepEqual(await runCompletion(patched, { replies: 2, parent }), []);
    assert.equal(parent._pendingNextTurnMessages.length, 1);
    const [context] = parent._pendingNextTurnMessages;
    assert.equal(context.customType, 'rlm_child_completion_context');
    assert.match(context.content, /^\[child-exited: completed child:reviewer\]/);
    // No reply yet, or an idle parent: the durable wake-up notice is kept.
    assert.equal(
      (await runCompletion(patched, { parent: { isStreaming: true, _pendingNextTurnMessages: [] } })).length,
      1,
    );
    assert.equal((await runCompletion(patched, { replies: 2 })).length, 1);
  }
});
