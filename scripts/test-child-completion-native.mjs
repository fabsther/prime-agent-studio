// Isolated real PrimeAgent 0.9.6 loopback proof for the child-completion fix.
// Owns ONLY this script + evidence test-results/child-completion/.
// Reuses test-quiescence-native.mjs fixture patterns (loopback provider, fresh
// temp agentHome/sessionDir/auth/settings, createAgentRuntime). No paid tokens,
// no real sessions, no shared daemon. Fixture loopback only. Do not run other
// fixtures concurrently with this one.
//
// Bug: the 0.9.6 completion fallback compares parent reply counts across the
// whole child run, so one early agent_message progress reply suppresses the
// final lifecycle notice. Fixed behavior: a successful child run emits ONE
// neutral durable terminal notice even after earlier replies:
//   content: [child-exited: completed child:<name>] + last assistant text
//   customType: rlm_child_terminal_notice, details.kind: completed
// A no-reply child keeps the native completed_without_reply wording.
// Deletion/cancel/explicit suppression keep native behavior (covered elsewhere).
//
// This script asserts the FIXED behavior, so it FAILS on the unpatched hook
// (progress case gets zero notices) and passes once the runtime hook lands.
// It also checks the run status: `children` while the root waits on the held
// child, `turn_end` once the child settled.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';

