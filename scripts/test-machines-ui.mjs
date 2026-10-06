// Real browser: machine list, QR codes (fake camera and photos), offline cache and cross-site switch.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { launchStudioPersistentContext } from './fixtures/browser.mjs';
import QRCode from 'qrcode';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

const dir = await mkdtemp(join(tmpdir(), 'prime-machines-ui-'));
const sessionDir = join(dir, 'sessions'),
  agentHome = join(dir, 'agent');
await Promise.all([mkdir(sessionDir), mkdir(agentHome)]);
const app = createApp({
  sessionDir,
  agentHome,
  dataDir: join(dir, 'data'),
  initialCwd: dir,
  runtime: {
    async getStatus() {
      return { available: true, version: 'fixture' };
    },
    async getModels() {
      return { models: [], default: {} };
    },
    async start() {
      throw new Error('This machine list test must not launch an agent.');
    },
    async close() {},
  },
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const code = '12345678',
  salt = 'b'.repeat(32);
const gateway = createLanGateway({
  host: '127.0.0.1',
  upstreamPort: app.server.address().port,
  config: { salt, codeHash: hashAccessCode(code, salt), readOnly: false },
});
await new Promise((done) => gateway.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${gateway.address().port}`,
  hereName = new URL(url).host;
// Another site links to this Studio, like the machine list of another PC.
const entry = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<a id="plain" href="${url}/">Lien direct</a> <a id="switch" href="${url}/?from-machines=1">Depuis la liste</a>`,
  );
});
await new Promise((done) => entry.listen(0, '127.0.0.1', done));
const entryUrl = `http://localhost:${entry.address().port}`;

// The fake camera shows a QR code of another site, then the one of another PC.
function y4m(texts, { width = 640, height = 480, fps = 10, seconds = 2.5 } = {}) {
  const chroma = Buffer.alloc((width * height) / 2, 128);
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  for (const text of texts) {
    const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
    const scale = Math.floor((Math.min(width, height) * 0.62) / (size + 8)),
      total = (size + 8) * scale,
      left = (width - total) >> 1,
      top = (height - total) >> 1,
      luma = Buffer.alloc(width * height, 72);
    for (let y = 0; y < total; y++)
      for (let x = 0; x < total; x++) {
        const column = Math.floor(x / scale) - 4,
          line = Math.floor(y / scale) - 4;
        const dark = column >= 0 && line >= 0 && column < size && line < size && data[line * size + column];
        luma[(top + y) * width + left + x] = dark ? 20 : 230;
      }
    for (let frame = 0; frame < fps * seconds; frame++) parts.push(Buffer.from('FRAME\n'), luma, chroma);
  }
  return Buffer.concat(parts);
}
const camera = join(dir, 'camera.y4m'),
  photo = join(dir, 'remote-access-qr.png'),
  foreign = join(dir, 'foreign-qr.png'),
  blank = join(dir, 'blank.png');
await writeFile(camera, y4m(['https://example.com/menu', 'https://pc-bureau.tail1234.ts.net']));
await QRCode.toFile(photo, 'http://100.91.42.10:3089', { width: 1600, margin: 4, errorCorrectionLevel: 'M' });
await QRCode.toFile(foreign, 'https://example.com/', { width: 256, margin: 4 });
await writeFile(
  blank,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  ),
);
const shots = resolve('test-results/machines');
await mkdir(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(shots, name + '.png') });

let context;
const checks = [],
  errors = [];
