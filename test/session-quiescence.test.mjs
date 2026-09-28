import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverCli } from '../lib/agent.mjs';
import {
  transformSessionQuiescence,
  initialize as initQuiescence,
  load as quiescenceLoad,
} from '../runtime/session-quiescence.mjs';

const CANCELLED = 'RLM quiescence wait cancelled';
const MARKER = '/* Studio: child cancellation is not parent cancellation. */';
const METHOD_RE = /^( +)async waitForRlmQuiescence\(externalSignal\) \{[\s\S]*?^\1\}/gm;
const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor;

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function extractMethod(source) {
  const methods = [...source.matchAll(METHOD_RE)];
  assert.equal(methods.length, 1, 'expected exactly one native waitForRlmQuiescence method');
  return methods[0][0];
}

function buildWaitFn(methodSource) {
  const open = methodSource.indexOf('{');
  const close = methodSource.lastIndexOf('}');
  assert.ok(open > 0 && close > open, 'method braces should be visible');
  const body = methodSource.slice(open + 1, close);
  return new AsyncFunctionCtor('externalSignal', body);
}

function cancelledError() {
  return new Error(CANCELLED);
}

function makeLeaf() {
  return {
    isSessionActive: false,
    _hasDeferredRlmTerminalNotices() {
      return false;
    },
    _hasUnsettledRlmQuiescenceWork() {
      return false;
    },
  };
}

function makeParent(live) {
  return {
    isSessionActive: false,
    _rlmQuiescenceWaitAborts: new Set(),
    _unsettledRlmChildRuns: new Set(),
    async waitForHeadlessIdle() {},
    _hasDeferredRlmTerminalNotices() {
      return false;
    },
    async _waitForSessionActivityChange() {
      await new Promise(() => {});
    },
    _rlmChildSessionSnapshot() {
      return [...live];
    },
    _hasUnsettledRlmQuiescenceWork() {
      return live.some(
        (child) =>
          child.isSessionActive ||
          (typeof child._hasUnsettledRlmQuiescenceWork === 'function' &&
            child._hasUnsettledRlmQuiescenceWork()),
      );
    },
  };
}

// Stub child whose wait can be scripted. When signal aborts, it rejects with
// the exact native cancellation error, mirroring the native onCancelled path.
// The child reports unsettled quiescence work until its wait settles, so the
// native parent loop enters the Promise.all branch instead of returning early.
// This mirrors a real running child (isSessionActive or nested unsettled work).
function makeScriptedChild({ onCall } = {}) {
  const child = {
    ...makeLeaf(),
    calls: 0,
    pending: true,
    _hasUnsettledRlmQuiescenceWork() {
      return child.pending;
    },
    waitForRlmQuiescence(signal) {
      child.calls += 1;
      const done = () => {
        child.pending = false;
      };
      const inner = onCall?.(signal, child);
      return Promise.resolve(inner).then(
        (value) => {
          done();
          return value;
        },
        (error) => {
          done();
          throw error;
        },
      );
    },
  };
  return child;
}

