import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '../scripts/launcher-common.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export async function machineIdentity({ dataDir, machineName, studioVersion = '4.1.5-beta.4' }) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'fleet-identity.json');
  const unlock = await acquireLock({ lock: join(dataDir, 'fleet-identity.lock') }, { timeout: 5000 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let identity;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
        throw new Error(tr('server.une_erreur_est_survenue'));
      identity = JSON.parse(await readFile(file, 'utf8'));
      if (
        !uuid.test(identity.machineId) ||
        typeof identity.machineName !== 'string' ||
        !identity.machineName.trim() ||
        identity.machineName.length > 200
      )
        throw new Error(tr('server.une_erreur_est_survenue'));
    } catch (error) {
      // Never silently replace an existing identity or expose file parsing details.
      if (error.code !== 'ENOENT') throw new Error(tr('server.une_erreur_est_survenue'));
      identity = { machineId: randomUUID(), machineName: hostname().slice(0, 200) };
    }
    if (machineName !== undefined) {
      if (typeof machineName !== 'string' || !machineName.trim() || machineName.length > 200)
        throw new Error(tr('server.la_demande_json_est_invalide'));
      identity.machineName = machineName.trim();
    }
    await writeFile(temporary, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    return {
      apiVersion: 1,
      machineId: identity.machineId,
      machineName: identity.machineName,
      studioVersion,
      capabilities: ['summary', 'download-range', 'roadmap-delegation'],
    };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    await unlock();
  }
}
