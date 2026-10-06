import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-routes-'));
  const cwd = join(root, 'project'),
    sessionDir = join(root, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(sessionDir)]);
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    JSON.stringify({ type: 'session', id: 'session-test', cwd, timestamp: '2026-01-01T00:00:00Z' }) + '\n',
  );
  const app = createApp({
    dataDir: join(root, 'data'),
    sessionDir,
    agentHome: join(root, 'agent'),
    initialCwd: cwd,
    runtime: { getStatus: async () => ({ available: false }), close: async () => {} },
    readInspectorEdges: async () => [],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: app.server.address().port,
    config: { salt: 'a'.repeat(32), codeHash: hashAccessCode('12345678', 'a'.repeat(32)), readOnly: false },
    fleetDevices: app.fleetDevices,
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    app,
    cwd,
    local: `http://127.0.0.1:${app.server.address().port}`,
    remote: `http://127.0.0.1:${gateway.address().port}`,
  };
}

test('fleet routes expose identity and bounded summary; devices remain local and revoke bearer access', async (t) => {
  const f = await fixture(t);
  const identity = await (await fetch(f.local + '/api/fleet/identity')).json();
  assert.equal(identity.studioVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(identity.machineId, (await f.app.identity()).machineId);
  const body = JSON.stringify({ pin: '12345678', deviceName: 'Phone' });
  assert.equal(
    (
      await fetch(f.local + '/api/fleet/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    ).status,
    404,
  );
  const paired = await (
    await fetch(f.remote + '/api/fleet/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
  ).json();
  const headers = { Authorization: `Bearer ${paired.token}` };
  const summaryResponse = await fetch(f.remote + '/api/fleet/summary', { headers });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.machine.machineId, identity.machineId);
  assert.equal(summary.projects[0].cwd, f.cwd);
  assert.equal(summary.projects[0].git, null);
  assert.equal(summary.projects[0].sessions[0].id, 'session-test');
  const devices = await (await fetch(f.local + '/api/fleet/devices')).json();
  assert.equal(devices[0].deviceId, paired.deviceId);
  assert.equal((await fetch(f.remote + '/api/fleet/devices', { headers })).status, 404);
  assert.equal(
    (await fetch(f.local + `/api/fleet/devices/${paired.deviceId}`, { method: 'DELETE' })).status,
    200,
  );
  assert.equal((await fetch(f.remote + '/api/fleet/summary', { headers })).status, 401);
});
