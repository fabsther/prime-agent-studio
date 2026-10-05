// Machines saved on this device for the PWA launcher. Shared by the browser and Node tests.
// Only addresses a Studio gateway can serve are accepted: Tailscale HTTPS names
// (*.ts.net through Serve) or private LAN / Tailscale IPv4 addresses over HTTP.
export const STORAGE_KEY = 'prime-studio.machines';
export const MAX_MACHINES = 24;
export const NAME_LIMIT = 60;
export const DEFAULT_PORT = 3089;
// Marks a switch from the list. The target page retries once from its own origin,
// so an existing SameSite=Strict session is sent after a cross-site arrival.
export const SWITCH_PARAM = 'from-machines';

// Same host rule as validatePwaOrigin in lib/pwa.mjs.
const TAILNET_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9-]+\.ts\.net$/;
function octets(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}
export function isTailscaleIPv4(host) {
  const parts = octets(host);
  return !!parts && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
export function isPrivateIPv4(host) {
  const parts = octets(host);
  return (
    !!parts &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}

/** Returns { origin, kind } for a supported Studio address, or null. Bare hosts are accepted. */
export function parseMachineAddress(input) {
  let text = typeof input === 'string' ? input.trim() : '';
  if (!text || text.length > 512) return null;
  // Tailscale names are served over HTTPS; IP addresses use the gateway HTTP port.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    text = (/^[^/?#:@]+\.ts\.net(?:[/?#]|$)/i.test(text) ? 'https://' : 'http://') + text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (url.protocol === 'https:')
    return TAILNET_HOST.test(host) && !url.port ? { origin: url.origin, kind: 'https' } : null;
  if (url.protocol !== 'http:') return null;
  const kind = isTailscaleIPv4(host) ? 'tailscale' : isPrivateIPv4(host) ? 'lan' : null;
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  return kind && port >= 1024 ? { origin: `http://${host}:${port}`, kind } : null;
}

export const machineKind = (origin) => parseMachineAddress(origin)?.kind ?? null;

export function defaultMachineName(origin) {
  try {
    const { hostname, host } = new URL(origin);
    return hostname.endsWith('.ts.net')
      ? hostname.split('.')[0]
      : isPrivateIPv4(hostname) || isTailscaleIPv4(hostname)
        ? hostname
        : host;
  } catch {
    return '';
  }
}

export function cleanMachineName(value) {
  if (typeof value !== 'string') return '';
  // Control and bidirectional override characters could disguise a name.
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, NAME_LIMIT).join('').trim();
}

/** Reads the saved list. The current origin may be stored too, only to keep its name. */
export function loadMachines(storage, current = '') {
  let entries;
  try {
    entries = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
  const machines = [],
    seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const origin = typeof entry?.origin === 'string' ? entry.origin : '';
    if (!origin || seen.has(origin)) continue;
    if (origin !== current && parseMachineAddress(origin)?.origin !== origin) continue;
    seen.add(origin);
    machines.push({ origin, name: cleanMachineName(entry.name) });
    if (machines.length >= MAX_MACHINES) break;
  }
  return machines;
}

export function saveMachines(storage, machines) {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify(machines.slice(0, MAX_MACHINES).map(({ origin, name }) => ({ origin, name }))),
  );
}

export const hasOtherMachines = (machines, current) => machines.some((machine) => machine.origin !== current);

export const machineUrl = (origin, current) => (origin === current ? '/' : `${origin}/?${SWITCH_PARAM}=1`);
