// Isolated real PrimeAgent 0.9.6 loopback proof for session-quiescence fix.
// Owns ONLY this script + evidence test-results/quiescence-fix/.
// Reuses test-subagents-native.mjs createAgentRuntime/liveSessionClient pattern.
// No paid provider, no real sessions, no shared daemon. Fixture loopback only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createLiveSessionClient } from '../lib/live-session-client.mjs';

const MANAGED_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON;
assert.ok(MANAGED_PYTHON, 'Set PRIME_AGENT_KERNEL_PYTHON to the managed native kernel.');
const BOUND_MS = 60000;
const STILL_OPEN_PROBE_MS = 4000;
const CANCEL_BUDGET_MS = 20000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function bounded(promise, label, ms = BOUND_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function cleanup(client, runtime, provider, root) {
  client?.close();
  // Always close the fixture provider, even if owned runtime teardown fails.
  try {
    if (runtime) await bounded(runtime.close(), 'owned runtime cleanup', 30000);
  } finally {
    provider.closeAllConnections();
    await bounded(new Promise((done) => provider.close(done)), 'provider cleanup', 5000);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
async function until(check, timeout = BOUND_MS, label = 'fixture') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    let result;
    try {
      result = await check();
    } catch {
      result = null;
    }
    if (result) return result;
    await sleep(60);
  }
  throw new Error(`Quiescence fixture timed out (${label}).`);
}

const ROOT_FIRST = 'QUIESCENCE_ROOT_FIRST';
const REPLACE_MSG = 'DELETE_AND_REPLACE';

const SPAWN_VICTIM_CODE = [
  'import rlm',
  'v = await rlm.spawn("VICTIM_TASK_HELD", name="victim", model="fixture/victim")',
  'print("VICTIM_ADMITTED:" + v.rlm_child_id)',
].join('\n');

const REPLACE_CODE = [
  'import rlm',
  'd = await rlm.delete_subagent("victim")',
  'print("VICTIM_DELETED:" + d.session_name)',
  's = await rlm.spawn("SURVIVOR_TASK_HELD", name="survivor", model="fixture/survivor")',
  'print("SURVIVOR_ADMITTED:" + s.rlm_child_id)',
].join('\n');

function sseFrame(res, requests, body, delta, finishReason = null) {
  res.write(
    `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
  );
}

async function runDeleteReplace({ allowQuestions, label }) {
  const root = await mkdtemp(join(tmpdir(), 'prime-quiescence-'));
  const cwd = join(root, 'project');
  const agentHome = join(root, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  await Promise.all([cwd, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
  const requests = [];
  const events = [];
  let releaseVictim = false;
  let releaseSurvivor = false;
  let spawnedVictim = false;
  let didReplace = false;
  let client = null;
  let runtime = null;
  const provider = createServer(async (req, res) => {
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const lastUser = body.messages.findLast((m) => m.role === 'user');
      const content = lastUser?.content;
      const prompt = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      let code = null;
      if (prompt.includes(ROOT_FIRST) && !spawnedVictim) {
        spawnedVictim = true;
        code = SPAWN_VICTIM_CODE;
      } else if (prompt.includes(REPLACE_MSG) && !didReplace) {
        didReplace = true;
        code = REPLACE_CODE;
      } else if (body.model === 'victim' && !releaseVictim) {
        await until(() => releaseVictim, BOUND_MS, 'victim-gate');
      } else if (body.model === 'survivor' && !releaseSurvivor) {
        await until(() => releaseSurvivor, BOUND_MS, 'survivor-gate');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseFrame(res, requests, body, { role: 'assistant' });
      if (code) {
        sseFrame(res, requests, body, {
          tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'ipython', arguments: JSON.stringify({ code }) } }],
        });
        sseFrame(res, requests, body, {}, 'tool_calls');
      } else {
        sseFrame(res, requests, body, { content: 'Fixture completed.' });
        sseFrame(res, requests, body, {}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message || error) }));
      } catch {}
    }
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  const detail = { label, allowQuestions, root };
  try {
    await writeFile(join(agentHome, 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          apiKey: 'fixture-only',
          models: ['parent', 'victim', 'survivor'].map((id) => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 4096 })),
        },
      },
    }));
    await writeFile(join(agentHome, 'auth.json'), '{}');
    await writeFile(join(agentHome, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'parent', defaultThinkingLevel: 'medium',
      autoRefine: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false }, telemetry: { enabled: false, noticeShown: true },
    }));
    const cli = discoverCli();
    detail.cli = cli?.packageDir || null;
    detail.cliVersion = cli?.version || null;
    runtime = createAgentRuntime({
      agentHome, sessionDir,
      env: { ...process.env, PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_KERNEL_PYTHON: MANAGED_PYTHON },
    });
    // Bounded startup + deadline on fixture run.
    const handle = await bounded(
      runtime.start({ cwd, message: ROOT_FIRST, model: 'fixture/parent', thinking: 'medium', allowQuestions, onEvent: (e) => events.push(e) }),
      `Startup (${label})`,
    );
    detail.started = true;
    await until(() => requests.some((r) => r.model === 'victim'), BOUND_MS, `${label}: victim admitted`);
    detail.victimRequested = true;
    const sessionId = await until(() => handle.sessionId, BOUND_MS, `${label}: session id`);
    detail.sessionId = sessionId;
    client = createLiveSessionClient(runtime.getLiveEndpoint());
    const firstSnap = await until(async () => {
      try {
        const snap = await client.getInspector(sessionId, cwd);
        return snap.children.some((c) => c.sessionName === 'victim') ? snap : null;
      } catch { return null; }
    }, BOUND_MS, `${label}: victim visible`);
    detail.victimVisible = firstSnap.children.map((c) => ({ name: c.sessionName, status: c.status }));
    await until(() => events.some((event) => event.kind === 'message' && event.message?.role === 'assistant' && event.message.text === 'Fixture completed.'), BOUND_MS, `${label}: initial parent final`);
    // Give the explicit native completion barrier time to enter the child wait.
    await sleep(200);
    await bounded(client.send(sessionId, cwd, { message: REPLACE_MSG, mode: 'follow_up' }), 'replacement admission');
    detail.followUpSent = true;
    await until(() => requests.some((r) => r.model === 'survivor'), BOUND_MS, `${label}: survivor admitted`);
    detail.survivorRequested = true;
    const secondSnap = await until(async () => {
      try {
        const snap = await client.getInspector(sessionId, cwd);
        return snap.children.some((c) => c.sessionName === 'survivor') ? snap : null;
      } catch { return null; }
    }, BOUND_MS, `${label}: survivor visible`);
    detail.survivorVisible = secondSnap.children.map((c) => ({ name: c.sessionName, status: c.status }));
    detail.victimGoneAfterReplace = !secondSnap.children.some((c) => c.sessionName === 'victim');
    // While survivor held, worker must NOT close. Probe with bounded race.
    const early = await Promise.race([handle.done.then(() => true), sleep(STILL_OPEN_PROBE_MS).then(() => false)]);
    detail.closedWhileSurvivorHeld = early;
    assert.equal(early, false, `${label}: worker closed while survivor held (quiescence bug). Events: ${JSON.stringify(events.slice(-5))}`);
    releaseSurvivor = true;
    detail.survivorReleased = true;
    const done = await bounded(handle.done, `${label}: completion after survivor release`);
    detail.done = done;
    assert.equal(done.status, 'completed', `${label}: expected completed, got ${JSON.stringify(done)}`);
    assert.match(JSON.stringify(requests.map((r) => r.model)), /survivor/);
    assert.equal(events.some((event) => event.message?.stopReason === 'aborted'), false, 'Parent must not abort');
    assert.ok(events.some((event) => event.message?.text?.includes('child:survivor]') && event.message.text.includes('Last assistant text: Fixture completed.')), 'Survivor must finish its own response');
    detail.requestsModels = [...new Set(requests.map((r) => r.model))];
    detail.eventsTail = events.slice(-8);
    return { passed: true, ...detail };
  } finally {
    releaseVictim = true;
    releaseSurvivor = true;
    await cleanup(client, runtime, provider, root);
  }
}

async function runExplicitCancel({ allowQuestions, label }) {
  const root = await mkdtemp(join(tmpdir(), 'prime-quiescence-cancel-'));
  const cwd = join(root, 'project');
  const agentHome = join(root, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  await Promise.all([cwd, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
  const requests = [];
  const events = [];
  let releaseVictim = false;
  let spawnedVictim = false;
  let client = null;
  let runtime = null;
  const provider = createServer(async (req, res) => {
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const lastUser = body.messages.findLast((m) => m.role === 'user');
      const content = lastUser?.content;
      const prompt = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      let code = null;
      if (prompt.includes(ROOT_FIRST) && !spawnedVictim) {
        spawnedVictim = true;
        code = SPAWN_VICTIM_CODE;
      } else if (body.model === 'victim' && !releaseVictim) {
        await until(() => releaseVictim, BOUND_MS, 'cancel-victim-gate');
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseFrame(res, requests, body, { role: 'assistant' });
      if (code) {
        sseFrame(res, requests, body, {
          tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: 'ipython', arguments: JSON.stringify({ code }) } }],
        });
        sseFrame(res, requests, body, {}, 'tool_calls');
      } else {
        sseFrame(res, requests, body, { content: 'Fixture completed.' });
        sseFrame(res, requests, body, {}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      try { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); } catch {}
    }
  });
  await new Promise((done) => provider.listen(0, '127.0.0.1', done));
  const detail = { label, allowQuestions, root };
  try {
    await writeFile(join(agentHome, 'models.json'), JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
          apiKey: 'fixture-only',
          models: ['parent', 'victim', 'survivor'].map((id) => ({ id, name: id, reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 4096 })),
        },
      },
    }));
    await writeFile(join(agentHome, 'auth.json'), '{}');
    await writeFile(join(agentHome, 'settings.json'), JSON.stringify({
      defaultProvider: 'fixture', defaultModel: 'parent', defaultThinkingLevel: 'medium',
      autoRefine: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false }, telemetry: { enabled: false, noticeShown: true },
    }));
    runtime = createAgentRuntime({
      agentHome, sessionDir,
      env: { ...process.env, PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_KERNEL_PYTHON: MANAGED_PYTHON },
    });
    const handle = await bounded(
      runtime.start({ cwd, message: ROOT_FIRST, model: 'fixture/parent', thinking: 'medium', allowQuestions, onEvent: (e) => events.push(e) }),
      `Startup (${label})`,
    );
    await until(() => requests.some((r) => r.model === 'victim'), BOUND_MS, `${label}: victim admitted`);
    const sessionId = await until(() => handle.sessionId, BOUND_MS, `${label}: session id`);
    detail.sessionId = sessionId;
    client = createLiveSessionClient(runtime.getLiveEndpoint());
    await until(async () => {
      try {
        const snap = await client.getInspector(sessionId, cwd);
        return snap.children.some((c) => c.sessionName === 'victim') ? snap : null;
      } catch { return null; }
    }, BOUND_MS, `${label}: victim visible`);
    detail.victimVisible = true;
    const t0 = Date.now();
    const cancelPromise = handle.cancel();
    const done = await bounded(
      (async () => { await cancelPromise; return await handle.done; })(),
      `${label}: explicit cancel`, CANCEL_BUDGET_MS,
    );
    detail.cancelMs = Date.now() - t0;
    detail.done = done;
    assert.equal(done.status, 'stopped', `${label}: expected stopped after explicit cancel, got ${JSON.stringify(done)}`);
    return { passed: true, ...detail };
  } finally {
    releaseVictim = true;
    await cleanup(client, runtime, provider, root);
  }
}

const results = { engine: discoverCli()?.packageDir || null, startedAt: new Date().toISOString(), scenarios: {} };
for (const [key, run, allowQuestions] of [
  ['printReplace', runDeleteReplace, false],
  ['rpcReplace', runDeleteReplace, true],
  ['printCancel', runExplicitCancel, false],
  ['rpcCancel', runExplicitCancel, true],
]) {
  try {
    results.scenarios[key] = await run({ allowQuestions, label: key });
  } catch (error) {
    results.scenarios[key] = { passed: false, error: String(error?.stack || error) };
  }
  console.log(JSON.stringify({ scenario: key, ...results.scenarios[key] }));
}
results.finishedAt = new Date().toISOString();
results.passed = Object.values(results.scenarios).every((s) => s.passed === true);
await mkdir('test-results/quiescence-fix', { recursive: true });
await writeFile('test-results/quiescence-fix/quiescence-native-proof.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify({ passed: results.passed, scenarios: Object.fromEntries(Object.entries(results.scenarios).map(([k, v]) => [k, v.passed])) }, null, 2));
if (!results.passed) process.exit(1);
