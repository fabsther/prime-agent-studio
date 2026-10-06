import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '../scripts/launcher-common.mjs';
import { HttpError } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const hash = (token) => createHash('sha256').update(token).digest('hex');
const invalid = () => new HttpError(400, tr('server.la_demande_json_est_invalide'));
const publicDevice = ({ deviceId, deviceName, createdAt, lastUsedAt }) => ({
  deviceId,
  deviceName,
  createdAt,
  lastUsedAt,
});

export function createFleetDevices({ dataDir, identity }) {
  const file = join(dataDir, 'fleet-devices.json'),
    listeners = new Set(),
    used = new Map();
  async function read() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw invalid();
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (
        data.schema !== 1 ||
        !Array.isArray(data.devices) ||
        data.devices.length > 64 ||
        data.devices.some(
          (d) =>
            !/^[a-f0-9-]{36}$/.test(d.deviceId) ||
            !/^[a-f0-9]{64}$/.test(d.tokenHash) ||
            typeof d.deviceName !== 'string' ||
            d.deviceName.length > 80 ||
            !Number.isFinite(d.createdAt),
        )
      )
        throw invalid();
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, devices: [] };
      throw error;
    }
  }
  async function mutate(fn) {
    await mkdir(dataDir, { recursive: true });
    const unlock = await acquireLock({ lock: join(dataDir, 'fleet-devices.lock') }, { timeout: 5000 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const data = await read(),
        result = fn(data);
      await writeFile(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      return result;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await unlock();
    }
  }
  async function pair(deviceName) {
    if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80) throw invalid();
    const machine = await identity();
    const deviceId = randomUUID(),
      token = randomBytes(32).toString('base64url');
    await mutate((data) => {
      if (data.devices.length >= 64) throw new HttpError(429, tr('passkeys.retry'));
      data.devices.push({
        deviceId,
        deviceName: deviceName.trim(),
        tokenHash: hash(token),
        createdAt: Date.now(),
        lastUsedAt: null,
      });
    });
    return { deviceId, token, machineId: machine.machineId, machineName: machine.machineName };
  }
  async function authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = Buffer.from(hash(token), 'hex');
    const device = (await read()).devices.find((d) =>
      timingSafeEqual(digest, Buffer.from(d.tokenHash, 'hex')),
    );
    if (!device) return null;
    used.set(device.deviceId, Date.now());
    return device.deviceId;
  }
  async function list() {
    return (await read()).devices.map((d) =>
      publicDevice({ ...d, lastUsedAt: used.get(d.deviceId) ?? d.lastUsedAt ?? null }),
    );
  }
  async function revoke(deviceId) {
    if (typeof deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(deviceId)) throw invalid();
    await mutate((data) => {
      data.devices = data.devices.filter((d) => d.deviceId !== deviceId);
    });
    used.delete(deviceId);
    for (const listener of listeners) listener(deviceId);
    return { revoked: true };
  }
  return {
    pair,
    authenticate,
    list,
    revoke,
    onRevoked(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
