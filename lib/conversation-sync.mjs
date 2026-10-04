// Conversation sync over a passive object store (Cloudflare R2).
// Repository layout (all encrypted except repo.json):
//   repo.json               { version, salt, check }   passphrase verification
//   objects/<keyed hash>    packs of NEW session entries, or image blobs
//   refs/<deviceId>.json    one per machine: sessions -> packs + active leaf
// Each machine writes only its own ref and immutable objects: no locks needed.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { mergeEntries, parse, serialize } from './sync-merge.mjs';
import { r2Store } from './sync-store.mjs';
import { HttpError, cwdKey } from './store.mjs';
import { formatMessage as tr } from '../public/i18n-core.js';

const BLOB = '\u0000studio-blob:';
const CHECK = 'prime-agent-studio-sync-v1';
const derive = (master, label) => createHmac('sha256', master).update(label).digest();
const keysFrom = (master) => ({ enc: derive(master, 'enc'), mac: derive(master, 'mac') });
const objectId = (keys, data) => createHmac('sha256', keys.mac).update(data).digest('hex');
function seal(keys, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const body = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function unseal(keys, data) {
  const decipher = createDecipheriv('aes-256-gcm', keys.enc, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return gunzipSync(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
}
async function atomicWrite(file, data, mode) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.sync-tmp', data, mode ? { mode } : undefined);
  await rename(file + '.sync-tmp', file);
}
async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    return JSON.parse(line);
  } finally {
    await handle.close();
  }
}
const readJson = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

// Native image blocks become binary blobs stored once; key order is kept.
function extractImages(value, addBlob) {
  if (Array.isArray(value)) return value.map((v) => extractImages(v, addBlob));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [k, v] of Object.entries(value))
    copy[k] =
      k === 'data' && value.type === 'image' && typeof v === 'string' && v.length > 1024
        ? BLOB + addBlob(Buffer.from(v, 'base64'))
        : extractImages(v, addBlob);
  return copy;
}
async function restoreImages(value, getBlob) {
  if (Array.isArray(value)) return Promise.all(value.map((v) => restoreImages(v, getBlob)));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [k, v] of Object.entries(value))
    copy[k] =
      typeof v === 'string' && v.startsWith(BLOB)
        ? (await getBlob(v.slice(BLOB.length))).toString('base64')
        : await restoreImages(v, getBlob);
  return copy;
}
async function sessionFiles(dir, depth = 0) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, item.name);
    if (item.isDirectory() && depth < 2) out.push(...(await sessionFiles(path, depth + 1)));
    else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}
function parseUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new HttpError(400, tr('sync.err_url'));
  }
  const bucket = parsed.pathname.split('/').filter(Boolean)[0];
  if (parsed.protocol !== 'https:' || !bucket) throw new HttpError(400, tr('sync.err_url'));
  return { endpoint: parsed.origin, bucket, url: `${parsed.origin}/${bucket}` };
}

