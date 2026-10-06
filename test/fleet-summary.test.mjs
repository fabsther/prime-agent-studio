import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFleetSummary, normalizeOrigin } from '../lib/fleet-summary.mjs';
import { createStore } from '../lib/store.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-summary-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const git = (...args) => exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10000 });
  return { root, cwd, git };
}
const machine = { machineId: 'machine-test', machineName: 'Test', apiVersion: 1 };
const service = (options) =>
  createFleetSummary({
    identity: machine,
    store: { overview: async () => ({ projects: [] }) },
    inspector: { inspect: async () => ({ agents: [] }) },
    getRuns: () => [],
    ...options,
  });

test('origin keys match SSH/HTTPS, strip credentials and .git, and fold case', () => {
  for (const value of [
    'git@GitHub.COM:Owner/Repo.git',
    'https://github.com/OWNER/REPO.GIT',
    'ssh://git@GITHUB.COM/Owner/Repo.git',
    'https://user:secret@GitHub.COM/Owner/Repo.git',
    'ssh://git@github.com:22/owner/repo',
    'git://github.com/owner/repo.git/',
    'git+ssh://git@github.com/owner/repo',
    ' https://GitHub.com/Owner/Repo.git?token=secret#ref ',
  ])
    assert.equal(normalizeOrigin(value), 'github.com/owner/repo', value);
  assert.equal(normalizeOrigin('https://gitlab.com/team/subgroup/repo.git'), 'gitlab.com/team/subgroup/repo');
  for (const value of [
    null,
    '',
    'bad url',
    '/local/repo',
    'C:\\local\\repo',
    'file:///repo.git',
    'https://github.com/',
    'https://github.com/.git',
  ])
    assert.equal(normalizeOrigin(value), null, String(value));
});

test('gitInfo reads clean, unborn and missing repositories without network or writes', async (t) => {
  const f = await fixture(t);
  assert.equal(await service().gitInfo(f.cwd), null);
  await f.git('init', '-q', '-b', 'fleet-test');
  let info = await service().gitInfo(f.cwd);
  assert.deepEqual(info, {
    origin: null,
    originKey: null,
    branch: 'fleet-test',
    dirty: false,
    changedFiles: 0,
  });
  await f.git('remote', 'add', 'origin', 'git@GitHub.com:Owner/Repo.GIT');
  await writeFile(join(f.cwd, 'tracked.txt'), 'before');
  await f.git('add', '.');
  await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const index = await readFile(join(f.cwd, '.git', 'index'));
  info = await service().gitInfo(f.cwd);
  assert.equal(info.originKey, 'github.com/owner/repo');
  assert.equal(info.dirty, false);
  assert.deepEqual(await readFile(join(f.cwd, '.git', 'index')), index);
  await f.git('checkout', '--detach', '-q');
  assert.equal((await service().gitInfo(f.cwd)).branch, null);
});

test('gitInfo counts staged/working changes and renames once, including untracked files', async (t) => {
  const f = await fixture(t);
  await f.git('init', '-q');
  await writeFile(join(f.cwd, 'rename.txt'), 'same');
  await writeFile(join(f.cwd, 'modify.txt'), 'before');
  await f.git('add', '.');
  await f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  await f.git('mv', 'rename.txt', 'renamed.txt');
  await writeFile(join(f.cwd, 'modify.txt'), 'staged');
  await f.git('add', 'modify.txt');
  await writeFile(join(f.cwd, 'modify.txt'), 'working');
  await writeFile(join(f.cwd, 'new [é].txt'), 'new');
  assert.equal((await service().gitInfo(f.cwd)).changedFiles, 3);
  assert.equal((await service().gitInfo(f.cwd)).dirty, true);
});