try {
  context = await launchStudioPersistentContext(join(dir, 'browser-profile'), {
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'msedge',
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'fr-FR',
    permissions: ['camera'],
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${camera}`,
    ],
  });
  const page = context.pages()[0] || (await context.newPage());
  const watch = (target) => target.on('pageerror', (error) => errors.push(error.message));
  watch(page);
  const rows = page.locator('.machine');
  const add = page.getByRole('button', { name: 'Ajouter', exact: true });

  await page.goto(url + '/public/machines.html');
  await expect(page.locator('#code')).toBeVisible();
  assert.equal(new URL(page.url()).pathname, '/');
  await expect(page.locator('a.pwa-machines')).toHaveText('Autres machines');
  await shot(page, 'login');
  checks.push('A launch with no other machine opens this Studio directly; sign-in links to the list.');

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Ouvrir le studio' }).click();
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#open-machines')).toBeVisible();
  await page.waitForTimeout(500); // Let the drawer finish sliding in before the screenshot.
  await shot(page, 'sidebar');
  await page.locator('#open-machines').click();
  await expect(page).toHaveURL(url + '/public/machines.html#list');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.machine-badge')).toHaveText('Cette adresse');
  await expect(rows.first().locator('.machine-name')).toHaveText(hereName);
  await expect(page.locator('#machine-empty')).toBeVisible();
  await shot(page, 'list-empty');
  checks.push('The Studio sidebar opens the list; this address is always listed first.');

  await page.getByRole('button', { name: 'Saisir une adresse' }).click();
  await expect(page.locator('#machine-address')).toBeFocused();
  await page.locator('#machine-address').fill('8.8.8.8');
  await add.click();
  await expect(page.locator('#machine-error')).toContainText('Adresse non prise en charge');
  await expect(page.locator('#machine-address')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#machine-address').fill('192.168.1.42');
  await expect(page.locator('#machine-error')).toBeHidden();
  await expect(page.locator('#machine-name')).toHaveAttribute('placeholder', '192.168.1.42');
  await page.locator('#machine-name').fill('Atelier');
  await shot(page, 'form-manual');
  await add.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('.machine-name')).toHaveText('Atelier');
  await expect(rows.nth(1).locator('.machine-address')).toHaveText('192.168.1.42:3089');
  await expect(rows.nth(1).locator('.machine-kind')).toHaveText('Réseau local');
  await expect(page.locator('#machine-status')).toHaveText('Atelier a été ajouté.');
  await expect(page.locator('#machine-form')).toBeHidden();
  await expect(page.locator('#machine-empty')).toBeHidden();
  await page.getByRole('button', { name: 'Saisir une adresse' }).click();
  await page.locator('#machine-address').fill('http://192.168.1.42:3089/');
  await add.click();
  await expect(page.locator('#machine-error')).toHaveText('Cette machine est déjà dans la liste.');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.locator('#machine-form')).toBeHidden();
  checks.push('Typed addresses are validated, normalized (port 3089) and deduplicated.');

  await page.getByRole('button', { name: 'Scanner un QR code' }).click();
  const scanner = page.locator('#machine-scanner');
  await expect(scanner).toBeVisible();
  await expect(page.locator('#machine-scan-status')).toHaveText(
    'Ce QR code ne contient pas d’adresse de Studio.',
    { timeout: 15000 },
  );
  await shot(page, 'scanner');
  await expect(scanner).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#machine-address')).toHaveValue('https://pc-bureau.tail1234.ts.net');
  await expect(page.locator('#machine-form-note')).toHaveText(
    'QR code lu. Vérifiez, puis ajoutez la machine.',
  );
  await expect(page.locator('#machine-name')).toHaveAttribute('placeholder', 'pc-bureau');
  await expect(page.locator('#machine-name')).toBeFocused();
  assert.equal(await page.evaluate(() => document.getElementById('machine-video').srcObject), null);
  await shot(page, 'scan-result');
  await add.click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).locator('.machine-name')).toHaveText('pc-bureau');
  await expect(rows.nth(2).locator('.machine-kind')).toHaveText('Tailscale HTTPS');
  checks.push('The live camera ignores a foreign QR code, reads the PC QR code, stops and fills the form.');

  await page.locator('#machine-photo').setInputFiles(photo);
  await expect(page.locator('#machine-address')).toHaveValue('http://100.91.42.10:3089');
  await page.locator('#machine-name').fill('Maison');
  await add.click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(3).locator('.machine-kind')).toHaveText('Tailscale');
  await page.locator('#machine-photo').setInputFiles(foreign);
  await expect(page.locator('#machine-message')).toHaveText(
    'Ce QR code ne contient pas d’adresse de Studio.',
  );
  await page.locator('#machine-photo').setInputFiles(blank);
  await expect(page.locator('#machine-message')).toHaveText('Aucun QR code lisible sur cette photo.');
  checks.push('A photo of the QR code adds a machine; foreign or missing QR codes are explained.');

  await page.getByRole('button', { name: 'Modifier Atelier' }).click();
  await expect(page.locator('#machine-address')).toHaveValue('http://192.168.1.42:3089');
  await expect(page.locator('#machine-form-title')).toHaveText('Modifier la machine');
  await page.locator('#machine-address').fill('192.168.1.43');
  await page.locator('#machine-name').fill('Atelier photo');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(rows.nth(1).locator('.machine-name')).toHaveText('Atelier photo');
  await expect(rows.nth(1).locator('.machine-address')).toHaveText('192.168.1.43:3089');
  await expect(rows.nth(1).locator('.machine-open')).toBeFocused();
  await page.getByRole('button', { name: `Modifier ${hereName}` }).click();
  await expect(page.locator('#machine-address')).toBeDisabled();
  await page.locator('#machine-name').fill('Ce PC');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(rows.first().locator('.machine-name')).toHaveText('Ce PC');
  checks.push('Machines and this address can be renamed; another machine address can be changed.');

  const remove = page.locator('#machine-remove');
  await page.getByRole('button', { name: 'Modifier pc-bureau' }).click();
  await remove.click();
  await expect(remove).toHaveText('Touchez à nouveau pour retirer');
  await page.waitForTimeout(4300);
  await expect(remove).toHaveText('Retirer de la liste');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Modifier Maison' }).click();
  await remove.click();
  await shot(page, 'remove-armed');
  await remove.click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#machine-form')).toBeHidden();
  await expect(page.locator('#machine-status')).toHaveText('Maison a été retiré de la liste.');
  await page.getByRole('button', { name: 'Modifier Ce PC' }).click();
  await expect(remove).toBeHidden();
  await page.getByRole('button', { name: 'Annuler' }).click();
  checks.push(
    'Removal is in the edit form, needs a second tap within four seconds and never targets this address.',
  );
  await shot(page, 'list');

  await page.goto(url + '/public/machines.html');
  await expect(rows).toHaveCount(3);
  assert.equal(new URL(page.url()).pathname, '/public/machines.html');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('prime-studio.machines'))), [
    { origin: 'http://192.168.1.43:3089', name: 'Atelier photo' },
    { origin: 'https://pc-bureau.tail1234.ts.net', name: '' },
    { origin: url, name: 'Ce PC' },
  ]);
  checks.push('With another machine saved, a launch shows the list; the device storage stays minimal.');

  let opened = '';
  await page.route('http://192.168.1.43:3089/**', (route) => {
    opened = route.request().url();
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Atelier</title>',
    });
  });
  await rows.nth(1).locator('.machine-open').click();
  await page.waitForURL('http://192.168.1.43:3089/?from-machines=1');
  assert.equal(opened, 'http://192.168.1.43:3089/?from-machines=1');
  await page.goBack();
  await expect(rows).toHaveCount(3);
  await rows.first().locator('.machine-open').click();
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  assert.equal(new URL(page.url()).pathname, '/');
  checks.push('A machine opens its own address with the switch marker; this address opens this Studio.');

  await page.goto(entryUrl);
  await page.locator('#plain').click();
  await expect(page.locator('#code')).toBeVisible();
  await page.goto(entryUrl);
  await page.locator('#switch').click();
  await expect(page.locator('#connection-label')).toHaveText('Moteur connecté');
  await expect(page).toHaveURL(url + '/');
  checks.push(
    'From another site, the strict session cookie is withheld; the switch marker retries once and keeps the session.',
  );

  await context.setOffline(true);
  await page.goto(url + '/public/machines.html');
  await expect(rows).toHaveCount(3);
  await page.locator('#machine-photo').setInputFiles(photo);
  await expect(page.locator('#machine-address')).toHaveValue('http://100.91.42.10:3089');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await page.goto(url + '/');
  await expect(page.locator('h1')).toHaveText('Retrouvons votre Studio.');
  await shot(page, 'offline');
  await page.getByRole('link', { name: 'Ouvrir une autre machine' }).click();
  await expect(rows).toHaveCount(3);
  await context.setOffline(false);
  checks.push(
    'Offline, the list and the QR reader still open from the cache; the reconnection page links to it.',
  );

  await page.evaluate(() => localStorage.setItem('prime-studio.language', 'en'));
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Machines');
  await expect(page.getByRole('button', { name: 'Scan a QR code' })).toBeVisible();
  await expect(rows.first().locator('.machine-badge')).toHaveText('This address');
  await expect(rows.nth(1).locator('.machine-kind')).toHaveText('Local network');
  await shot(page, 'list-en');
  await page.evaluate(() => localStorage.setItem('prime-studio.language', 'fr'));
  checks.push('The list follows the Studio language.');

  const insecure = await context.newPage();
  watch(insecure);
  await insecure.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'mediaDevices', { get: () => undefined }),
  );
  await insecure.goto(url + '/public/machines.html#list');
  const [chooser] = await Promise.all([
    insecure.waitForEvent('filechooser'),
    insecure.getByRole('button', { name: 'Scanner un QR code' }).click(),
  ]);
  await chooser.setFiles(photo);
  await expect(insecure.locator('#machine-address')).toHaveValue('http://100.91.42.10:3089');
  await insecure.close();
  const denied = await context.newPage();
  watch(denied);
  await denied.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  });
  await denied.goto(url + '/public/machines.html#list');
  await denied.getByRole('button', { name: 'Scanner un QR code' }).click();
  await expect(denied.locator('#machine-scan-status')).toContainText('Accès à la caméra refusé');
  const [retry] = await Promise.all([
    denied.waitForEvent('filechooser'),
    denied.getByRole('button', { name: 'Prendre une photo' }).click(),
  ]);
  await retry.setFiles(photo);
  await expect(denied.locator('#machine-address')).toHaveValue('http://100.91.42.10:3089');
  await denied.close();
  checks.push('Without a live camera (HTTP address or refusal), the scan opens the photo picker.');

  const desktop = await context.newPage();
  watch(desktop);
  await desktop.addInitScript(() =>
    Object.defineProperty(window, '__PRIME_STUDIO_DESKTOP__', { value: true }),
  );
  await desktop.goto(url + '/');
  await expect(desktop.locator('#connection-label')).toHaveText('Moteur connecté');
  await expect(desktop.locator('#open-machines')).toBeHidden();
  await desktop.close();
  checks.push('The desktop window keeps its single local Studio without the machine entry.');

  assert.deepEqual(errors, []);
  await writeFile(join(shots, 'machines-ui.json'), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await context?.close();
  entry.closeAllConnections();
  await new Promise((done) => entry.close(done));
  gateway.closeAllConnections();
  await new Promise((done) => gateway.close(done));
  await app.close();
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  await rm(dir, { recursive: true, force: true });
}
