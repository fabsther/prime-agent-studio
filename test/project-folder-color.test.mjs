import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createStore, PROJECT_FOLDER_COLORS, LEGACY_PROJECT_FOLDER_COLORS, normalizeProjectColor } from '../lib/store.mjs';
import { PROJECT_FOLDER_COLORS as PUBLIC_FOLDER_COLORS, LEGACY_PROJECT_FOLDER_COLORS as PUBLIC_LEGACY_COLORS, projectFolderColor } from '../public/project-navigation.js';
import { recentConversations } from '../public/session-wheel.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'prime-studio-folder-color-'));
  const options = {
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'local'),
    initialCwd: join(root, 'project'),
  };
  await mkdir(options.sessionDir, { recursive: true });
  await mkdir(options.initialCwd, { recursive: true });
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, options, store: createStore(options) };
}

test('folder color palette has exactly six choices with transparent first', () => {
  assert.equal(PROJECT_FOLDER_COLORS.length, 6);
  assert.equal(PROJECT_FOLDER_COLORS[0], 'transparent');
  assert.equal(new Set(PROJECT_FOLDER_COLORS).size, 6);
});

test('normalizeProjectColor validates at the trust boundary', () => {
  assert.equal(normalizeProjectColor(undefined), undefined);
  assert.equal(normalizeProjectColor('transparent'), '');
  assert.equal(normalizeProjectColor(''), '');
  assert.equal(normalizeProjectColor('#7FA6C9'), '#3b82f6');
  assert.equal(normalizeProjectColor('red'), null);
  assert.equal(normalizeProjectColor('#ffffff'), null);
  assert.equal(normalizeProjectColor(42), null);
  assert.equal(normalizeProjectColor(null), null);
  assert.equal(normalizeProjectColor(['#7fa6c9']), null);
  assert.equal(normalizeProjectColor({ color: '#7fa6c9' }), null);
  assert.equal(normalizeProjectColor(true), null);
  for (const hostile of ['constructor', 'Constructor', '__proto__', '__PROTO__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(normalizeProjectColor(hostile), null);
  }
});

test('frontend palette matches the backend palette', () => {
  assert.deepEqual(PUBLIC_FOLDER_COLORS, PROJECT_FOLDER_COLORS);
});

test('PATCH persists a swatch per project and transparent resets across reload', async (t) => {
  const { root, options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  const other = join(root, 'other');
  await mkdir(other, { recursive: true });
  await store.project({ cwd: other });

  const tinted = await store.project({ cwd: options.initialCwd, color: '#16a34a' }, true);
  assert.equal(tinted.color, '#16a34a');
  let overview = await store.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, '#16a34a');
  assert.equal(overview.projects.find((p) => p.cwd === other).color, undefined);

  const reopened = createStore(options);
  overview = await reopened.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, '#16a34a');

  const reset = await reopened.project({ cwd: options.initialCwd, color: 'transparent' }, true);
  assert.equal(reset.color, undefined);
  overview = await reopened.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, undefined);
});

test('PATCH rejects colors outside the palette', async (t) => {
  const { options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  for (const color of ['red', '#ffffff', 'javascript:alert(1)', '#7fa6c9;', 'constructor', '__proto__', ['#7fa6c9'], { color: '#7fa6c9' }, null, 42]) {
    await assert.rejects(store.project({ cwd: options.initialCwd, color }, true), /400|valeur|Invalid/i);
  }
  const overview = await store.overview();
  assert.equal(overview.projects[0].color, undefined);
});

test('vivid palette stays distinguishable while legacy pastels migrate in family', () => {
  assert.deepEqual(PUBLIC_FOLDER_COLORS, PROJECT_FOLDER_COLORS);
  assert.deepEqual(PUBLIC_LEGACY_COLORS, LEGACY_PROJECT_FOLDER_COLORS);
  assert.equal(new Set(PROJECT_FOLDER_COLORS.slice(1)).size, 5);
  for (const vivid of PROJECT_FOLDER_COLORS.slice(1)) assert.equal(normalizeProjectColor(vivid), vivid);
  assert.equal(normalizeProjectColor('#7fa6c9'), '#3b82f6');
  assert.equal(normalizeProjectColor('#8fb49e'), '#16a34a');
  assert.equal(normalizeProjectColor('#d0a75e'), '#d97706');
  assert.equal(normalizeProjectColor('#c98a7d'), '#dc2626');
  assert.equal(normalizeProjectColor('#a99ac9'), '#8b5cf6');
  assert.equal(projectFolderColor({ color: '#7FA6C9' }), '#3b82f6');
  assert.equal(projectFolderColor({ color: '#3B82F6' }), '#3b82f6');
  assert.equal(projectFolderColor({}), '');
  assert.equal(projectFolderColor({ color: 'transparent' }), '');
  assert.equal(projectFolderColor({ color: '#ffffff' }), '');
  for (const hostile of ['constructor', '__proto__', 'toString']) {
    assert.equal(projectFolderColor({ color: hostile }), '');
  }
});

test('new vivid swatches persist across reload while uncolored stays neutral', async (t) => {
  const { root, options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  const other = join(root, 'other');
  await mkdir(other, { recursive: true });
  await store.project({ cwd: other });
  const vivid = PROJECT_FOLDER_COLORS[1];
  const tinted = await store.project({ cwd: options.initialCwd, color: vivid }, true);
  assert.equal(tinted.color, vivid);
  let overview = await store.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, vivid);
  assert.equal(overview.projects.find((p) => p.cwd === other).color, undefined);
  const reopened = createStore(options);
  overview = await reopened.overview();
  assert.equal(overview.projects.find((p) => p.cwd === tinted.cwd).color, vivid);
  assert.equal(projectFolderColor(overview.projects.find((p) => p.cwd === tinted.cwd)), vivid);
  assert.equal(projectFolderColor(overview.projects.find((p) => p.cwd === other)), '');
  const wheelRows = recentConversations(
    [
      { cwd: tinted.cwd, name: 'Tinted', color: vivid, sessions: [{ id: 's1', title: 'T', updatedAt: 1 }] },
      { cwd: other, name: 'Plain', sessions: [{ id: 's2', title: 'U', updatedAt: 2 }] },
    ],
    'en',
  );
  assert.equal(wheelRows.find((row) => row.id === 's1').color, vivid);
  assert.equal(wheelRows.find((row) => row.id === 's2').color, '');
});

test('legacy pastel assignments migrate to vivid on write and overview', async (t) => {
  const { options, store } = await fixture(t);
  await store.project({ cwd: options.initialCwd }, true);
  const migrated = await store.project({ cwd: options.initialCwd, color: '#7fa6c9' }, true);
  assert.equal(migrated.color, '#3b82f6');
  const overview = await store.overview();
  assert.equal(overview.projects.find((p) => p.cwd === options.initialCwd).color, '#3b82f6');
  assert.equal(projectFolderColor(overview.projects.find((p) => p.cwd === options.initialCwd)), '#3b82f6');
  assert.equal(projectFolderColor({ color: '#a99ac9' }), '#8b5cf6');
});