const MANAGED_PYTHON = process.env.PRIME_AGENT_KERNEL_PYTHON;
assert.ok(MANAGED_PYTHON, 'Set PRIME_AGENT_KERNEL_PYTHON to the managed native kernel.');
const BOUND_MS = 90000;
const STILL_OPEN_PROBE_MS = 4000;
const IDLE_MS = 2000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function bounded(promise, label, ms = BOUND_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    await sleep(100);
  }
  throw new Error(`Child-completion fixture timed out (${label}).`);
}
function sseFrame(res, requests, body, delta, finishReason = null) {
  res.write(
    `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
  );
}
async function histories(sessionDir, agentHome) {
  const result = [];
  async function walk(directory) {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
        const parsed = lines.map((line) => JSON.parse(line));
        const header = parsed.find((e) => e.type === 'session');
        if (header) result.push({ path, id: header.id, entries: parsed });
      }
    }
  }
  await walk(sessionDir);
  await walk(join(agentHome, 'session-artifacts'));
  return result;
}
const msgOf = (entry) => (entry.type === 'custom_message' ? entry : entry.message);

async function runCase({ allowQuestions, childMode, label }) {
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`;
  const childName = childMode === 'progress' ? 'cc-progress' : 'cc-final';
  const ROOT_FIRST = `CC_ROOT_FIRST_${nonce}`;
  const PROG = `CC_PROGRESS_${nonce}`;
  const WAIT = `CC_WAITING_${nonce}`;
  const FINREPLY = `CC_FINAL_REPLY_${nonce}`;
  const FINAL_TEXT = `CC_CHILD_FINAL_${nonce.slice(-6)}`;
  const root = await mkdtemp(join(tmpdir(), 'prime-child-completion-'));
  const cwd = join(root, 'project');
  const agentHome = join(root, 'agent');
  const sessionDir = join(agentHome, 'sessions');
  await Promise.all([cwd, agentHome, sessionDir].map((p) => mkdir(p, { recursive: true })));
  const requests = [];
  const events = [];
  let releaseChild = false;
  let spawnedParent = false;
  let parentReplied = false;
  let parentFinal = false;
  let parentWaits = 0;
  let lastParentAt = 0;
  let childReqs = 0;
  let noticeDeliveries = 0;
  let runtime = null;

  const SPAWN_CODE = [
    'import rlm, asyncio',
    `c = await rlm.spawn("CC_CHILD_TASK", name="${childName}", model="fixture/child")`,
    'print("CC_CHILD_ADMITTED:" + c.rlm_child_id)',
    'await asyncio.sleep(5)',
    'print("CC_SPAWN_DONE")',
  ].join('\n');
  const REPLY_CODE = [
    'import agent_message',
    `r = await agent_message.send("${WAIT}", receiver_role="child", receiver_name="${childName}")`,
    'print("CC_PARENT_REPLIED")',
  ].join('\n');
  const WAIT_CODE = ['import asyncio', 'await asyncio.sleep(2)', 'print("CC_PARENT_WAITING")'].join('\n');
  const CHILD_PROGRESS_CODE = [
    'import agent_message',
    `r = await agent_message.send("${PROG}", receiver_role="parent")`,
    'print("CC_CHILD_PROGRESS_SENT")',
  ].join('\n');
  const CHILD_WORK_CODE = ['print("CC_CHILD_WORK_DONE")'].join('\n');
  const CHILD_FINAL_SEND_CODE = [
    'import agent_message',
    `r = await agent_message.send("${FINREPLY}", receiver_role="parent")`,
    'print("CC_CHILD_FINAL_SENT")',
  ].join('\n');

  const provider = createServer(async (req, res) => {
    let raw = '';
    try {
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const dump = JSON.stringify(body.messages);
      const lastUser = body.messages.findLast((m) => m.role === 'user');
      const content = lastUser?.content;
      const prompt = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      requests.push({ role: body.model, n: requests.length });
      let code = null;
      let text = null;
      if (body.model === 'parent') {
        lastParentAt = Date.now();
        if (prompt.includes(ROOT_FIRST) && !spawnedParent) {
          spawnedParent = true;
          code = SPAWN_CODE;
        } else if (dump.includes('[child-exited:')) {
          noticeDeliveries += 1;
          text = 'PARENT_RESUMED';
        } else if (childMode === 'progress' && !parentReplied && dump.includes(PROG)) {
          parentReplied = true;
          code = REPLY_CODE;
        } else if (childMode === 'progress' && parentReplied && dump.includes('CC_PARENT_REPLIED')) {
          parentFinal = true;
          text = 'Parent done.';
        } else if (childMode === 'final' && dump.includes(FINREPLY)) {
          parentFinal = true;
          text = 'Parent done.';
        } else if (!parentFinal) {
          parentWaits += 1;
          if (parentWaits > 30) throw new Error('parent never observed the child message');
          code = WAIT_CODE;
        } else {
          text = 'Parent done.';
        }
      } else {
        childReqs += 1;
        if (childMode === 'progress') {
          if (childReqs === 1) code = CHILD_PROGRESS_CODE;
          else if (childReqs === 2) code = CHILD_WORK_CODE;
          else {
            await until(() => releaseChild, BOUND_MS, 'child-gate');
            text = FINAL_TEXT;
          }
        } else {
          if (childReqs === 1) code = CHILD_FINAL_SEND_CODE;
          else {
            await until(() => releaseChild, BOUND_MS, 'child-gate');
            text = FINAL_TEXT;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sseFrame(res, requests, body, { role: 'assistant' });
      if (code) {
        sseFrame(res, requests, body, {
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: 'function',
              function: { name: 'ipython', arguments: JSON.stringify({ code }) },
            },
          ],
        });
        sseFrame(res, requests, body, {}, 'tool_calls');
      } else {
        sseFrame(res, requests, body, { content: text });
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
  const detail = { label, allowQuestions, childMode, root };
  const t0 = Date.now();
  try {
    await writeFile(
      join(agentHome, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            api: 'openai-completions',
            baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
            apiKey: 'fixture-only',
            models: ['parent', 'child'].map((id) => ({
              id,
              name: id,
              reasoning: true,
              input: ['text'],
              contextWindow: 131072,
              maxTokens: 4096,
            })),
          },
        },
      }),
    );
    await writeFile(join(agentHome, 'auth.json'), '{}');
    await writeFile(
      join(agentHome, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'fixture',
        defaultModel: 'parent',
        defaultThinkingLevel: 'medium',
        autoRefine: { enabled: false },
        compaction: { enabled: false },
        retry: { enabled: false },
        telemetry: { enabled: false, noticeShown: true },
      }),
    );
    const cli = discoverCli();
    detail.cli = cli?.packageDir || null;
    detail.cliVersion = cli?.version || null;
    runtime = createAgentRuntime({
      agentHome,
      sessionDir,
      env: { ...process.env, PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_KERNEL_PYTHON: MANAGED_PYTHON },
    });
    const handle = await bounded(
      runtime.start({
        cwd,
        message: ROOT_FIRST,
        model: 'fixture/parent',
        thinking: 'medium',
        allowQuestions,
        onEvent: (e) => events.push(e),
      }),
      `Startup (${label})`,
    );
    detail.started = true;
    await until(() => childReqs >= 1, BOUND_MS, `${label}: child admitted`);
    detail.childAdmitted = true;
    const sessionId = await until(() => handle.sessionId, BOUND_MS, `${label}: session id`);
    detail.sessionId = sessionId;
    if (childMode === 'progress') {
      await until(() => parentReplied, BOUND_MS, `${label}: parent replied to progress`);
      detail.parentReplied = true;
    }
    await until(() => parentFinal, BOUND_MS, `${label}: parent final served`);
    await until(
      () =>
        events.some(
          (e) => e.kind === 'message' && e.message?.role === 'assistant' && e.message.text === 'Parent done.',
        ),
      BOUND_MS,
      `${label}: parent final event`,
    );
    detail.parentFinalEvent = true;
    // Barrier-idle proxy: no new parent model request for IDLE_MS after the
    // parent went quiet with the child still held.
    await until(() => parentFinal && Date.now() - lastParentAt > IDLE_MS, BOUND_MS, `${label}: barrier idle`);
    detail.barrierIdle = true;
    const early = await Promise.race([
      handle.done.then(() => true),
      sleep(STILL_OPEN_PROBE_MS).then(() => false),
    ]);
    detail.closedWhileChildHeld = early;
    assert.equal(
      early,
      false,
      `${label}: root closed while child held. Events: ${JSON.stringify(events.slice(-5))}`,
    );
    // Native rlm_child_update events reach the Studio stream: a root that
    // waits on a held child reports children, never a bare turn end.
    const lastStatus = () => events.findLast((e) => e.kind === 'status')?.status;
    detail.statusWhileChildHeld = lastStatus();
    assert.equal(detail.statusWhileChildHeld, 'children', `${label}: status while the child is held`);
    releaseChild = true;
    detail.childReleased = true;
    const done = await bounded(handle.done, `${label}: completion after child release`);
    detail.done = done;
    assert.equal(done.status, 'completed', `${label}: expected completed, got ${JSON.stringify(done)}`);
    detail.statusAfterRelease = lastStatus();
    assert.equal(detail.statusAfterRelease, 'turn_end', `${label}: status once the child settled`);

    const saved = await histories(sessionDir, agentHome);
    const parent = saved.find((h) => h.id === sessionId);
    assert.ok(parent, `${label}: parent history missing`);
    const childMarker = childMode === 'progress' ? 'CC_CHILD_PROGRESS_SENT' : 'CC_CHILD_FINAL_SENT';
    const child = saved.find((h) => h.id !== sessionId && JSON.stringify(h.entries).includes(childMarker));
    assert.ok(child, `${label}: child history missing`);
    const agentMsg = (history, token) =>
      history.entries
        .map(msgOf)
        .filter((message) => message?.customType === 'agent_message' && message.details?.message === token);
    const notices = parent.entries
      .map((e) => msgOf(e))
      .filter((m) => m?.customType === 'rlm_child_terminal_notice' && m.details?.sessionName === childName);
    detail.parentMsgCount = parent.entries.length;
    detail.noticeCount = notices.length;
    detail.noticeDeliveries = noticeDeliveries;
    detail.roles = [...new Set(requests.map((r) => r.role))];
    detail.requestCount = requests.length;

    if (childMode === 'progress') {
      // Regression proof: early PROGRESS reply must not suppress the notice.
      assert.ok(agentMsg(parent, PROG).length >= 1, `${label}: parent must keep the explicit PROGRESS reply`);
      assert.ok(agentMsg(child, WAIT).length >= 1, `${label}: child must receive WAITING_FOR_FINAL`);
      assert.equal(notices.length, 1, `${label}: expected ONE terminal notice, got ${notices.length}`);
      const notice = notices[0];
      assert.equal(
        notice.details?.kind,
        'completed',
        `${label}: notice kind must be completed, got ${JSON.stringify(notice.details)}`,
      );
      assert.match(
        notice.content || '',
        new RegExp(`\\[child-exited: completed child:${childName}\\]`),
        `${label}: notice wording must be completed, got ${JSON.stringify((notice.content || '').slice(0, 200))}`,
      );
      assert.match(
        notice.content || '',
        new RegExp(FINAL_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${label}: notice must carry the child final text`,
      );
      assert.equal(
        noticeDeliveries,
        1,
        `${label}: notice must reach the parent model exactly once (no loop)`,
      );
      assert.ok(
        events.some(
          (e) =>
            e.kind === 'message' &&
            typeof e.message?.text === 'string' &&
            e.message.text.includes('PARENT_RESUMED'),
        ),
        `${label}: parent must send PARENT_RESUMED after the notice`,
      );
    } else {
      // No-loop proof: explicit final reply preserved, notice at most once.
      assert.ok(
        agentMsg(parent, FINREPLY).length >= 1,
        `${label}: parent must keep the explicit FINAL reply`,
      );
      assert.equal(notices.length, 1, `${label}: one completion notice, got ${notices.length}`);
      assert.equal(notices[0].details?.kind, 'completed');
      assert.equal(
        noticeDeliveries,
        1,
        `${label}: notice delivered to parent model once, got ${noticeDeliveries}`,
      );
    }
    detail.eventsTail = events
      .slice(-10)
      .map((e) => ({ kind: e.kind, role: e.message?.role, text: (e.message?.text || '').slice(0, 220) }));
    detail.ms = Date.now() - t0;
    return { passed: true, ...detail };
  } catch (error) {
    detail.ms = Date.now() - t0;
    detail.eventsTail = events
      .slice(-10)
      .map((e) => ({ kind: e.kind, role: e.message?.role, text: (e.message?.text || '').slice(0, 220) }));
    return { passed: false, error: String(error?.stack || error), ...detail };
  } finally {
    releaseChild = true;
    try {
      if (runtime) await bounded(runtime.close(), 'owned runtime cleanup', 30000);
    } finally {
      provider.closeAllConnections();
      await bounded(new Promise((done) => provider.close(done)), 'provider cleanup', 5000);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const results = {
  engine: discoverCli()?.packageDir || null,
  startedAt: new Date().toISOString(),
  scenarios: {},
};
for (const [key, allowQuestions, childMode] of [
  ['printProgress', false, 'progress'],
  ['rpcProgress', true, 'progress'],
  ['printFinalReply', false, 'final'],
  ['rpcFinalReply', true, 'final'],
]) {
  const label = key;
  try {
    results.scenarios[key] = await runCase({ allowQuestions, childMode, label });
  } catch (error) {
    results.scenarios[key] = { passed: false, error: String(error?.stack || error) };
  }
  console.log(
    JSON.stringify({
      scenario: key,
      passed: results.scenarios[key].passed,
      error: results.scenarios[key].error || null,
    }),
  );
}
results.finishedAt = new Date().toISOString();
results.passed = Object.values(results.scenarios).every((s) => s.passed === true);
await mkdir('test-results/child-completion', { recursive: true });
await writeFile('test-results/child-completion/native-proof.json', JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    {
      passed: results.passed,
      scenarios: Object.fromEntries(Object.entries(results.scenarios).map(([k, v]) => [k, v.passed])),
    },
    null,
    2,
  ),
);
if (!results.passed) process.exit(1);
