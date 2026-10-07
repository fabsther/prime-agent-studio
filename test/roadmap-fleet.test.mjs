import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFleetDelegate,
  createRoadmapExternalLinks,
  normalizeDelegateOrigin,
} from '../lib/fleet-delegate.mjs';
import { createRoadmapService, validateRoadmapDocument } from '../lib/roadmap.mjs';
import { createStore } from '../lib/store.mjs';

const input = {
  prompt: 'Implement and test.',
  stepText: 'Add exports',
  planId: 'plan-owner',
  stepId: 'step-owner',
  ownerMachineId: 'owner',
};

test('delegate resolves explicit registered cwd first, or an unambiguous git originKey', async () => {
  const projects = [{ cwd: join(tmpdir(), 'first') }, { cwd: join(tmpdir(), 'second') }];
  const store = {
    findProject: async (cwd) => {
      const found = projects.find((p) => p.cwd === cwd);
      if (!found) throw Object.assign(new Error('missing'), { status: 404 });
      return found;
    },
    overview: async () => ({ projects }),
  };
  let calls = 0;
  const service = createFleetDelegate({
    store,
    originKeyOf: async (cwd) => {
      calls++;
      return cwd === projects[0].cwd ? 'github.com/team/repo' : 'github.com/team/other';
    },
  });
  assert.deepEqual(
    await service.resolveCheckout({ cwd: projects[1].cwd, originKey: 'ignored' }),
    projects[1],
  );
  assert.equal(calls, 0);
  assert.deepEqual(await service.resolveCheckout({ originKey: 'github.com/team/repo' }), projects[0]);
  await assert.rejects(service.resolveCheckout({ originKey: 'absent' }), { status: 404 });
  await assert.rejects(
    service.resolveCheckout({ cwd: join(tmpdir(), 'unknown'), originKey: 'github.com/team/repo' }),
    { status: 404 },
  );
  const ambiguous = createFleetDelegate({ store, originKeyOf: async () => 'github.com/team/repo' });
  await assert.rejects(ambiguous.resolveCheckout({ originKey: 'github.com/team/repo' }), {
    status: 409,
    code: 'fleet_checkout_ambiguous',
  });
  await assert.rejects(service.resolveCheckout({ cwd: '../escape' }), { status: 400 });
});

test('git origin normalization equates SSH/HTTPS and removes credentials and .git', () => {
  for (const url of [
    'git@GitHub.com:Team/Repo.git',
    'https://user:secret@github.com/Team/Repo.git',
    'ssh://git@github.com/Team/Repo.git/',
  ])
    assert.equal(normalizeDelegateOrigin(url), 'github.com/team/repo');
  for (const url of [null, 'C:\\local\\repo', 'file:///tmp/repo', '/tmp/repo', 'https://'])
    assert.equal(normalizeDelegateOrigin(url), null);
});

test('delegate reuses run lifecycle, waits for native session and persists before responding', async () => {
  const cwd = tmpdir(),
    saved = [],
    sent = [];
  let identify;
  const service = createFleetDelegate({
    store: { findProject: async () => ({ cwd }), setSessionRoadmapLink: async (...args) => saved.push(args) },
    getIdentity: async () => ({ machineId: 'target' }),
    startRun: async (body, hooks) => {
      sent.push(body);
      identify = hooks.onSession;
      return { id: 'run-1', cwd, sessionId: null };
    },
  });
  const pending = service.delegate({ ...input, cwd, model: 'provider/model', thinking: 'high' });
  // startRun is invoked after checkout/identity microtasks; use a check-phase turn, no polling.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 0);
  identify({ id: 'run-1', sessionId: 'session-1' });
  assert.deepEqual(await pending, { machineId: 'target', sessionId: 'session-1', runId: 'run-1', cwd });
  assert.deepEqual(saved, [
    ['session-1', { planId: input.planId, stepId: input.stepId, ownerMachineId: 'owner' }],
  ]);
  assert.match(sent[0].message, /Delegated from Roadmap of machine owner plan-owner\/step-owner/);
  assert.doesNotMatch(sent[0].message.split('\n')[0], /Delegated from/);
  assert.ok(sent[0].message.includes(input.stepText));
  assert.ok(sent[0].message.includes(input.prompt));
  assert.equal(sent[0].model, 'provider/model');
  assert.equal(sent[0].thinking, 'high');
  assert.equal(sent[0].sessionId, undefined);
  await assert.rejects(service.delegate({ ...input, cwd, ownerMachineId: '../owner' }), { status: 400 });
  assert.equal(sent.length, 1);
});