export function createConversationSync({
  dataDir,
  sessionDir,
  store,
  isSessionActive = () => false,
  objectStore,
}) {
  const configPath = join(dataDir, 'sync.json'),
    statePath = join(dataDir, 'sync-state.json'),
    devicePath = join(dataDir, 'sync-device.json');
  let running = null,
    lastSync = null,
    progress = null;

  const remote = (config) =>
    objectStore ||
    r2Store({
      ...parseUrl(config.url),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
  async function status() {
    const config = await readJson(configPath);
    lastSync ??= (await readJson(statePath))?.lastSync ?? null;
    return {
      configured: Boolean(config?.key),
      url: config?.url ?? null,
      accessKeyId: config?.accessKeyId ?? null,
      hasSecret: Boolean(config?.secretAccessKey),
      hasPassphrase: Boolean(config?.key),
      device: config?.device || hostname(),
      running: Boolean(running),
      progress: running ? progress : null,
      lastSync,
      ...(await sessionStates()),
    };
  }

  async function configure(body = {}) {
    if (running) throw new HttpError(409, tr('sync.err_busy'));
    const previous = (await readJson(configPath)) || {};
    const { url } = parseUrl(body.url);
    const accessKeyId = String(body.accessKeyId || '').trim();
    const secretAccessKey =
      String(body.secretAccessKey || '') || (url === previous.url ? previous.secretAccessKey : '');
    const passphrase = String(body.passphrase || '');
    const device =
      String(body.device || '')
        .trim()
        .slice(0, 60) || hostname();
    if (!accessKeyId || !secretAccessKey) throw new HttpError(400, tr('sync.err_keys'));
    if (passphrase && passphrase.length < 12) throw new HttpError(400, tr('sync.err_passphrase_short'));
    const config = {
      url,
      accessKeyId,
      secretAccessKey,
      device,
      // Stable per machine, kept when the configuration is forgotten: a new id
      // would re-upload everything and pull this PC's old ref as a stranger.
      deviceId: previous.deviceId || (await readJson(devicePath))?.id || randomUUID(),
      key: url === previous.url ? previous.key : undefined,
    };
    const target = remote(config);
    let repo;
    try {
      repo = await target.get('repo.json');
    } catch (error) {
      throw new HttpError(400, tr('sync.err_connect', { value1: error.message }));
    }
    repo = repo ? JSON.parse(repo.toString('utf8')) : null;
    if (passphrase) {
      if (!repo) {
        repo = { version: 1, salt: randomBytes(16).toString('base64') };
        const master = scryptSync(passphrase, Buffer.from(repo.salt, 'base64'), 32, {
          N: 1 << 15,
          maxmem: 64 << 20,
        });
        repo.check = createHmac('sha256', keysFrom(master).mac).update(CHECK).digest('hex');
        await target.put('repo.json', Buffer.from(JSON.stringify(repo)));
      }
      const master = scryptSync(passphrase, Buffer.from(repo.salt, 'base64'), 32, {
        N: 1 << 15,
        maxmem: 64 << 20,
      });
      if (createHmac('sha256', keysFrom(master).mac).update(CHECK).digest('hex') !== repo.check)
        throw new HttpError(400, tr('sync.err_passphrase_wrong'));
      config.key = master.toString('base64');
    } else if (!config.key) {
      throw new HttpError(400, tr('sync.err_passphrase_required'));
    }
    const kept = await readJson(statePath);
    if (kept && kept.url !== undefined && kept.url !== url) await rm(statePath, { force: true });
    await atomicWrite(devicePath, JSON.stringify({ id: config.deviceId }));
    await atomicWrite(configPath, JSON.stringify(config), 0o600);
    return status();
  }

  async function forget() {
    if (running) throw new HttpError(409, tr('sync.err_busy'));
    // Credentials only. Sync state stays so reconnecting the same bucket sends
    // only new entries; a different bucket resets it in configure().
    await rm(configPath, { force: true });
    lastSync = null;
    return status();
  }

  async function syncOnce(only = null) {
    const config = await readJson(configPath);
    if (!config?.key) throw new HttpError(400, tr('sync.err_not_configured'));
    const keys = keysFrom(Buffer.from(config.key, 'base64'));
    const target = remote(config);
    const raw = (await readJson(statePath)) || {};
    const state = {
      files: raw.files || {},
      leaf: raw.leaf || {},
      ids: raw.ids || {},
      mtime: raw.mtime || {},
      meta: raw.meta || {},
      fetched: new Set(raw.fetched || []),
      blobs: new Set(raw.blobs || []),
      known: Object.fromEntries(Object.entries(raw.known || {}).map(([k, v]) => [k, new Set(v)])),
    };
    const save = (extra = {}) =>
      atomicWrite(
        statePath,
        JSON.stringify({
          lastSync: raw.lastSync,
          ...extra,
          url: config.url,
          files: state.files,
          leaf: state.leaf,
          ids: state.ids,
          mtime: state.mtime,
          meta: state.meta,
          fetched: [...state.fetched],
          blobs: [...state.blobs],
          known: Object.fromEntries(Object.entries(state.known).map(([k, v]) => [k, [...v]])),
        }),
      );
    const projects = ((await store.overview()).projects || []).filter(
      (p) => p.sync !== false && p.exists !== false,
    );
    const byCwd = new Map(projects.map((p) => [cwdKey(p.cwd), p]));
    const byName = new Map(projects.map((p) => [p.name, p]));
    const report = { sent: 0, pushed: 0, received: 0, skipped: 0, errors: 0 };
    const put = async (key, data) => {
      await target.put(key, data);
      report.sent += data.length;
    };
    const fileInfo = async (path) => {
      const info = await stat(path);
      return {
        stamp: `${info.size}:${info.mtimeMs}`,
        mtime: info.mtime.getTime() /* same rounding as the overview updatedAt */,
      };
    };
    const relOf = (path) => relative(sessionDir, path).replaceAll('\\', '/');
    const sidOf = Object.fromEntries(Object.entries(state.ids).map(([sid, rel]) => [rel, sid]));
    const metaOf = (sid) => store.sessionMeta?.(sid) ?? { metaAt: 0 };

    // Push: new entries and metadata of synced, idle sessions.
    const refKey = `refs/${config.deviceId}.json`;
    const existing = await target.get(refKey);
    const ref = existing ? JSON.parse(unseal(keys, existing)) : { sessions: {} };
    ref.device = config.device;
    const before = JSON.stringify(ref);
    let files;
    if (only) {
      const known = state.ids[only] && join(sessionDir, ...state.ids[only].split('/'));
      const file = known || (await store.history?.(only)?.catch(() => null))?.file;
      files = file ? [file] : [];
    } else files = await sessionFiles(sessionDir);
    if (!only) progress = { phase: 'push', done: 0, total: files.length };
    for (const path of files) {
      if (!only) progress.done++;
      const rel = relOf(path);
      try {
        const { stamp, mtime } = await fileInfo(path);
        let knownSid = sidOf[rel];
        if (state.files[rel] === stamp && !knownSid) {
          // Unchanged file pushed by an older build: record its identity once so
          // its status reads as synced instead of pending.
          const header = await readHeader(path).catch(() => null);
          if (header?.type === 'session' && state.known[header.id]) {
            knownSid = header.id;
            state.ids[knownSid] = rel;
            state.mtime[knownSid] = mtime;
            state.meta[knownSid] ??= 0;
          }
        }
        if (
          state.files[rel] === stamp &&
          (!knownSid || metaOf(knownSid).metaAt <= (state.meta[knownSid] || 0))
        )
          continue;
        const first = await readHeader(path);
        const project = first?.type === 'session' && byCwd.get(cwdKey(first.cwd || ''));
        if (!project) continue;
        if (isSessionActive(first.id)) {
          report.skipped++;
          continue;
        }
        const [header, ...entries] = parse(await readFile(path, 'utf8'));
        const known = (state.known[header.id] ??= new Set());
        const fresh = entries.filter((e) => !known.has(e.id));
        const info = (ref.sessions[header.id] ??= { file: rel, packs: [] });
        info.project = project.name;
        info.header = { ...header, cwd: undefined };
        info.meta = metaOf(header.id);
        if (fresh.length) {
          const blobs = [];
          const packed = fresh.map((e) =>
            extractImages(e, (bin) => {
              const id = objectId(keys, bin);
              if (!state.blobs.has(id)) blobs.push([id, bin]);
              state.blobs.add(id);
              return id;
            }),
          );
          for (const [id, bin] of blobs) await put(`objects/${id}`, seal(keys, bin));
          const pack = Buffer.from(serialize(packed));
          const packId = objectId(keys, pack);
          await put(`objects/${packId}`, seal(keys, pack));
          info.packs.push(packId);
          for (const e of fresh) known.add(e.id);
          report.pushed += fresh.length;
        }
        info.leaf = entries.at(-1)?.id;
        state.leaf[header.id] = info.leaf;
        state.files[rel] = stamp;
        state.ids[header.id] = rel;
        state.mtime[header.id] = mtime;
        state.meta[header.id] = info.meta.metaAt;
      } catch {
        report.errors++;
      }
    }
    if (JSON.stringify(ref) !== before) await put(refKey, seal(keys, Buffer.from(JSON.stringify(ref))));

    // Pull: merge other machines' entries and newer metadata into synced projects.
    const getBlob = async (id) => unseal(keys, await target.get(`objects/${id}`));
    const others = [];
    for (const key of await target.list('refs/'))
      if (key !== refKey) others.push(JSON.parse(unseal(keys, await target.get(key))));
    const pairs = others.flatMap((o) =>
      Object.entries(o.sessions || {}).filter(([sid]) => !only || sid === only),
    );
    if (!only) progress = { phase: 'pull', done: 0, total: pairs.length };
    for (const [sid, info] of pairs) {
      if (!only) progress.done++;
      try {
        const project = byName.get(info.project);
        if (!project) continue;
        if (info.meta && (await store.applySessionMeta?.(sid, info.meta))) {
          state.meta[sid] = info.meta.metaAt;
          report.received++;
        }
        const packs = info.packs.filter((p) => !state.fetched.has(p));
        if (!packs.length && state.leaf[sid] === info.leaf) continue;
        if (isSessionActive(sid)) {
          report.skipped++;
          continue;
        }
        const path = join(sessionDir, ...info.file.split('/'));
        let local,
          stamp = null;
        try {
          stamp = (await fileInfo(path)).stamp;
          local = parse(await readFile(path, 'utf8'));
        } catch {
          local = [{ ...info.header, cwd: project.cwd }];
        }
        const incoming = [];
        for (const pack of packs)
          for (const e of parse(unseal(keys, await target.get(`objects/${pack}`)).toString('utf8')))
            incoming.push(await restoreImages(e, getBlob));
        const merged = mergeEntries(local, incoming, info.leaf);
        const changed = merged.added || !stamp || merged.entries.at(-1)?.id !== local.at(-1)?.id;
        if (changed) {
          // Never overwrite a file that changed while we were merging.
          if (stamp && (await fileInfo(path)).stamp !== stamp) {
            report.skipped++;
            continue;
          }
          await atomicWrite(path, serialize(merged.entries));
        }
        for (const pack of packs) state.fetched.add(pack);
        const known = (state.known[sid] ??= new Set());
        for (const e of incoming) known.add(e.id);
        state.leaf[sid] = merged.entries.at(-1)?.id;
        const after = await fileInfo(path);
        state.files[relOf(path)] = after.stamp;
        state.ids[sid] = relOf(path);
        state.mtime[sid] = after.mtime;
        report.received += merged.added;
      } catch {
        report.errors++;
      }
    }
    const result = {
      at: new Date().toISOString(),
      ok: report.errors === 0,
      ...report,
      ...(report.errors ? { error: tr('sync.err_partial', { value1: report.errors }) } : {}),
    };
    if (!only) lastSync = result;
    await save(only ? {} : { lastSync });
    return result;
  }

  // One sync at a time: a full run, or a quick check of one conversation.
  let lock = Promise.resolve();
  function exclusive(task) {
    const next = lock.then(task, task);
    lock = next.catch(() => {});
    return next;
  }

  // Per-conversation state from the cached overview: no extra file reads.
  async function sessionStates() {
    const config = await readJson(configPath);
    if (!config?.key) return { sessions: {}, pending: 0 };
    const raw = (await readJson(statePath)) || {};
    const sessions = {};
    let pending = 0;
    for (const p of (await store.overview()).projects || []) {
      if (p.sync === false || p.exists === false) continue;
      for (const s of p.sessions || []) {
        const synced =
          raw.mtime?.[s.id] === Date.parse(s.updatedAt) &&
          (store.sessionMeta?.(s.id).metaAt || 0) <= (raw.meta?.[s.id] || 0);
        sessions[s.id] = synced ? 'synced' : 'pending';
        if (!synced) pending++;
      }
    }
    return { sessions, pending };
  }

  async function checkSession(id) {
    const config = await readJson(configPath);
    if (!config?.key) return { state: 'unconfigured', changed: false };
    if (running) return { state: 'busy', changed: false };
    const owner = ((await store.overview()).projects || []).find((p) =>
      (p.sessions || []).some((s) => s.id === id),
    );
    if (owner && owner.sync === false) return { state: 'off', changed: false };
    if (isSessionActive(id))
      return { state: (await sessionStates()).sessions[id] || 'pending', changed: false };
    const result = await exclusive(() => syncOnce(id));
    return {
      state: (await sessionStates()).sessions[id] || (owner ? 'pending' : 'synced'),
      changed: result.received > 0,
    };
  }

  async function run() {
    running ??= exclusive(() => syncOnce())
      .catch(async (error) => {
        lastSync = {
          at: new Date().toISOString(),
          ok: false,
          error: error.message,
          sent: 0,
          pushed: 0,
          received: 0,
        };
        const raw = (await readJson(statePath)) || {};
        await atomicWrite(statePath, JSON.stringify({ ...raw, lastSync })).catch(() => {});
        throw error;
      })
      .finally(() => {
        running = null;
      });
    await running;
    return status();
  }
  return { status, configure, forget, run, checkSession };
}
