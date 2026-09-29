import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverCli } from '../lib/agent.mjs';
import { transformChildAdmission } from '../runtime/session-quiescence.mjs';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const MARKER = '/* Studio: admit the initial child task before agent messages. */';
const engine = (async () => {
  const root = discoverCli()?.packageDir;
  assert.ok(root, 'native engine must be available');
  const core = await readFile(join(root, 'dist/core/agent-session.js'), 'utf8');
  for (const name of await readdir(join(root, 'dist/bundle'))) {
    if (!name.endsWith('.js')) continue;
    const bundle = await readFile(join(root, 'dist/bundle', name), 'utf8');
    if (bundle.includes('async _startRlmChildRun(')) return { core, bundle };
  }
  assert.fail('native bundled AgentSession must be available');
})();

function only(source, expression) {
  const matches = [...source.matchAll(expression)];
  assert.equal(matches.length, 1);
  return matches[0];
}

function method(source, name) {
  return only(source, new RegExp(`^( +)async ${name}\\([^\\n]+\\) \\{[\\s\\S]*?^\\1\\}`, 'gm'))[0];
}

function fixture(source, { suspended = false } = {}) {
  const publication = Promise.withResolvers();
  publication.promise.catch(() => {});
  const run = { id: 'child-fixture', status: 'running', publication };
  const order = [];
  const dispose = new AbortController();
  const child = {
    _sessionActionCommitDisposeAbortController: dispose,
    _sessionInputPumpSuspended: suspended,
    _agentMessageClearEpoch: 0,
    _assertSessionActionAdmissionAvailable() {
      assert.equal(dispose.signal.aborted, false, 'disposed receiver cannot admit a message');
    },
    _isBusyForSessionInput: () => true,
    _prompt: async () => {
      order.push('message');
    },
    queueAgentMessagePrompt: async () => {
      order.push('queued-message');
      return true;
    },
    abort: () => {
      order.push('abort');
    },
    promptAndWait: async (_text, options) => {
      assert.equal(order.includes('message'), false, 'initial task must precede incoming messages');
      assert.equal(order.includes('queued-message'), false, 'initial task must precede queued messages');
      order.push('task');
      options.preflightResult?.(true);
    },
  };
  const publisher = only(source, /const publishChildSession = \(child\) => \{[\s\S]*?\n\s*\};/g)[0];
  const runName = publisher.match(/this\._activeRlmChildRuns\.get\((run\d*)\.id\)/)[1];
  const publish = new Function(runName, `let childSession; ${publisher}; return publishChildSession;`).call(
    { _activeRlmChildRuns: new Map([[run.id, run]]) },
    run,
  );
  const prompt = only(source, /await child\.promptAndWait\(content, \{[\s\S]*?\n\s*\}\);/g)[0];
  const start = () =>
    new AsyncFunction(runName, 'child', 'content', 'spawnMessage', prompt)(run, child, 'task', {
      details: { id: `spawn:${run.id}` },
    });
  const accept = method(source, 'acceptAgentMessagePrompt');
  const waitName = only(source, /await (waitForPromiseOrAbort\d*)\(pauseReleased, waitSignal,/g)[1];
  const waitFunction = only(
    source,
    new RegExp(`^function ${waitName}\\(promise, signal, abortMessage\\) \\{[\\s\\S]*?^\\}`, 'gm'),
  )[0];
  const wait = new Function(`${waitFunction}; return ${waitName};`)();
  const body = accept.slice(accept.indexOf('{') + 1, accept.lastIndexOf('}'));
  const execute = new AsyncFunction(
    'text',
    'options',
    'isAgentSessionMessage',
    'parseAgentSessionMessagePromptId',
    waitName,
    body,
  );
  const incoming = (options = {}) =>
    execute.call(
      child,
      'message',
      {
        customMessage: { details: { id: 'agentmsg_fixture', fromRelationship: 'parent' } },
        streamingBehavior: 'steer',
        queueIfBusy: true,
        ...options,
      },
      () => true,
      () => 'agentmsg_fixture',
      wait,
    );
  return { run, child, order, dispose, publish, start, incoming, publication };
}

// Let already-enqueued promise reactions run; no clock-based delay hides the race.
const checkpoint = () => new Promise((resolve) => queueMicrotask(resolve));

test('native baseline publishes too early and lets messages precede the task', async () => {
  for (const source of Object.values(await engine)) {
    const f = fixture(source);
    f.publish(f.child);
    await f.publication.promise;
    await f.incoming();
    assert.deepEqual(f.order, ['message']);
    await assert.rejects(f.start(), /initial task must precede incoming messages/);
  }
});

test('initial task precedes direct, broadcast/sibling receiver and suspended messages', async () => {
  for (const source of Object.values(await engine)) {
    const patched = transformChildAdmission(source).source;
    for (const suspended of [false, true]) {
      const f = fixture(patched, { suspended });
      f.publish(f.child);
      let published = false;
      f.publication.promise.then(() => {
        published = true;
      });
      // Broadcast/sibling delivery bypasses the parent's publication wait.
      const incoming = f.incoming();
      // An explicit parent message first waits on the same native publication.
      const direct = f.publication.promise.then(() => f.incoming());
      await checkpoint();
      assert.equal(published, false);
      assert.deepEqual(f.order, []);
      await f.start();
      await Promise.all([incoming, direct]);
      assert.equal(published, true);
      assert.deepEqual(f.order, ['task', ...Array(2).fill(suspended ? 'queued-message' : 'message')]);
      assert.equal(f.run.session, f.child, 'early binding is retained for cancellation');
    }
  }
});

test('startup failure, cancellation and deletion reject early-message waiters', async () => {
  const { core } = await engine;
  const patched = transformChildAdmission(core).source;
  for (const reason of ['startup failed', 'cancelled', 'deleted']) {
    const f = fixture(patched);
    f.publish(f.child);
    const error = new Error(reason);
    const incoming = assert.rejects(f.incoming(), (actual) => actual === error);
    const direct = assert.rejects(f.publication.promise, (actual) => actual === error);
    f.publication.reject(error);
    await Promise.all([incoming, direct]);
    assert.deepEqual(f.order, []);
  }
  const f = fixture(patched);
  f.publish(f.child);
  const rejected = assert.rejects(f.incoming(), /initial task was not accepted/);
  f.child.promptAndWait = async (_text, options) => {
    options.preflightResult(false);
  };
  await f.start();
  await rejected;
});

test('message cancellation/disposal abort the wait without accepting or deadlocking', async () => {
  const { core } = await engine;
  for (const kind of ['message', 'dispose']) {
    const f = fixture(transformChildAdmission(core).source);
    f.publish(f.child);
    const abort = kind === 'dispose' ? f.dispose : new AbortController();
    const incoming = assert.rejects(
      f.incoming({ signal: abort.signal }),
      /Agent message admission cancelled/,
    );
    abort.abort();
    await incoming;
    assert.deepEqual(f.order, []);
    if (kind === 'message') {
      await f.start();
      await f.incoming();
      assert.deepEqual(f.order, ['task', 'message'], 'one cancelled message does not cancel the child');
    }
  }
});

test('ordinary sessions and retained children keep existing message admission', async () => {
  const { core } = await engine;
  const f = fixture(transformChildAdmission(core).source);
  await f.incoming();
  assert.deepEqual(f.order, ['message']);
  f.order.length = 0;
  f.publish(f.child);
  await f.start();
  await f.incoming();
  await f.incoming();
  assert.deepEqual(f.order, ['task', 'message', 'message']);
});

test('admission transform is narrow, atomic, idempotent and preserves native cleanup', async () => {
  for (const source of Object.values(await engine)) {
    const patched = transformChildAdmission(source);
    assert.equal(patched.changed, true);
    assert.equal(patched.source.split(MARKER).length - 1, 1);
    assert.deepEqual(transformChildAdmission(patched.source), { source: patched.source, changed: false });
    assert.equal(
      method(patched.source, '_awaitPendingRlmChildPublication'),
      method(source, '_awaitPendingRlmChildPublication'),
    );
    const restore = (text, reference, pattern) =>
      text.replace(only(text, pattern)[0], only(reference, pattern)[0]);
    let restored = patched.source;
    for (const pattern of [
      /const publishChildSession = \(child\) => \{[\s\S]*?\n\s*\};/g,
      /await child\.promptAndWait\(content, \{[\s\S]*?\n\s*\}\);/g,
      /async acceptAgentMessagePrompt\(text, options\) \{[\s\S]*?(?=const customMessage =)/g,
    ])
      restored = restore(restored, source, pattern);
    assert.equal(restored, source, 'all other cancellation, cleanup and terminal paths are untouched');
  }
});

test('admission transform rejects changed layouts and partial or duplicate patches', async () => {
  const { core } = await engine;
  const error = /child admission layout changed/;
  assert.deepEqual(transformChildAdmission('export const value = 1;'), {
    source: 'export const value = 1;',
    changed: false,
  });
  assert.throws(() => transformChildAdmission('', { required: true }), error);
  assert.throws(() => transformChildAdmission(`${core}\n${core}`), error);
  assert.throws(() => transformChildAdmission(`${MARKER}\n${core}`), error);
  for (const [before, after] of [
    ['run.publication.resolve();', 'run.publication.resolve(42);'],
    ['customMessage: spawnMessage,', 'customMessage: otherMessage,'],
    ['async acceptAgentMessagePrompt(text, options)', 'async acceptAgentMessagePrompt(input, options)'],
  ])
    assert.throws(() => transformChildAdmission(core.replace(before, after)), error);
  const patched = transformChildAdmission(core).source;
  assert.throws(
    () =>
      transformChildAdmission(
        patched.replace(
          'child._studioRlmTaskAdmission = run.publication.promise;',
          'run.publication.resolve();',
        ),
      ),
    error,
  );
  assert.throws(
    () =>
      transformChildAdmission(
        patched.replace('if (accepted) run.publication.resolve();', 'run.publication.resolve();'),
      ),
    error,
  );
});