test('accepted native work with missing ID or storage failure is not reported as safe to repeat', async () => {
  const cwd = tmpdir();
  let callback,
    saves = 0;
  const service = createFleetDelegate({
    store: {
      findProject: async () => ({ cwd }),
      setSessionRoadmapLink: async () => {
        saves++;
      },
    },
    getIdentity: () => ({ machineId: 'target' }),
    sessionTimeoutMs: 10,
    startRun: async (_, { onSession }) => {
      callback = onSession;
      return { id: 'run-pending', sessionId: null };
    },
  });
  await assert.rejects(service.delegate({ ...input, cwd }), {
    status: 503,
    code: 'fleet_session_pending',
    accepted: true,
    runId: 'run-pending',
  });
  callback({ sessionId: 'later' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves, 1, 'late session still gets a durable association');
  const failed = createFleetDelegate({
    store: {
      findProject: async () => ({ cwd }),
      setSessionRoadmapLink: async () => {
        throw new Error('disk full');
      },
    },
    getIdentity: () => ({ machineId: 'target' }),
    startRun: async () => ({ id: 'run-failed', sessionId: 'session-failed' }),
  });
  await assert.rejects(failed.delegate({ ...input, cwd }), {
    status: 503,
    code: 'fleet_link_failed',
    accepted: true,
  });
});

test('external links share roadmap CAS, serialize on nested steps, preserve checks and survive checklist edits', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'prime-external-links-'));
  const service = createRoadmapService({ resolveProject: async () => ({ cwd }) });
  t.after(async () => {
    await service.close();
    await rm(cwd, { recursive: true, force: true });
  });
  await service.mutate(cwd, { action: 'init', expectedRevision: 0 });
  let doc = await service.mutate(cwd, {
    action: 'plan.create',
    expectedRevision: 1,
    title: 'Plan',
    steps: [{ text: 'Parent', children: [{ text: 'Child' }] }],
  });
  const planId = doc.plans[0].id,
    stepId = doc.plans[0].steps[0].children[0].id;
  const routes = createRoadmapExternalLinks({ service });
  const link = {
    cwd,
    planId,
    stepId,
    machineId: 'target',
    machineName: 'Workstation',
    sessionId: 'remote-session',
    expectedRevision: doc.revision,
  };
  const results = await Promise.allSettled([
    routes.mutate(link),
    routes.mutate({ ...link, sessionId: 'second-session' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'roadmap_conflict');
  doc = await service.read(cwd);
  const links = doc.plans[0].steps[0].children[0].externalLinks;
  link.sessionId = links[0].sessionId;
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], {
    machineId: 'target',
    machineName: 'Workstation',
    sessionId: link.sessionId,
    linkedAt: links[0].linkedAt,
  });
  assert.ok(Number.isSafeInteger(links[0].linkedAt));
  assert.equal(doc.plans[0].steps[0].children[0].done, false);
  const raw = JSON.parse(await readFile(join(cwd, '.prime/studio/roadmap.json'), 'utf8'));
  assert.deepEqual(validateRoadmapDocument(raw).plans[0].steps[0].children[0].externalLinks, links);
  // Existing documents that predate this additive field still read successfully.
  delete raw.plans[0].steps[0].externalLinks;
  delete raw.plans[0].steps[0].children[0].externalLinks;
  assert.deepEqual(validateRoadmapDocument(raw).plans[0].steps[0].children[0].externalLinks, []);
  const replacement = structuredClone(doc.plans[0].steps);
  delete replacement[0].children[0].externalLinks;
  doc = await service.mutate(cwd, {
    action: 'plan.steps',
    planId,
    steps: replacement,
    expectedRevision: doc.revision,
  });
  assert.deepEqual(doc.plans[0].steps[0].children[0].externalLinks, links);
  // Omitted revision is supported but still goes through a compare-and-swap.
  doc = await routes.mutate({ ...link, expectedRevision: undefined, machineName: 'Renamed' });
  assert.equal(doc.plans[0].steps[0].children[0].externalLinks.length, 1);
  assert.equal(doc.plans[0].steps[0].children[0].externalLinks[0].machineName, 'Renamed');
  assert.equal(doc.plans[0].steps[0].children[0].externalLinks[0].linkedAt, links[0].linkedAt);
  await assert.rejects(routes.mutate({ ...link, expectedRevision: doc.revision - 1 }, true), {
    code: 'roadmap_conflict',
  });
  doc = await routes.mutate({ ...link, expectedRevision: doc.revision }, true);
  assert.deepEqual(doc.plans[0].steps[0].children[0].externalLinks, []);
  assert.equal(doc.plans[0].steps[0].children[0].done, false);
  await assert.rejects(routes.mutate({ ...link, expectedRevision: doc.revision, stepId: 'missing' }), {
    status: 404,
  });
});

test('roadmapLink persists before a native header flush and survives store restart in overview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-fleet-store-'));
  const options = {
    dataDir: join(root, 'data'),
    sessionDir: join(root, 'sessions'),
    initialCwd: join(root, 'project'),
  };
  await Promise.all([mkdir(options.sessionDir), mkdir(options.initialCwd)]);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const store = createStore(options);
  const link = { planId: 'plan-owner', stepId: 'step-owner', ownerMachineId: 'owner' };
  await store.setSessionRoadmapLink('new-native-session', link);
  await assert.rejects(store.setSessionRoadmapLink('../invalid', link), { status: 400 });
  await assert.rejects(store.setSessionRoadmapLink('new-native-session', { ...link, stepId: '' }), {
    status: 400,
  });
  await writeFile(
    join(options.sessionDir, 'new-native-session.jsonl'),
    `${JSON.stringify({ type: 'session', id: 'new-native-session', cwd: options.initialCwd, timestamp: new Date().toISOString() })}\n`,
  );
  const reloaded = createStore(options);
  const overview = await reloaded.overview();
  assert.deepEqual(overview.projects[0].sessions[0].roadmapLink, link);
  assert.deepEqual((await reloaded.history('new-native-session')).roadmapLink, link);
});
