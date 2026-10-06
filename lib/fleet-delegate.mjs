import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { formatMessage as tr } from '../public/i18n-core.js';
import { HttpError, validId } from './store.mjs';

const exec = promisify(execFile);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, code, key, extra) => Object.assign(new HttpError(status, tr(key)), { code, ...extra });
const invalid = () => fail(400, 'fleet_invalid', 'fleet.invalidDelegation');
const string = (value, max) =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !/[\0\r]/.test(value);

// FLEET-MERGE: inject the shared originKeyOf from fleet-summary when available.
export function normalizeDelegateOrigin(origin) {
  if (typeof origin !== 'string' || /[\0\r\n]/.test(origin)) return null;
  const raw = origin.trim();
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);
  let host, path;
  try {
    if (raw.includes('://')) {
      const url = new URL(raw);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname;
    } else if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
      host = scp[1];
      path = scp[2];
    } else return null;
    path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return host && path ? `${host}/${path}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function delegateOriginKeyOf(cwd) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
      maxBuffer: 65536,
      windowsHide: true,
    });
    return normalizeDelegateOrigin(stdout.trim());
  } catch {
    return null;
  }
}

/** Target-side only: native startRun creates the session; its event supplies the durable ID. */
export function createFleetDelegate({
  store,
  startRun,
  getIdentity,
  originKeyOf = delegateOriginKeyOf,
  sessionTimeoutMs = 30000,
}) {
  async function resolveCheckout(input) {
    if (input.cwd !== undefined) {
      if (!string(input.cwd, 4096) || !isAbsolute(input.cwd)) throw invalid();
      const project = await store.findProject(input.cwd);
      if (project.exists === false) throw fail(404, 'fleet_checkout_missing', 'fleet.checkoutMissing');
      return project;
    }
    if (!string(input.originKey, 2000) || /[\r\n]/.test(input.originKey)) throw invalid();
    const { projects } = await store.overview();
    const matches = [];
    for (const project of projects)
      if (project.exists !== false && (await originKeyOf(project.cwd)) === input.originKey)
        matches.push(project);
    if (!matches.length) throw fail(404, 'fleet_checkout_missing', 'fleet.checkoutMissing');
    // Multiple worktrees can share an origin. Never silently run in the wrong one.
    if (matches.length > 1) throw fail(409, 'fleet_checkout_ambiguous', 'fleet.checkoutAmbiguous');
    return matches[0];
  }
  async function delegate(input) {
    if (
      !record(input) ||
      !string(input.prompt, 180000) ||
      !string(input.stepText, 8000) ||
      !['planId', 'stepId', 'ownerMachineId'].every((key) => validId(input[key]))
    )
      throw invalid();
    if (
      input.model !== undefined &&
      (typeof input.model !== 'string' || input.model.length > 300 || /[\r\n\0]/.test(input.model))
    )
      throw invalid();
    if (
      input.thinking != null &&
      input.thinking !== '' &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)
    )
      throw invalid();
    const project = await resolveCheckout(input);
    const identity = await getIdentity();
    const roadmapLink = { planId: input.planId, stepId: input.stepId, ownerMachineId: input.ownerMachineId };
    let bindSession, timer;
    const identified = new Promise((resolve) => {
      bindSession = resolve;
    });
    // Resolve rather than reject inside the event callback: event delivery is not awaitable.
    let binding;
    const onSession = (run) => {
      if (binding || !validId(run.sessionId)) return;
      binding = Promise.resolve()
        .then(() => store.setSessionRoadmapLink(run.sessionId, roadmapLink))
        .then(
          () => bindSession({ sessionId: run.sessionId }),
          (error) => bindSession({ error }),
        );
    };
    const run = await startRun(
      {
        cwd: project.cwd,
        message: [
          `Delegated from Roadmap of machine ${input.ownerMachineId} ${input.planId}/${input.stepId}`,
          'The owner machine holds the source Roadmap. Do not update a local copy or automatically check this step. Report results to the user.',
          `Step: ${input.stepText.trim()}`,
          input.prompt.trim(),
        ].join('\n\n'),
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
      },
      { onSession },
    );
    onSession(run);
    let result;
    try {
      result = await Promise.race([
        identified,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), sessionTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (result.timeout || result.error)
      throw fail(
        503,
        result.timeout ? 'fleet_session_pending' : 'fleet_link_failed',
        'fleet.sessionPending',
        {
          accepted: true,
          runId: run.id,
          cwd: project.cwd,
        },
      );
    return { machineId: identity.machineId, sessionId: result.sessionId, runId: run.id, cwd: project.cwd };
  }
  return { delegate, resolveCheckout };
}

/** Owner-side only: use the Roadmap's existing CAS/lock/write path, never a second store. */
export function createRoadmapExternalLinks({ service, read = (cwd) => service.read(cwd) }) {
  async function mutate(input, remove = false) {
    if (!record(input)) throw invalid();
    const expectedRevision =
      input.expectedRevision === undefined
        ? (await service.read(input.cwd)).revision
        : input.expectedRevision;
    await service.mutate(
      input.cwd,
      {
        ...input,
        expectedRevision,
        action: remove ? 'step.external-unlink' : 'step.external-link',
      },
      { by: 'user' },
    );
    return read(input.cwd);
  }
  return { mutate };
}