test('summary bounds newest 50 sessions, preserves agent parent links and reports run state', async (t) => {
  const f = await fixture(t);
  const sessions = Array.from({ length: 60 }, (_, i) => ({
    id: `session-${i}`,
    title: `Session ${i}`,
    updatedAt: new Date(10000 + i * 1000).toISOString(),
    ...(i === 59 ? { roadmapLink: { planId: 'plan', stepId: 'step', ownerMachineId: 'owner' } } : {}),
  }));
  const runs = [
    { id: 'older', cwd: f.cwd, sessionId: 'session-59', status: 'failed' },
    { id: 'live', cwd: f.cwd, sessionId: 'session-59', status: 'running', startedAt: 70000 },
    { id: 'failed', cwd: f.cwd, sessionId: 'session-58', status: 'failed', endedAt: 71000 },
    {
      id: 'question',
      cwd: f.cwd,
      sessionId: 'session-57',
      status: 'running',
      interactions: [{ status: 'pending' }],
    },
    { id: 'working', cwd: f.cwd, sessionId: 'session-56', status: 'running' },
    { id: 'stopping', cwd: f.cwd, sessionId: null, status: 'stopping' },
  ];
  let calls = 0,
    inFlight = 0,
    maximum = 0;
  const summary = service({
    identity: async () => machine,
    store: { overview: async () => ({ projects: [{ cwd: f.cwd, name: 'Project', sessions }] }) },
    getRuns: () => runs,
    inspector: {
      inspect: async (cwd, id) => {
        assert.equal(cwd, f.cwd);
        calls++;
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        await Promise.resolve();
        inFlight--;
        return {
          session: { status: id === 'session-59' ? 'waiting' : 'idle' },
          agents: [
            { id, parentId: null, name: 'Root', status: 'working', model: 'model', preview: 'not public' },
            {
              id: 'child',
              parentId: id,
              name: 'Worker',
              status: 'tool',
              progressNote: 'Progress',
              lastActivityAt: 72000,
            },
          ],
        };
      },
    },
  });
  const value = await summary.get(),
    project = value.projects[0];
  assert.equal(value.machine, machine);
  assert.equal(project.sessions.length, 50);
  assert.equal(calls, 50);
  assert.ok(maximum <= 4);
  assert.equal(project.sessions[0].id, 'session-59');
  assert.equal(project.sessions.at(-1).id, 'session-10');
  assert.equal(project.sessions[0].status, 'waiting');
  assert.equal(project.sessions[0].runId, 'live');
  assert.deepEqual(project.sessions[0].roadmapLink, sessions[59].roadmapLink);
  assert.equal(project.sessions[1].status, 'error');
  assert.equal(project.sessions[2].status, 'waiting');
  assert.equal(project.sessions[3].status, 'running');
  assert.equal(project.sessions[4].status, 'idle');
  assert.equal(project.sessions[0].agents[1].parentId, 'session-59');
  assert.equal(project.sessions[0].agents[1].progressNote, 'Progress');
  assert.equal(project.sessions[0].agents[0].preview, undefined);
  assert.equal(project.sessions[0].agents[0].lastActivityAt, 69000);
  assert.equal(project.sessions[0].updatedAt, 69000);
  assert.equal(project.activeRuns, 4);
  assert.equal(project.lastActivityAt, 72000);
  assert.equal(project.git, null);
});