function delayChild(ms) {
  return makeScriptedChild({
    onCall: (signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(cancelledError());
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(cancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  });
}

async function engineSources() {
  const cli = discoverCli();
  assert.ok(cli?.packageDir, 'native 0.9.6 engine packageDir should be discoverable');
  const pkg = cli.packageDir;
  const corePath = join(pkg, 'dist', 'core', 'agent-session.js');
  const core = await readFile(corePath, 'utf8');
  const bundleDir = join(pkg, 'dist', 'bundle');
  const names = (await readdir(bundleDir)).filter((name) => name.endsWith('.js'));
  let bundlePath = null;
  let bundle = null;
  for (const name of names) {
    const text = await readFile(join(bundleDir, name), 'utf8');
    if (text.includes('async waitForRlmQuiescence(') && text.includes('async _startRlmChildRun(')) {
      bundlePath = join(bundleDir, name);
      bundle = text;
      break;
    }
  }
  assert.ok(bundle, 'native bundle containing the quiescence barrier should exist');
  return { cli, pkg, corePath, core, bundlePath, bundle };
}

test('transform leaves unrelated sources untouched', () => {
  assert.deepEqual(transformSessionQuiescence('export const unrelated = 1;'), {
    source: 'export const unrelated = 1;',
    changed: false,
  });
  const noMethod = 'async function other() { await Promise.resolve(); }\n';
  assert.deepEqual(transformSessionQuiescence(noMethod), { source: noMethod, changed: false });
});

test('transform fails closed on unknown layouts when required', () => {
  assert.throws(
    () => transformSessionQuiescence('export const missing = 1;', { required: true }),
    /child completion layout changed/,
  );
});

test('marker-only partial patch fails closed', async () => {
  const { core } = await engineSources();
  const method = extractMethod(core);
  const call = 'child.waitForRlmQuiescence(cancellation.signal)';
  const partial = method.replace(call, `${MARKER}\n${call}`);
  const source = core.replace(method, partial);
  assert.throws(() => transformSessionQuiescence(source), /child completion layout changed/);
  assert.throws(() => transformSessionQuiescence(`${method}\n${method}`), /child completion layout changed/);
});

test('transform patches the real unbundled core and bundle narrowly and idempotently', async () => {
  const { core, bundle } = await engineSources();
  for (const [label, source] of [
    ['core', core],
    ['bundle', bundle],
  ]) {
    const out = transformSessionQuiescence(source);
    assert.equal(out.changed, true, `${label} should be patched`);
    assert.ok(out.source.includes(MARKER), `${label} should carry the marker`);
    assert.ok(
      out.source.includes(
        'if (cancellation.signal.aborted || error?.message !== "RLM quiescence wait cancelled") throw error;',
      ),
      `${label} should only swallow the exact error when the parent is alive`,
    );
    assert.ok(out.source.includes('.catch((error) =>'), `${label} should wrap the child wait`);
    assert.equal(out.source.split(MARKER).length - 1, 1, `${label} should patch exactly once`);
    // Narrow diff: removing the wrapper restores the original.
    const call = 'child.waitForRlmQuiescence(cancellation.signal)';
    const replacement = `${call}.catch((error) => {\n                        ${MARKER}\n                        if (cancellation.signal.aborted || error?.message !== "RLM quiescence wait cancelled") throw error;\n                    })`;
    assert.ok(out.source.includes(replacement), `${label} replacement should match the runtime contract`);
    assert.equal(out.source.replace(replacement, call), source, `${label} diff should be narrow`);
    const again = transformSessionQuiescence(out.source);
    assert.equal(again.changed, false, `${label} second pass should be a no-op`);
    assert.equal(again.source, out.source, `${label} second pass should be stable`);
  }
});

test('loader scopes the patch to the native AgentSession and leaves other modules intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-quiescence-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const { core, bundle } = await engineSources();
  initQuiescence({ packageRoot: root });
  const coreUrl = pathToFileURL(join(root, 'dist/core/agent-session.js')).href;
  const bundleUrl = pathToFileURL(join(root, 'dist/bundle/chunk-TEST.js')).href;
  const rpcUrl = pathToFileURL(join(root, 'dist/modes/rpc/rpc-mode.js')).href;
  const outsideUrl = pathToFileURL(join(resolve(root, '..'), 'other/dist/core/agent-session.js')).href;
  const readModule = (text) => async () => ({ format: 'module', source: Buffer.from(text) });

  const patchedCore = await quiescenceLoad(coreUrl, {}, readModule(core));
  assert.ok(String(patchedCore.source).includes(MARKER));

  const patchedBundle = await quiescenceLoad(bundleUrl, {}, readModule(bundle));
  assert.ok(String(patchedBundle.source).includes(MARKER));

  const bundleWithoutRun = bundle.replaceAll('async _startRlmChildRun(', 'async _renamedChildRun(');
  assert.ok(bundleWithoutRun !== bundle);
  const skippedBundle = await quiescenceLoad(bundleUrl, {}, readModule(bundleWithoutRun));
  assert.equal(String(skippedBundle.source), bundleWithoutRun);

  const skippedRpc = await quiescenceLoad(rpcUrl, {}, readModule(core));
  assert.equal(String(skippedRpc.source), core);

  const skippedOutside = await quiescenceLoad(outsideUrl, {}, readModule(core));
  assert.equal(String(skippedOutside.source), core);

  const nonFile = await quiescenceLoad('https://example.invalid/x.js', {}, readModule(core));
  assert.equal(String(nonFile.source), core);

  const nonModule = await quiescenceLoad(coreUrl, {}, async () => ({ format: 'commonjs', source: core }));
  assert.equal(nonModule.source, core);

  await assert.rejects(
    quiescenceLoad(coreUrl, {}, readModule('export const broken = 1;')),
    /child completion layout changed/,
  );

  // String sources are patched the same way as Buffer sources.
  const patchedString = await quiescenceLoad(coreUrl, {}, async () => ({ format: 'module', source: core }));
  assert.ok(String(patchedString.source).includes(MARKER));
});

test('session-preferences loader shares the native scope with the quiescence hook', async () => {
  const text = await readFile(resolve('runtime/session-preferences-loader.mjs'), 'utf8');
  assert.ok(text.includes("./session-quiescence.mjs"), 'loader should register the quiescence hook');
  assert.ok(text.includes('./session-preferences.mjs'), 'loader should keep the preferences hook');
  const quiescenceLine = text.split('\n').find((line) => line.includes('session-quiescence.mjs'));
  assert.ok(quiescenceLine?.includes('register('), 'quiescence hook should use module register');
  // Both hooks share one resolved packageRoot so RPC and print inherit the same patch.
  const registerCalls = text.split('\n').filter((line) => line.includes('register('));
  assert.ok(registerCalls.length >= 2, 'both hooks should be registered');
  assert.ok(text.includes('{ packageRoot:'), 'both hooks should share the same data object');
});

test('native original propagates a deleted child cancellation to the parent barrier', async () => {
  const { core } = await engineSources();
  const waitForRlmQuiescence = buildWaitFn(extractMethod(core));
  const live = [];
  const parent = makeParent(live);
  const sibling = delayChild(60);
  const deleted = makeScriptedChild({
    onCall: () => {
      live.splice(live.indexOf(deleted), 1);
      return Promise.reject(cancelledError());
    },
  });
  live.push(deleted, sibling);
  await assert.rejects(withTimeout(waitForRlmQuiescence.call(parent, undefined), 2000, 'original parent'), (error) => {
    assert.equal(error?.message, CANCELLED);
    return true;
  });
  assert.equal(parent._rlmQuiescenceWaitAborts.size, 0, 'original wait should release its abort entry');
});

test('patched barrier survives a deleted child and still waits for sibling and new work', async () => {
  const { core } = await engineSources();
  const patched = transformSessionQuiescence(core);
  assert.equal(patched.changed, true);
  const waitForRlmQuiescence = buildWaitFn(extractMethod(patched.source));
  const live = [];
  const parent = makeParent(live);
  const sibling = delayChild(15);
  const newcomer = delayChild(40);
  let newcomerSeen = 0;
  const wrappedNewcomer = makeScriptedChild({
    onCall: (signal) => {
      newcomerSeen += 1;
      return newcomer.waitForRlmQuiescence(signal);
    },
  });
  Object.assign(wrappedNewcomer, { isSessionActive: false });
  const deleted = makeScriptedChild({
    onCall: () => {
      // Simulate native deletion: the child leaves the snapshot and a new
      // child admitted during the drain appears before the next snapshot.
      live.splice(live.indexOf(deleted), 1);
      live.push(wrappedNewcomer);
      return Promise.reject(cancelledError());
    },
  });
  live.push(deleted, sibling);
  await withTimeout(waitForRlmQuiescence.call(parent, undefined), 2000, 'patched parent with new work');
  assert.ok(sibling.calls >= 1, 'sibling should have been waited');
  assert.ok(newcomerSeen >= 1, 'new work admitted during the drain should have been waited');
  assert.equal(sibling.pending, false, 'sibling must settle before the parent');
  assert.equal(newcomer.pending, false, 'new work must settle before the parent');
  assert.equal(parent._rlmQuiescenceWaitAborts.size, 0, 'patched wait should release its abort entry');
});

test('patched parent and external Stop still reject promptly on cancellation', async () => {
  const { core } = await engineSources();
  const patched = transformSessionQuiescence(core);
  const waitForRlmQuiescence = buildWaitFn(extractMethod(patched.source));
  const live = [];
  const parent = makeParent(live);
  const slow = delayChild(5000);
  live.push(slow);
  const external = new AbortController();
  setTimeout(() => external.abort(), 10);
  const started = Date.now();
  await assert.rejects(
    withTimeout(waitForRlmQuiescence.call(parent, external.signal), 2000, 'patched stop'),
    (error) => {
      assert.equal(error?.message, CANCELLED);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1500, 'Stop should reject promptly instead of waiting for the child');
  assert.equal(parent._rlmQuiescenceWaitAborts.size, 0, 'cancelled wait should release its abort entry');
});

test('patched barrier still rejects unrelated child errors', async () => {
  const { core } = await engineSources();
  const patched = transformSessionQuiescence(core);
  const waitForRlmQuiescence = buildWaitFn(extractMethod(patched.source));
  const live = [];
  const parent = makeParent(live);
  const boom = new Error('boom-quiescence-probe');
  const failing = makeScriptedChild({
    onCall: () => Promise.reject(boom),
  });
  live.push(failing);
  await assert.rejects(
    withTimeout(waitForRlmQuiescence.call(parent, undefined), 2000, 'patched unrelated error'),
    (error) => {
      assert.equal(error, boom);
      return true;
    },
  );
  assert.equal(parent._rlmQuiescenceWaitAborts.size, 0, 'failed wait should release its abort entry');
});

test('patched deletion error while the parent itself is aborted still rejects', async () => {
  const { core } = await engineSources();
  const patched = transformSessionQuiescence(core);
  const waitForRlmQuiescence = buildWaitFn(extractMethod(patched.source));
  const live = [];
  const parent = makeParent(live);
  const external = new AbortController();
  external.abort();
  const deleted = makeScriptedChild({
    onCall: () => Promise.reject(cancelledError()),
  });
  live.push(deleted);
  await assert.rejects(
    withTimeout(waitForRlmQuiescence.call(parent, external.signal), 2000, 'aborted parent with deleted child'),
    (error) => {
      assert.equal(error?.message, CANCELLED);
      return true;
    },
  );
  assert.equal(parent._rlmQuiescenceWaitAborts.size, 0, 'aborted wait should release its abort entry');
});
