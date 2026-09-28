// Isolated UI regression. No model, account or user session is used.
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'prime-context-notices-'));
const cwd = join(temp, 'Context notices');
const sessionDir = join(temp, 'sessions');
const evidence = resolve('test-results/context-notices');
await Promise.all([mkdir(cwd), mkdir(sessionDir), mkdir(evidence, { recursive: true })]);
let parentId = null;
const record = (id, fields) => {
  const result = { id, parentId, timestamp: new Date().toISOString(), ...fields };
  parentId = id;
  return result;
};
const message = (id, role, text, extra = {}) => record(id, {
  type: 'message', message: { role, content: [{ type: 'text', text }], ...extra },
});
const notice = (id, kind, text) => record(id, {
  type: 'custom_message', customType: 'goal_context', display: true,
  details: kind ? { kind } : undefined, content: text,
});
const fixture = [
  { type: 'session', id: 'context-notices-fixture', cwd, version: 3, timestamp: new Date().toISOString() },
  message('user', 'user', 'Vérifie les notices compactes.'),
  message('start', 'assistant', 'La vérification commence.'),
  notice('goal', 'continuation', '[goal: continuation]\n\nGOAL_DETAILS_PRESERVED'),
  message('answer', 'assistant', 'La réponse utile reste visible.'),
  notice('legacy-goal', undefined, '[goal: continuation]\n\nLEGACY_GOAL_DETAILS'),
  message('after-goal', 'assistant', 'La suite reste dans le même tour.'),
  notice('budget', 'budget_limit', '[goal: budget-limit]\n\nBUDGET_WARNING_VISIBLE'),
  notice('objective', 'objective_updated', '[goal: objective-updated]\n\nOBJECTIVE_UPDATE_VISIBLE'),
  notice('unknown-goal', 'future_kind', '[goal: future-kind]\n\nUNKNOWN_GOAL_VISIBLE'),
  record('unknown-system', { type: 'custom_message', customType: 'future_notice', display: true, content: 'UNKNOWN_NOTICE_VISIBLE' }),
  record('compact', { type: 'compaction', summary: '## Goal\n\nCOMPACTION_FULL_TEXT\n\n' + 'Résumé conservé. '.repeat(150), firstKeptEntryId: 'user', tokensBefore: 20000 }),
  record('branch', { type: 'branch_summary', summary: 'BRANCH_FULL_TEXT', fromId: 'answer' }),
  message('after-context', 'assistant', 'Après les résumés.'),
];
const sessionFile = join(sessionDir, 'fixture.jsonl');
const original = fixture.map(JSON.stringify).join('\n') + '\n';
await writeFile(sessionFile, original);
const runtime = {
  getStatus: async () => ({ available: true, version: 'fixture' }),
  getModels: async () => ({ models: [{ id: 'fixture/model', name: 'Test', provider: 'fixture' }], default: { model: 'fixture/model' } }),
  async start() { throw new Error('No model execution is allowed in this fixture.'); },
  async close() {},
};
const app = createApp({ runtime, sessionDir, dataDir: join(temp, 'data'), initialCwd: cwd });
let browser, page;
const checks = [];
try {
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  browser = await chromium.launch({ headless: true, ...(process.env.PRIME_STUDIO_TEST_BROWSER === 'chromium' ? {} : { channel: 'msedge' }) });
  page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.locator('#session-list').getByText('Vérifie les notices compactes.', { exact: true }).click();
  const card = (id) => page.locator(`#messages [data-message-id="${id}"]`);
  await expect(card('answer')).toBeVisible();
  await expect(page.locator('#messages > .assistant-turn')).toHaveCount(2);
  await expect(card('goal')).toBeHidden();
  await expect(card('legacy-goal')).toBeHidden();
  for (const id of ['budget', 'objective', 'unknown-goal', 'unknown-system']) {
    await expect(card(id)).toBeVisible();
    await expect(card(id).locator('xpath=..')).toHaveAttribute('id', 'messages');
  }
  checks.push('Only continuation notices grouped; budgets, objective updates and unknown messages remain visible.');
  const activities = page.locator('#messages .activity-stack');
  await expect(activities).toHaveCount(2);
  const closedHeight = await activities.first().evaluate((node) => node.getBoundingClientRect().height);
  expect(closedHeight).toBeLessThanOrEqual(50);
  await expect(activities.first().locator('summary')).toContainText('1 événement');
  await activities.first().locator('summary').click();
  await expect(card('goal')).toContainText('GOAL_DETAILS_PRESERVED');
  await expect(card('goal')).toBeVisible();
  await activities.first().locator('summary').click();
  checks.push('Completed cards <= 50px on desktop; complete goal notice available after expansion.');
  const summary = card('compact').locator('details.context-disclosure');
  await expect(summary).not.toHaveAttribute('open', '');
  await expect(summary.locator('summary')).toContainText('Contexte compacté');
  await expect(summary.locator('.message-body')).toBeHidden();
  await expect(card('branch').locator('summary')).toContainText('Résumé de branche');
  await summary.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('.message-body')).toBeVisible();
  await expect(summary.locator('.message-body')).toContainText('COMPACTION_FULL_TEXT');
  await expect(summary.locator('.message-actions button')).toBeVisible();
  await page.evaluate(async () => (await import('/public/i18n.js')).setLanguage('en', { persist: false }));
  await expect(summary.locator('summary')).toContainText('Compacted context');
  await expect(summary).toHaveAttribute('open', '');
  await expect(card('branch').locator('summary')).toContainText('Branch summary');
  await summary.locator('summary').click();
  await expect(summary.locator('summary')).toContainText('View summary');
  checks.push('Full compaction and branch summaries collapse by default; keyboard access, copy action and FR/EN labels work.');
  await page.evaluate(async () => (await import('/public/i18n.js')).setLanguage('fr', { persist: false }));
  await page.locator('#conversation-scroll').evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: join(evidence, 'desktop.png'), animations: 'disabled' });
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'desktop-summaries.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await summary.locator('summary').evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: join(evidence, 'mobile.png'), animations: 'disabled' });
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'mobile-summaries.png'), animations: 'disabled' });
  await summary.locator('summary').click();
  await expect(summary.locator('.message-body')).toBeVisible();
  await page.reload();
  await expect(card('compact').locator('.message-body')).toBeHidden();
  await expect(card('budget')).toBeVisible();
  expect(await readFile(sessionFile, 'utf8')).toBe(original);
  expect(errors).toEqual([]);
  checks.push('Mobile layout, reload defaults, no browser errors and byte-identical native history.');
  await writeFile(join(evidence, 'report.json'), JSON.stringify({ passed: true, closedHeight, checks }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, closedHeight, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(evidence, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally {
    try { await app.close(); } finally { await rm(temp, { recursive: true, force: true, maxRetries: 3 }); }
  }
}
