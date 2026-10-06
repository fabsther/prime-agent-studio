import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineIdentity } from '../lib/fleet-identity.mjs';
import { createFleetDevices } from '../lib/fleet-devices.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fleet-gateway-'));
  const devices = createFleetDevices({ dataDir, identity: () => machineIdentity({ dataDir }) });
  const upstream = createServer((req, res) => {
    req.resume();
    if (req.url === '/api/runs/abc/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ready\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/bootstrap'
          ? { preferences: { readOnly: true } }
          : { path: req.url, method: req.method, authorization: req.headers.authorization ?? null },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = {
    readOnly: true,
    salt: 'a'.repeat(32),
    codeHash: hashAccessCode('12345678', 'a'.repeat(32)),
  };
  const gateway = createLanGateway({
    host: '127.0.0.1',
    upstreamPort: upstream.address().port,
    config,
    fleetDevices: devices,
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const port = gateway.address().port;
  t.after(async () => {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const api = (path, options) => http(port, path, options);
  const pair = (pin = '12345678', extra = {}) =>
    api('/api/fleet/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ pin, deviceName: 'Phone' }),
    });
  return { devices, gateway, config, api, pair, port };
}

test('pairing grants full PIN rights but never desktop-only routes or forwards credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/fleet/identity')).status, 401);
  const paired = await f.pair();
  assert.equal(paired.status, 200, paired.text);
  assert.match(paired.json.machineId, /^[a-f0-9-]{36}$/);
  const headers = { Authorization: `Bearer ${paired.json.token}`, 'Content-Type': 'application/json' };
  for (const path of ['/api/fleet/identity', '/api/fleet/summary']) {
    const result = await f.api(path, { headers });
    assert.equal(result.status, 200);
    assert.equal(result.json.authorization, null);
  }
  for (const path of ['/api/runs', '/api/fleet/delegate', '/api/roadmap/external-link'])
    assert.equal((await f.api(path, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(
    (await f.api('/api/roadmap/external-link', { method: 'DELETE', headers, body: '{}' })).status,
    200,
  );
  assert.equal((await f.api('/api/bootstrap', { headers })).json.preferences.readOnly, false);
  assert.equal((await f.api('/api/bootstrap', { headers })).json.preferences.remote, true);
  for (const path of [
    '/api/fleet/devices',
    '/api/providers',
    '/api/remote-access',
    '/api/health',
    '/api/pick-directory',
  ])
    assert.equal((await f.api(path, { headers })).status, 404, path);
  assert.equal(
    (await f.api(`/api/fleet/devices/${paired.json.deviceId}`, { method: 'DELETE', headers, body: '{}' }))
      .status,
    404,
  );
  await f.devices.revoke(paired.json.deviceId);
  assert.equal((await f.api('/api/fleet/summary', { headers })).status, 401);
});

test('PIN and pairing share a rate limit; invalid PIN cannot register a device', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.pair('00000000')).status, 401);
  const denied = await f.pair();
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers['retry-after']) > 0);
  assert.deepEqual(await f.devices.list(), []);
  const login = await f.api('/lan/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'code=12345678',
  });
  assert.equal(login.status, 429);
});

test('pairing validates JSON, origin and device name, and login cookies keep consultation rights', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.pair('12345678', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal(
    (
      await f.api('/api/fleet/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api('/api/fleet/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await f.api('/api/fleet/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '12345678', deviceName: ' ' }),
      })
    ).status,
    400,
  );
  const login = await f.api('/lan/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'code=12345678',
  });
  assert.equal(login.status, 303);
  const headers = {
    Cookie: login.headers['set-cookie'][0].split(';')[0],
    'Content-Type': 'application/json',
  };
  assert.equal((await f.api('/api/fleet/summary', { headers })).status, 200);
  assert.equal((await f.api('/api/runs', { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await f.api('/api/bootstrap', { headers })).json.preferences.readOnly, true);
  assert.equal(
    (await f.api('/api/fleet/summary', { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
});

test('revoke disconnects an open bearer event stream immediately', async (t) => {
  const f = await fixture(t),
    paired = (await f.pair()).json;
  let response, close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: f.port,
        path: '/api/runs/abc/events',
        headers: { Authorization: `Bearer ${paired.token}` },
      },
      (res) => {
        response = res;
        res.on('error', () => {});
        res.once('close', close);
        res.once('data', resolve);
      },
    );
    req.on('error', reject);
    req.end();
  });
  const timer = setTimeout(() => {
    response.destroy();
    assert.fail('Revoked bearer stream did not close');
  }, 2000);
  t.after(() => clearTimeout(timer));
  await f.devices.revoke(paired.deviceId);
  await closed;
  clearTimeout(timer);
});

test('PIN rotation during pairing cannot issue a token authorized by the old PIN', async (t) => {
  const f = await fixture(t),
    original = f.devices.pair;
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  f.devices.pair = async (name) => {
    entered();
    await paused;
    return original(name);
  };
  const result = f.pair();
  await started;
  f.gateway.setAccessCode({ salt: 'b'.repeat(32), codeHash: hashAccessCode('87654321', 'b'.repeat(32)) });
  release();
  assert.equal((await result).status, 401);
  assert.deepEqual(await f.devices.list(), []);
});
