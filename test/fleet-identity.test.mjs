import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineIdentity } from '../lib/fleet-identity.mjs';
import { createFleetDevices } from '../lib/fleet-devices.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-fleet-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const identity = () => machineIdentity({ dataDir });
  return { dataDir, identity, devices: createFleetDevices({ dataDir, identity }) };
}

test('machine UUID is stable across concurrent calls and supports a persisted label', async (t) => {
  const { dataDir, identity } = await fixture(t);
  const results = await Promise.all([identity(), identity(), identity()]);
  assert.match(results[0].machineId, /^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
  assert.equal(new Set(results.map((r) => r.machineId)).size, 1);
  assert.deepEqual(results[0].capabilities, ['summary', 'download-range', 'roadmap-delegation']);
  const renamed = await machineIdentity({ dataDir, machineName: 'Office PC' });
  assert.equal(renamed.machineId, results[0].machineId);
  assert.equal((await identity()).machineName, 'Office PC');
  assert.equal(renamed.apiVersion, 1);
  await assert.rejects(machineIdentity({ dataDir, machineName: ' ' }));
});

test('corrupted identity is not silently replaced', async (t) => {
  const { dataDir, identity } = await fixture(t);
  await writeFile(join(dataDir, 'fleet-identity.json'), '{broken');
  await assert.rejects(identity());
  assert.equal(await readFile(join(dataDir, 'fleet-identity.json'), 'utf8'), '{broken');
});

test('paired tokens are hashed, persist across restarts, and can be revoked', async (t) => {
  const { dataDir, identity, devices } = await fixture(t);
  const paired = await devices.pair('Android phone');
  assert.equal(Buffer.from(paired.token, 'base64url').length, 32);
  assert.equal(await devices.authenticate(paired.token), paired.deviceId);
  assert.equal(await devices.authenticate('a'.repeat(43)), null);
  assert.equal(await devices.authenticate(paired.token + 'a'), null);
  const raw = await readFile(join(dataDir, 'fleet-devices.json'), 'utf8');
  assert.ok(!raw.includes(paired.token));
  assert.match(JSON.parse(raw).devices[0].tokenHash, /^[a-f0-9]{64}$/);
  const restarted = createFleetDevices({ dataDir, identity });
  assert.equal(await restarted.authenticate(paired.token), paired.deviceId);
  const list = await devices.list();
  assert.equal(list[0].deviceName, 'Android phone');
  assert.ok(list[0].lastUsedAt);
  assert.ok(!('tokenHash' in list[0]));
  let revoked;
  const unsubscribe = devices.onRevoked((id) => {
    revoked = id;
  });
  assert.deepEqual(await devices.revoke(paired.deviceId), { revoked: true });
  assert.equal(revoked, paired.deviceId);
  unsubscribe();
  assert.equal(await restarted.authenticate(paired.token), null);
  assert.deepEqual(await devices.list(), []);
  await assert.rejects(devices.pair(' '));
});

test('corrupt device storage fails closed instead of losing paired devices', async (t) => {
  const { dataDir, devices } = await fixture(t);
  await writeFile(join(dataDir, 'fleet-devices.json'), '{broken');
  await assert.rejects(devices.authenticate('a'.repeat(43)));
  await assert.rejects(devices.pair('Phone'));
  assert.equal(await readFile(join(dataDir, 'fleet-devices.json'), 'utf8'), '{broken');
});
