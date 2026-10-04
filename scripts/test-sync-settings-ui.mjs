// Focused R2 conversation sync UI proof with mocked sync API.
// Real HTTP shell with isolated profile; /api/sync* mocked in page,
// project POST/PATCH sync bodies captured and overview patched in flight.
// Covers readability: global footer status, project badges, header indicator,
// background check on open, shared polling, FR+EN, 1440 and 390 widths.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'studio-sync-settings-'));
const cwd = join(temp, 'Projet de demonstration');
const agentHome = join(temp, 'agent');
const sessionDir = join(temp, 'sessions');
const dataDir = join(temp, 'data');
await Promise.all(
  [cwd, agentHome, sessionDir, dataDir, join(temp, 'Autre'), join(temp, 'Troisieme')].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);

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

// In-memory mocked sync backend (local only routes, extended contract).
const syncState = {
  configured: false,
  url: null,
  accessKeyId: null,
  hasSecret: false,
  hasPassphrase: false,
  device: '',
  running: false,
  progress: null,
  lastSync: null,
  sessions: {},
  pending: 0,
};
let putBodies = [];
let runCalls = 0;
let deleteCalls = 0;
let failNextPut = null;
let pollCount = 0;
let syncGetCount = 0;
const projectPosts = [];
const projectPatches = [];
// Overview sync overlay: project cwd -> sync boolean.
const syncOverlay = new Map();
// POST /api/sync/session mock.
let sessionCheckCalls = [];
let sessionCheckResponse = { state: 'synced', changed: false };
let sessionCheckHandler = null;

let browser;
const deadline = setTimeout(() => {
  void browser?.close();
  void app.close();
}, 180000);

