// Focused R2 conversation sync UI proof with mocked sync API.
// Real HTTP shell with isolated profile; /api/sync* mocked in page,
// project POST/PATCH sync bodies captured and overview patched in flight.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'studio-sync-settings-'));
const cwd = join(temp, 'Projet de demonstration');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all([cwd, agentHome, sessionDir, dataDir].map((path) => mkdir(path, { recursive: true })));

const app = createApp({
  initialCwd: cwd,
  agentHome,
  sessionDir,
  dataDir,
  runtime: {
    getStatus: async () => ({ available: true, version: 'fixture' }),
    getModels: async () => ({ models: [], default: {} }),
    start: async () => {
      throw new Error('Isolated sync fixture cannot start agents');
    },
    close: async () => {},
  },
  openDirectory: async () => {},
});
await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${app.server.address().port}`;

// In-memory mocked sync backend (local only routes).
const syncState = {
  configured: false,
  url: null,
  accessKeyId: null,
  hasSecret: false,
  hasPassphrase: false,
  device: '',
  running: false,
  lastSync: null,
};
let putBodies = [];
let runCalls = 0;
let deleteCalls = 0;
let failNextPut = null;
let pollCount = 0;
const projectPosts = [];
const projectPatches = [];
// Overview sync overlay: project cwd -> sync boolean.
const syncOverlay = new Map();

let browser;
const deadline = setTimeout(() => {
  void browser?.close();
  void app.close();
}, 120000);
try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chromium',
  });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const shape = () => ({ ...syncState });

  await page.route('**/api/sync/run', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    runCalls++;
    syncState.running = true;
    pollCount = 0;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(shape()) });
  });
  await page.route('**/api/sync', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      if (syncState.running) {
        pollCount++;
        if (pollCount >= 2) {
          syncState.running = false;
          syncState.lastSync = {
            at: new Date().toISOString(),
            ok: true,
            sent: 2048,
            received: 3,
            pushed: 2,
          };
        }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(shape()) });
      return;
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      putBodies.push(body);
      if (failNextPut) {
        const message = failNextPut;
        failNextPut = null;
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: message }),
        });
        return;
      }
      syncState.configured = true;
      syncState.url = body.url;
      syncState.accessKeyId = body.accessKeyId;
      if (body.secretAccessKey) syncState.hasSecret = true;
      if (body.passphrase) syncState.hasPassphrase = true;
      syncState.device = body.device || '';
      syncState.running = false;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(shape()) });
      return;
    }
    if (method === 'DELETE') {
      deleteCalls++;
      syncState.configured = false;
      syncState.url = null;
      syncState.accessKeyId = null;
      syncState.hasSecret = false;
      syncState.hasPassphrase = false;
      syncState.device = '';
      syncState.running = false;
      syncState.lastSync = null;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(shape()) });
      return;
    }
    return route.continue();
  });
  // Capture project writes; patch overview reads so the menu label follows.
  await page.route('**/api/projects', async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') {
      const body = route.request().postDataJSON();
      if (method === 'POST') projectPosts.push(body);
      else projectPatches.push(body);
      if (typeof body?.sync === 'boolean' && body.cwd) syncOverlay.set(body.cwd, body.sync);
      const response = await route.fetch();
      const data = await response.json().catch(() => null);
      if (data && typeof data === 'object' && body && typeof body.sync === 'boolean') data.sync = body.sync;
      await route.fulfill({ response, json: data });
      return;
    }
    return route.continue();
  });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (Array.isArray(data?.projects))
      for (const project of data.projects)
        if (syncOverlay.has(project.cwd)) project.sync = syncOverlay.get(project.cwd);
    await route.fulfill({ response, json: data });
  });

  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });

  // Sync tab is visible locally.
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-tab-sync')).toBeVisible();
  await expect(page.locator('#settings-tab-sync')).not.toHaveAttribute('hidden', /.*/);
  await page.locator('#settings-tab-sync').click();
  await expect(page.locator('#sync-form')).toBeVisible();
  await expect(page.locator('#sync-form')).toContainText('R2');
  await expect(page.locator('#sync-status')).toContainText('non configur');
  // Secrets are never echoed back.
  assert.equal(await page.locator('#sync-secret').inputValue(), '');
  assert.equal(await page.locator('#sync-passphrase').inputValue(), '');

  // Save with all fields.
  await page.locator('#sync-url').fill('https://mon-compte.r2.cloudflarestorage.com/mon-bucket');
  await page.locator('#sync-access-key').fill('fixture-key-id');
  await page.locator('#sync-secret').fill('fixture-secret');
  await page.locator('#sync-passphrase').fill('fixture-passphrase');
  await page.locator('#sync-device').fill('PC bureau');
  await page.locator('#sync-save').click();
  await expect(page.locator('#sync-run')).toBeVisible();
  await expect(page.locator('#sync-forget')).toBeVisible();
  await expect(page.locator('#toasts')).toContainText(/enregistr/i);
  assert.equal(putBodies.length, 1);
  assert.equal(putBodies[0].secretAccessKey, 'fixture-secret');
  assert.equal(putBodies[0].passphrase, 'fixture-passphrase');
  // Inputs cleared after save, kept placeholders shown.
  assert.equal(await page.locator('#sync-secret').inputValue(), '');
  assert.equal(await page.locator('#sync-passphrase').inputValue(), '');
  await expect(page.locator('#sync-secret')).toHaveAttribute('placeholder', /conserver/);
  await expect(page.locator('#sync-passphrase')).toHaveAttribute('placeholder', /conserver/);
  assert.ok(!JSON.stringify(await page.evaluate(() => ({ ...localStorage }))).includes('fixture-secret'));

  // Save again without secrets: omitted means keep.
  await page.locator('#sync-save').click();
  assert.equal(putBodies.length, 2);
  assert.equal('secretAccessKey' in putBodies[1], false);
  assert.equal('passphrase' in putBodies[1], false);

  // Server 400 surfaces through the form error.
  failNextPut = 'sync.invalid_url';
  await page.locator('#sync-save').click();
  await expect(page.locator('#sync-error')).toContainText('sync.invalid_url');

  // Run now: 202 running, poll every 2 s, then lastSync status.
  await page.locator('#sync-run').click();
  await expect(page.locator('#sync-status')).toContainText(/en cours/, { timeout: 10000 });
  await expect(page.locator('#sync-status')).toContainText(/Derni/, { timeout: 15000 });
  assert.equal(runCalls, 1);

  // Forget with confirm.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('#sync-forget').click();
  await expect(page.locator('#sync-run')).toBeHidden();
  await expect(page.locator('#toasts')).toContainText(/oubli/i);
  assert.equal(deleteCalls, 1);

  // Project dialog: checkbox checked by default, sent in POST body.
  await page.keyboard.press('Escape');
  await page.locator('#add-project').click();
  await expect(page.locator('#project-sync')).toBeChecked();
  await page.locator('#project-cwd').fill(join(temp, 'Autre'));
  await page.locator('#project-sync').uncheck();
  // Capture the POST without depending on the real projects backend.
  const postPromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/projects') && response.request().method() === 'POST',
  );
  await page.locator('#project-submit').click();
  await postPromise;
  assert.equal(projectPosts.at(-1).sync, false);
  await page.keyboard.press('Escape');

  await page.locator('#add-project').click();
  await page.locator('#project-cwd').fill(join(temp, 'Troisieme'));
  await expect(page.locator('#project-sync')).toBeChecked();
  const postPromise2 = page.waitForResponse(
    (response) => response.url().endsWith('/api/projects') && response.request().method() === 'POST',
  );
  await page.locator('#project-submit').click();
  await postPromise2;
  assert.equal(projectPosts.at(-1).sync, true);
  await page.keyboard.press('Escape');

  // Project menu toggle: PATCH with flipped sync.
  const row = page.locator('.project-entry .project-row').first();
  await row.click({ button: 'right' });
  const syncItem = page.locator('#project-menu [data-project-action="sync"]');
  await expect(syncItem).toBeVisible();
  await expect(syncItem).toContainText('Ne plus synchroniser');
  await syncItem.click();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/projects') && response.request().method() === 'PATCH',
  );
  assert.equal(projectPatches.at(-1).sync, false);
  await row.click({ button: 'right' });
  await expect(page.locator('#project-menu [data-project-action="sync"]')).toContainText('Synchroniser');
  await page.keyboard.press('Escape');

  // English translations.
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-tab-sync').click();
  await expect(page.locator('#settings-tab-sync')).toHaveText('Sync');
  await expect(page.locator('#sync-save')).toHaveText('Save and test');
  await expect(page.locator('#sync-form')).toContainText('R2 bucket URL');
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('#settings-tab-sync')).toHaveText('Synchronisation');

  // Layout: desktop plus narrow widths, no panel overflow.
  await mkdir('test-results/sync-settings', { recursive: true });
  await page.locator('#settings-tab-sync').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect
    .poll(() => page.locator('#sync-form').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  await page.screenshot({
    path: 'test-results/sync-settings/desktop-fr.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('.settings-panels').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    .toBe(true);
  await page.screenshot({
    path: 'test-results/sync-settings/narrow-fr.png',
    animations: 'disabled',
  });
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await page.locator('#settings-tab-sync').click();
  await page.screenshot({
    path: 'test-results/sync-settings/narrow-en.png',
    animations: 'disabled',
  });

  // Read-only: sync tab hidden like other desktop-only settings.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.preferences = { ...body.preferences, readOnly: true };
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await page.locator('#open-settings').click();
  await expect(page.locator('#settings-tab-sync')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.locator('.project-entry .project-row').first().click({ button: 'right' });
  await expect(page.locator('#project-menu [data-project-action="sync"]')).toBeHidden();
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, []);
  console.log(
    'Sync settings UI passed: tab, save/test, run polling, forget, project checkbox and menu toggle, FR/EN, 390/1440 layout.',
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
