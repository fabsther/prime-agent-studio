import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import {
  MAX_MACHINES,
  STORAGE_KEY,
  cleanMachineName,
  defaultMachineName,
  hasOtherMachines,
  loadMachines,
  machineKind,
  machineUrl,
  parseMachineAddress,
  saveMachines,
} from '../public/machine-list.js';

const jsQR = createRequire(import.meta.url)('jsqr');
const memory = (initial) => {
  const values = new Map(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
};

test('machine addresses accept only what a Studio gateway can serve', () => {
  const accepted = {
    'pc-bureau.tail1234.ts.net': ['https://pc-bureau.tail1234.ts.net', 'https'],
    'https://PC-Bureau.Tail1234.TS.NET/': ['https://pc-bureau.tail1234.ts.net', 'https'],
    'https://pc.tail1234.ts.net:443/?x=1#y': ['https://pc.tail1234.ts.net', 'https'],
    '192.168.1.42': ['http://192.168.1.42:3089', 'lan'],
    ' 192.168.1.42:4000 ': ['http://192.168.1.42:4000', 'lan'],
    'http://10.0.0.5:3089/': ['http://10.0.0.5:3089', 'lan'],
    '172.16.4.4': ['http://172.16.4.4:3089', 'lan'],
    '100.91.42.10': ['http://100.91.42.10:3089', 'tailscale'],
    'http://100.127.255.254:3095': ['http://100.127.255.254:3095', 'tailscale'],
  };
  for (const [input, [origin, kind]] of Object.entries(accepted))
    assert.deepEqual(parseMachineAddress(input), { origin, kind }, input);
  for (const input of [
    '',
    '   ',
    null,
    42,
    'https://pc.tail1234.ts.net:8443',
    'http://pc.tail1234.ts.net',
    'https://tail1234.ts.net',
    'https://a.b.tail1234.ts.net',
    'https://pc.tail1234.ts.net.evil.com',
    'https://user@pc.tail1234.ts.net',
    'http://user:secret@192.168.1.42:3089',
    'https://192.168.1.42',
    'http://192.168.1.42:1023',
    'http://127.0.0.1:3088',
    'localhost:3089',
    'http://8.8.8.8:3089',
    'http://172.32.0.1:3089',
    'http://100.128.0.1:3089',
    'http://010.0.0.1:3089',
    'http://[fd7a:115c:a1e0::1]:3089',
    'ftp://192.168.1.42',
    'javascript:alert(1)',
    'x'.repeat(600),
  ])
    assert.equal(parseMachineAddress(input), null, String(input));
  assert.equal(machineKind('http://192.168.1.42:3089'), 'lan');
  assert.equal(machineKind('http://127.0.0.1:3088'), null);
});

test('machine names are cleaned and default to the Tailscale name or the IP', () => {
  assert.equal(defaultMachineName('https://pc-bureau.tail1234.ts.net'), 'pc-bureau');
  assert.equal(defaultMachineName('http://192.168.1.42:3089'), '192.168.1.42');
  assert.equal(defaultMachineName('http://127.0.0.1:3088'), '127.0.0.1:3088');
  assert.equal(cleanMachineName('  PC\n du   bureau  '), 'PC du bureau');
  assert.equal(cleanMachineName('abc\u202edef\u2066'), 'abc def');
  assert.equal(cleanMachineName(['not text']), '');
  assert.equal(Array.from(cleanMachineName('😀'.repeat(80))).length, 60);
});

test('saved machines are canonical, unique, bounded and keep the current address name', () => {
  const current = 'http://127.0.0.1:3088';
  const storage = memory();
  saveMachines(storage, [
    { origin: 'https://pc-bureau.tail1234.ts.net', name: 'Bureau', extra: 'dropped' },
    { origin: current, name: 'Ce PC' },
  ]);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY))[0], {
    origin: 'https://pc-bureau.tail1234.ts.net',
    name: 'Bureau',
  });
  assert.deepEqual(loadMachines(storage), [{ origin: 'https://pc-bureau.tail1234.ts.net', name: 'Bureau' }]);
  assert.equal(loadMachines(storage, current).length, 2);
  const tampered = memory(
    JSON.stringify([
      { origin: 'http://192.168.1.42:3089', name: 'Atelier' },
      { origin: 'http://192.168.1.42:3089', name: 'Doublon' },
      { origin: 'https://evil.example', name: 'Piège' },
      { origin: 'http://192.168.1.42:3089/', name: 'Non canonique' },
      { origin: '', name: 'Vide' },
      { name: 'Sans adresse' },
      'texte',
      null,
    ]),
  );
  assert.deepEqual(loadMachines(tampered, ''), [{ origin: 'http://192.168.1.42:3089', name: 'Atelier' }]);
  for (const broken of ['{', '"text"', '{"origin":"http://192.168.1.42:3089"}', 'null'])
    assert.deepEqual(loadMachines(memory(broken)), []);
  assert.deepEqual(loadMachines(null), []);
  assert.deepEqual(
    loadMachines({
      getItem() {
        throw new Error('blocked');
      },
    }),
    [],
  );
  const many = Array.from({ length: 40 }, (_, index) => ({
    origin: `http://192.168.1.${index + 1}:3089`,
    name: '',
  }));
  assert.equal(loadMachines(memory(JSON.stringify(many))).length, MAX_MACHINES);
  saveMachines(storage, many);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).length, MAX_MACHINES);
});

test('opening a machine keeps this Studio local and marks a switch to another address', () => {
  const here = 'https://pc-bureau.tail1234.ts.net';
  assert.equal(machineUrl(here, here), '/');
  assert.equal(machineUrl('http://192.168.1.42:3089', here), 'http://192.168.1.42:3089/?from-machines=1');
  assert.equal(hasOtherMachines([{ origin: here, name: 'Ici' }], here), false);
  assert.equal(hasOtherMachines([{ origin: 'http://192.168.1.42:3089', name: '' }], here), true);
});

test('remote access QR codes decode to the address that the list adds', () => {
  // Same encoder and options as the Remote access panel (lib/remote-network.mjs).
  for (const url of [
    'https://pc-bureau.tail1234.ts.net',
    'http://192.168.1.42:3089',
    'http://100.91.42.10:3089',
  ]) {
    const { size, data } = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    const scale = 5,
      width = (size + 8) * scale,
      pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < size * scale; y++)
      for (let x = 0; x < size * scale; x++)
        if (data[Math.floor(y / scale) * size + Math.floor(x / scale)]) {
          const offset = ((y + 4 * scale) * width + x + 4 * scale) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
    const decoded = jsQR(pixels, width, width, { inversionAttempts: 'dontInvert' });
    assert.equal(decoded?.data, url);
    assert.equal(parseMachineAddress(decoded.data).origin, url);
  }
});