test('summary reuses real store overview and degrades gracefully when inspection fails', async (t) => {
  const f = await fixture(t),
    sessionDir = join(f.root, 'sessions');
  await mkdir(sessionDir);
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    JSON.stringify({
      type: 'session',
      id: 'session-id',
      cwd: f.cwd,
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  const store = createStore({ sessionDir, dataDir: join(f.root, 'data'), initialCwd: f.cwd });
  const value = await service({
    store,
    inspector: {
      inspect: async () => {
        throw new Error('unavailable');
      },
    },
  }).get();
  assert.equal(value.projects[0].sessions[0].id, 'session-id');
  assert.equal(value.projects[0].sessions[0].status, 'idle');
  assert.deepEqual(value.projects[0].sessions[0].agents, []);
  assert.equal(value.projects[0].sessions[0].roadmapLink, null);
});

test('summary cache coalesces concurrent requests, expires after five seconds and retries failures', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  let calls = 0,
    release;
  const firstOverview = new Promise((done) => {
    release = done;
  });
  const summary = service({
    store: {
      overview: () => {
        calls++;
        return calls === 1 ? firstOverview : Promise.resolve({ projects: [] });
      },
    },
  });
  const first = summary.get(),
    second = summary.get();
  assert.equal(first, second);
  t.mock.timers.tick(6000);
  assert.equal(summary.get(), first); // in-flight requests do not expire
  release({ projects: [] });
  const value = await first;
  assert.equal(await summary.get(), value);
  assert.equal(calls, 1);
  t.mock.timers.tick(4999);
  assert.equal(await summary.get(), value);
  t.mock.timers.tick(1);
  assert.notEqual(await summary.get(), value);
  assert.equal(calls, 2);
  let fail = true;
  const retry = service({
    store: {
      overview: async () => {
        if (fail) {
          fail = false;
          throw new Error('store failed');
        }
        return { projects: [] };
      },
    },
  });
  await assert.rejects(retry.get(), /store failed/);
  assert.deepEqual((await retry.get()).projects, []);
});

test('gitInfo cache deduplicates requests and refreshes dirty state after expiry', async (t) => {
  const f = await fixture(t);
  await f.git('init', '-q');
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const summary = service();
  const first = summary.gitInfo(f.cwd);
  assert.equal(summary.gitInfo(f.cwd), first);
  const value = await first;
  await writeFile(join(f.cwd, 'new.txt'), 'new');
  assert.equal(await summary.gitInfo(f.cwd), value);
  assert.equal(value.dirty, false);
  t.mock.timers.tick(5000);
  assert.equal((await summary.gitInfo(f.cwd)).dirty, true);
});

test('agent timestamps use native lastActivityAt, then updatedAt, and root session mtime', async (t) => {
  const f = await fixture(t);
  const summary = service({
    store: {
      overview: async () => ({
        projects: [
          {
            cwd: f.cwd,
            name: 'Project',
            sessions: [{ id: 'root', title: 'Root', updatedAt: '2026-01-01T00:00:00.000Z' }],
          },
        ],
      }),
    },
    inspector: {
      inspect: async () => ({
        agents: [
          { id: 'root', parentId: null, status: 'idle' },
          {
            id: 'live-child',
            parentId: 'root',
            status: 'working',
            lastActivityAt: 1770000000000,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          { id: 'saved-child', parentId: 'root', status: 'saved', updatedAt: '2026-01-03T00:00:00.000Z' },
          { id: 'unknown-child', parentId: 'root', status: 'saved' },
        ],
      }),
    },
  });
  const project = (await summary.get()).projects[0],
    agents = project.sessions[0].agents;
  assert.equal(agents[0].lastActivityAt, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(agents[1].lastActivityAt, 1770000000000);
  assert.equal(agents[2].lastActivityAt, Date.parse('2026-01-03T00:00:00.000Z'));
  assert.equal(agents[3].lastActivityAt, null);
  assert.equal(project.lastActivityAt, 1770000000000);
});

test('real store and session inspector root activity falls back to session mtime', async (t) => {
  const { createSessionInspector } = await import('../lib/session-inspector.mjs');
  const f = await fixture(t),
    sessionDir = join(f.root, 'sessions');
  await mkdir(sessionDir);
  await writeFile(
    join(sessionDir, 'root.jsonl'),
    JSON.stringify({
      type: 'session',
      id: 'real-root',
      cwd: f.cwd,
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
  const store = createStore({ sessionDir, dataDir: join(f.root, 'data'), initialCwd: f.cwd });
  const inspector = createSessionInspector({
    store,
    sessionDir,
    agentHome: f.root,
    getRun: () => null,
    getClient: () => null,
    readEdges: async () => [],
  });
  const project = (await service({ store, inspector }).get()).projects[0];
  const session = project.sessions[0];
  assert.equal(session.agents[0].id, 'real-root');
  assert.equal(session.agents[0].lastActivityAt, session.updatedAt);
  assert.ok(session.agents[0].lastActivityAt > 0);
  assert.equal(project.lastActivityAt, session.updatedAt);
});
