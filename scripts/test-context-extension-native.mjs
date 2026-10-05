// Real 0.9.8 resume through the Studio runtime: the context extension shortens kernel name lists in the request only.
// No real account, paid model, desktop action or user daemon is used.
import assert from 'node:assert/strict';
import { bounded } from './fixtures/timeout.mjs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentRuntime, discoverCli } from '../lib/agent.mjs';
import { createStore } from '../lib/store.mjs';

const cli = discoverCli();
assert.equal(JSON.parse(await readFile(join(cli.packageDir, 'package.json'), 'utf8')).version, '0.9.8');
const root = await mkdtemp(join(tmpdir(), 'prime-image-routing-native-'));
const cwd = join(root, 'project'),
  agentHome = join(root, 'agent'),
  sessionDir = join(root, 'sessions');
await Promise.all([cwd, agentHome, sessionDir].map((path) => mkdir(path, { recursive: true })));
const requests = [],
  report = { root, engine: cli.packageDir };
const provider = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-image-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    frame({ role: 'assistant', content: 'Fixture answer.' });
    frame({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.destroy(error);
  }
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
await writeFile(
  join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'fixture-only',
        models: ['plain', 'vision'].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: id === 'vision' ? ['text', 'image'] : ['text'],
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
    defaultModel: 'plain',
    imageModel: 'fixture/vision',
    defaultThinkingLevel: 'off',
    autoRefine: { enabled: false },
    compaction: { enabled: false },
    retry: { enabled: false },
    telemetry: { enabled: false, noticeShown: true },
  }),
);
const runtime = createAgentRuntime({
  agentHome,
  sessionDir,
  kernelRoot: root,
  env: { ...process.env, PRIME_AGENT_TELEMETRY: '0' },
});
const store = createStore({ sessionDir, dataDir: join(root, 'data') });
let failure;
const names = Array.from({ length: 60 }, (_, i) => `proof_var_${i}`).join(', ');
try {
  const first = await bounded(
    runtime.start({ cwd, message: 'FIRST_TURN_FIXTURE', model: 'fixture/plain', thinking: 'off' }),
    'start',
    60000,
  );
  assert.equal((await bounded(first.done, 'first completion')).status, 'completed');
  const history = await store.history(first.sessionId);
  const lines = (await readFile(history.file, 'utf8')).trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  const notice = `[python-state-restored]\n\nYour Python kernel state was revived from your previous session. These names are available again: ${names}.`;
  await writeFile(
    history.file,
    lines.join('\n') +
      '\n' +
      JSON.stringify({
        type: 'custom_message',
        customType: 'ipython_state_restored',
        content: notice,
        display: true,
        details: { restored: true },
        id: 'ctxproof1',
        parentId: last.id,
        timestamp: new Date().toISOString(),
      }) +
      '\n',
  );
  const resumed = await bounded(
    runtime.start({ cwd, sessionId: first.sessionId, message: 'RESUME_FIXTURE' }),
    'resume',
    60000,
  );
  assert.equal((await bounded(resumed.done, 'resumed completion')).status, 'completed');
  const sent = JSON.stringify(requests.at(-1).messages);
  report.requests = requests.length;
  report.shortened = sent.includes('60 names are available again; run dir() in the kernel to list them.');
  report.fullListSent = sent.includes('proof_var_59');
  const persisted = await readFile(history.file, 'utf8');
  report.persistedUnchanged = persisted.includes('proof_var_59');
  assert.ok(report.shortened, 'request must carry the shortened notice');
  assert.equal(report.fullListSent, false);
  assert.ok(report.persistedUnchanged, 'native session must keep the full list');
} catch (error) {
  failure = error;
  report.error = String(error.stack || error);
} finally {
  try {
    await bounded(runtime.close(), 'owned runtime cleanup', 30000);
    report.runtimeClosed = true;
  } catch (error) {
    failure ||= error;
    report.cleanupError = String(error);
  }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  report.providerClosed = true;
  if (report.runtimeClosed) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    report.tempRootRemoved = true;
  }
  report.passed = !failure;
  const evidence = resolve('test-results/context-hygiene/native-proof.json');
  await mkdir(join(evidence, '..'), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;