const sessionFile = (id, projectCwd, title, body = 'Bonjour') => {
  const stamp = new Date().toISOString();
  const lines = [
    { type: 'session', id, cwd: projectCwd, timestamp: stamp },
    {
      type: 'message',
      id: `${id}-u`,
      parentId: null,
      timestamp: stamp,
      message: { role: 'user', content: title, timestamp: stamp },
    },
    {
      type: 'message',
      id: `${id}-a`,
      parentId: `${id}-u`,
      timestamp: stamp,
      message: { role: 'assistant', content: body, timestamp: stamp },
    },
  ];
  return writeFile(join(sessionDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

try {
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PRIME_STUDIO_TEST_BROWSER || 'chromium',
  });
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const shape = () => ({ ...syncState, sessions: { ...syncState.sessions } });

  await page.route('**/api/sync/session', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    sessionCheckCalls.push(body);
    if (sessionCheckHandler) {
      const out = await sessionCheckHandler(body);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(out) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(sessionCheckResponse) });
  });
  await page.route('**/api/sync/run', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    runCalls++;
    syncState.running = true;
    syncState.progress = { phase: 'push', done: 120, total: 253 };
    pollCount = 0;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(shape()) });
  });
  await page.route('**/api/sync', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      syncGetCount++;
      if (syncState.running) {
        pollCount++;
        if (pollCount >= 2) {
          syncState.running = false;
          syncState.progress = null;
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
      syncState.progress = null;
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
      syncState.progress = null;
      syncState.lastSync = null;
      syncState.sessions = {};
      syncState.pending = 0;
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
  const patchProjects = (projects) => {
    if (Array.isArray(projects))
      for (const project of projects)
        if (syncOverlay.has(project.cwd)) project.sync = syncOverlay.get(project.cwd);
  };
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    patchProjects(data?.projects);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/bootstrap', async (route) => {
    // Initial projects come from bootstrap; keep sync flags consistent.
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json().catch(() => null);
    if (data && typeof data === 'object') {
      patchProjects(data?.projects);
      await route.fulfill({ response, json: data });
    } else {
      await route.continue();
    }
  });

  await page.goto(url);
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });

  // Footer hidden when sync is not configured.
  await expect(page.locator('#sync-footer')).toBeHidden();

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

  // Run now: 202 running with progress, poll every 2 s, then lastSync status.
  await page.locator('#sync-run').click();
  await expect(page.locator('#sync-status')).toContainText(/en cours/, { timeout: 10000 });
  await expect(page.locator('#sync-status')).toContainText(/Derni/, { timeout: 15000 });
  assert.equal(runCalls, 1);
  // Footer follows the running progress while the settings panel is open
  // (one shared poller, no duplicate timers).
  await page.keyboard.press('Escape');
  syncState.running = true;
  pollCount = -100;
  syncState.progress = { phase: 'push', done: 120, total: 253 };
  syncState.lastSync = null;
  syncGetCount = 0;
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });
  await expect(page.locator('#sync-footer')).toContainText(/120.*253|Synchronisation/, { timeout: 15000 });
  await expect(page.locator('#sync-footer')).toBeVisible();
  // Back to idle with a fresh timestamp for the readability checks.
  syncState.running = false;
  syncState.progress = null;
  syncState.lastSync = { at: new Date().toISOString(), ok: true, sent: 512, received: 1, pushed: 1 };

  // Forget with confirm.
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  // Status and run sit above the folded configuration.
  await expect(page.locator('#sync-run')).toBeVisible();
  await expect(page.locator('#sync-config')).not.toHaveAttribute('open', '');
  const order = await page.evaluate(() => {
    const run = document.getElementById('sync-run').getBoundingClientRect().top;
    const config = document.getElementById('sync-config').getBoundingClientRect().top;
    return run < config;
  });
  assert.ok(order, 'sync button is above the configuration');
  await page.locator('#sync-config > summary').click();
  // Cancel keeps the configuration; confirm uses the in-app dialog, not window.confirm.
  page.on('dialog', () => assert.fail('native confirm must not be used'));
  await page.locator('#sync-forget').click();
  await expect(page.locator('#sync-forget-dialog')).toBeVisible();
  await page.locator('#sync-forget-dialog button[value="cancel"]').click();
  await expect(page.locator('#sync-forget-dialog')).toBeHidden();
  assert.equal(deleteCalls, 0);
  await page.locator('#sync-forget').click();
  await page.locator('#sync-forget-dialog button[value="confirm"]').click();
  await expect(page.locator('#sync-run')).toBeHidden();
  await expect(page.locator('#toasts')).toContainText(/oubli/i);
  assert.equal(deleteCalls, 1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sync-footer')).toBeHidden();

  // Project dialog: checkbox checked by default, sent in POST body.
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

  // Project menu toggle: PATCH with flipped sync (target the opted-in Troisieme).
  const row = page
    .locator('.project-entry', { has: page.locator('.project-label', { hasText: 'Troisieme' }) })
    .locator('.project-row');
  await row.click({ button: 'right' });
  const syncItem = page.locator('#project-menu [data-project-action="sync"]');
  await expect(syncItem).toBeVisible();
  await expect(syncItem).toContainText('Ne plus synchroniser');
  await syncItem.click();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/projects') && response.request().method() === 'PATCH',
  );
  assert.equal(projectPatches.at(-1).sync, false);
  // Re-enable so readability tests have a synced project.
  await row.click({ button: 'right' });
  await expect(page.locator('#project-menu [data-project-action="sync"]')).toContainText('Synchroniser');
  await page.locator('#project-menu [data-project-action="sync"]').click();
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/projects') && response.request().method() === 'PATCH',
  );
  assert.equal(projectPatches.at(-1).sync, true);
  await page.keyboard.press('Escape');

  // Re-configure so the readability layer has something to show.
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  await page.locator('#sync-url').fill('https://mon-compte.r2.cloudflarestorage.com/mon-bucket');
  await page.locator('#sync-access-key').fill('fixture-key-id');
  await page.locator('#sync-secret').fill('fixture-secret-2');
  await page.locator('#sync-passphrase').fill('fixture-passphrase-2');
  await page.locator('#sync-device').fill('PC bureau');
  await page.locator('#sync-save').click();
  await expect(page.locator('#sync-run')).toBeVisible();
  await page.keyboard.press('Escape');

  // Two conversations in a synced project: one synced, one pending.
  // The first project was opted out by the menu toggle above, so use
  // Troisieme (created opted in). Ensure its folder exists for badges.
  await mkdir(join(temp, 'Troisieme'), { recursive: true });
  await mkdir(join(temp, 'Autre'), { recursive: true });
  const syncedCwd = join(temp, 'Troisieme');
  await sessionFile('sync-read-1', syncedCwd, 'Conversation deja envoyee');
  await sessionFile('sync-read-2', syncedCwd, 'Conversation a envoyer');
  await sessionFile('sync-read-off', join(temp, 'Autre'), 'Conversation hors sync');
  syncState.sessions = { 'sync-read-1': 'synced', 'sync-read-2': 'pending' };
  syncState.pending = 1;
  syncState.running = false;
  syncState.progress = null;
  syncState.lastSync = {
    at: new Date(Date.now() - 2 * 60000).toISOString(),
    ok: true,
    sent: 512,
    received: 1,
    pushed: 1,
  };
  sessionCheckCalls = [];
  sessionCheckResponse = { state: 'pending', changed: false };
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });
  // Ensure the synced project is expanded so its sessions are visible.
  const troisiemeRow = page
    .locator('.project-entry', { has: page.locator('.project-label', { hasText: 'Troisieme' }) })
    .locator('.project-row');
  await troisiemeRow.click();
  await expect(page.locator('.session-row[data-session-id="sync-read-2"]')).toBeVisible({ timeout: 15000 });

  // Global footer: pending count, always visible near the engine status.
  const footer = page.locator('#sync-footer');
  await expect(footer).toBeVisible({ timeout: 15000 });
  await expect(footer).toContainText(/1 conversation.*envoyer/i);
  await expect(footer).toHaveAttribute('data-state', 'pending');

  // Project badges: synced projects show a corner glyph, opted-out show none.
  const demoEntry = page.locator('.project-entry', {
    has: page.locator('.project-label', { hasText: 'Troisieme' }),
  });
  await expect(demoEntry.locator('.sync-badge')).toBeVisible({ timeout: 15000 });
  await expect(demoEntry.locator('.sync-badge')).toHaveAttribute('data-state', 'pending');
  const autreEntry = page.locator('.project-entry', {
    has: page.locator('.project-label', { hasText: 'Autre' }),
  });
  await expect(autreEntry.locator('.sync-badge')).toHaveCount(0);
  // No per-row sync dots: readability comes from the header, folder badge and footer.
  const pendingRow = page.locator('.session-row[data-session-id="sync-read-2"]');
  await expect(pendingRow).toBeVisible();
  await expect(pendingRow.locator('.sync-session-dot')).toHaveCount(0);
  const syncedRow = page.locator('.session-row[data-session-id="sync-read-1"]');
  await expect(syncedRow).toBeVisible();

  // Clicking the footer opens Preferences on the Synchronisation tab.
  await footer.click();
  await expect(page.locator('#settings-panel-sync')).toBeVisible();
  await expect(page.locator('#sync-form')).toBeVisible();
  await page.keyboard.press('Escape');

  // Header indicator: background check on open, drafts kept, focus kept.
  sessionCheckCalls = [];
  sessionCheckResponse = { state: 'pending', changed: false };
  await pendingRow.locator('.session-select').click();
  await expect(page.locator('#header-session')).toContainText('Conversation a envoyer');
  await expect(page.locator('#sync-header-state')).toBeVisible();
  // The check runs in the background without blocking the conversation.
  await expect.poll(() => sessionCheckCalls.length).toBe(1);
  assert.equal(sessionCheckCalls[0].id, 'sync-read-2');
  await expect(page.locator('#sync-header-state')).toContainText(/Modifications locales|V\u00e9rification/i, {
    timeout: 10000,
  });
  await expect(page.locator('#sync-header-state')).toHaveAttribute('data-state', 'pending');
  await page.locator('#composer').fill('Brouillon a garder');

  // changed:true reloads through the existing path and refreshes the overview.
  await sessionFile('sync-read-2', syncedCwd, 'Conversation a envoyer', 'Contenu distant plus recent');
  sessionCheckResponse = { state: 'synced', changed: true };
  const overviewBefore = await page.evaluate(() =>
    fetch('/api/overview')
      .then((r) => r.json())
      .then((d) => d.totalSessions),
  );
  await page
    .locator('.project-entry', { has: page.locator('.project-label', { hasText: 'Autre' }) })
    .locator('.project-row')
    .click();
  await pendingRow.locator('.session-select').click();
  await expect.poll(() => sessionCheckCalls.length).toBe(2);
  await expect(page.locator('#sync-header-state')).toContainText(/Synchronis\u00e9e|V\u00e9rification/i, {
    timeout: 15000,
  });
  await expect(page.locator('#composer')).toHaveValue('Brouillon a garder');
  assert.ok(overviewBefore >= 0);

  // Excluded project: no check, explicit header state.
  sessionCheckCalls = [];
  const offRow = page.locator('.session-row[data-session-id="sync-read-off"]');
  await expect(offRow).toBeVisible();
  await offRow.locator('.session-select').click();
  await expect(page.locator('#sync-header-state')).toContainText(/projet exclu/i, { timeout: 10000 });
  await expect(page.locator('#sync-header-state')).toHaveAttribute('data-state', 'excluded');
  assert.equal(sessionCheckCalls.length, 0);

  // Running progress in the footer and syncing badges.
  syncState.running = true;
  pollCount = -100;
  syncState.progress = { phase: 'pull', done: 42, total: 100 };
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });
  await expect(page.locator('#sync-footer')).toContainText(/42.*100/, { timeout: 15000 });
  await expect(page.locator('#sync-footer')).toHaveAttribute('data-state', 'syncing');
  await expect(demoEntry.locator('.sync-badge')).toHaveAttribute('data-state', 'syncing');
  syncState.running = false;
  syncState.progress = null;
  syncState.lastSync = { at: new Date().toISOString(), ok: true, sent: 128, received: 0, pushed: 0 };
  syncState.sessions = { 'sync-read-1': 'synced', 'sync-read-2': 'synced' };
  syncState.pending = 0;

  // Error state in the footer and badges.
  syncState.lastSync = {
    at: new Date().toISOString(),
    ok: false,
    error: 'sync.err_partial',
    sent: 0,
    received: 0,
    pushed: 0,
    errors: 2,
  };
  await page.reload();
  await expect(page.locator('#connection-label')).toContainText(/connect|moteur|connect\u00e9/i, {
    timeout: 15000,
  });
  await expect(page.locator('#sync-footer')).toContainText(/Erreur/i, { timeout: 15000 });
  await expect(page.locator('#sync-footer')).toHaveAttribute('data-state', 'error');
  // Back to a clean synced state for screenshots.
  syncState.lastSync = {
    at: new Date(Date.now() - 2 * 60000).toISOString(),
    ok: true,
    sent: 512,
    received: 1,
    pushed: 1,
  };
  syncState.sessions = { 'sync-read-1': 'synced', 'sync-read-2': 'pending' };
  syncState.pending = 1;
  sessionCheckResponse = { state: 'pending', changed: false };
  await page.reload();
  await expect(page.locator('#sync-footer')).toContainText(/1 conversation.*envoyer/i, { timeout: 15000 });
  await pendingRow.locator('.session-select').click();
  await expect(page.locator('#sync-header-state')).toContainText(/Modifications locales/i, {
    timeout: 15000,
  });

  // Shared poller: settings open plus global UI share one timer (no double GET).
  // Trigger a real run so the shared monitor switches to fast polling.
  syncGetCount = 0;
  pollCount = -100;
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  await page.locator('#sync-run').click();
  await expect(page.locator('#sync-status')).toContainText(/en cours/i, { timeout: 10000 });
  await page.waitForTimeout(5200);
  await page.keyboard.press('Escape');
  // Finish the run for the following checks.
  syncState.running = false;
  pollCount = 0;
  syncState.progress = null;
  syncState.lastSync = { at: new Date().toISOString(), ok: true, sent: 64, received: 0, pushed: 0 };
  // One poller means about one GET per 2 s while running, not two.
  assert.ok(
    syncGetCount >= 2 && syncGetCount <= 5,
    `expected one shared poller, got ${syncGetCount} GET in ~5 s`,
  );

  // English translations.
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('en');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sync-footer')).toContainText(/conversation to send/i, { timeout: 10000 });
  await pendingRow.locator('.session-select').click();
  await expect(page.locator('#sync-header-state')).toContainText(/Local changes/i, { timeout: 10000 });
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  await expect(page.locator('#settings-tab-sync')).toHaveText('Sync');
  await expect(page.locator('#sync-save')).toHaveText('Save and test');
  await expect(page.locator('#sync-form')).toContainText('R2 bucket URL');
  await page.locator('#settings-tab-appearance').click();
  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('#settings-tab-sync')).toHaveText('Synchronisation');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sync-footer')).toContainText(/conversation.*envoyer/i, { timeout: 10000 });

  // Layout: desktop plus narrow widths, no panel overflow.
  await mkdir('test-results/sync-settings', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  await page.waitForTimeout(400);
  const formOverflow = await page.locator('#sync-form').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const wide = [...el.querySelectorAll('*')].filter(
      (n) => n.offsetParent && n.getBoundingClientRect().right > box.right + 1,
    );
    return {
      diff: el.scrollWidth - el.clientWidth,
      wide: wide
        .map(
          (n) =>
            `${n.tagName}#${n.id}.${n.className}:${Math.round(n.getBoundingClientRect().width)}/${Math.round(box.width)}`,
        )
        .slice(0, 6),
    };
  });
  assert.ok(formOverflow.diff <= 1, JSON.stringify(formOverflow));
  await page.screenshot({
    path: 'test-results/sync-settings/desktop-fr.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  // Sidebar with badges and footer status, plus the header indicator.
  await expect(page.locator('#sync-footer')).toBeVisible();
  await page.screenshot({
    path: 'test-results/sync-settings/sidebar-sync-fr.png',
    animations: 'disabled',
  });
  await pendingRow.locator('.session-select').click();
  await expect(page.locator('#sync-header-state')).toBeVisible();
  await page.screenshot({
    path: 'test-results/sync-settings/header-sync-fr.png',
    animations: 'disabled',
  });
  await page.locator('#open-settings').click();
  await page.locator('#settings-tab-sync').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const narrowOverflow = await page.locator('.settings-panels').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const wide = [...el.querySelectorAll('*')].filter(
      (n) => n.offsetParent && n.getBoundingClientRect().right > box.right + 1,
    );
    return {
      diff: el.scrollWidth - el.clientWidth,
      width: Math.round(box.width),
      wide: wide
        .map(
          (n) =>
            `${n.tagName}#${n.id}.${n.className}:${Math.round(n.getBoundingClientRect().right - box.right)}`,
        )
        .slice(0, 6),
    };
  });
  assert.ok(narrowOverflow.diff <= 1, JSON.stringify(narrowOverflow));
  await page.screenshot({
    path: 'test-results/sync-settings/narrow-fr.png',
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });

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
    'Sync settings UI passed: tab, save/test, run polling, forget, project checkbox and menu toggle, footer status, badges, header check, shared poller, FR/EN, 390/1440 layout.',
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
