// Read-only subscription quota: OpenAI/Codex (ChatGPT backend) and Claude (Anthropic OAuth).
// Fixed endpoints only. No redemption, purchase or account mutation here.
// Upstream schemas are snake_case (wham/usage, oauth/usage), never app-server camelCase.
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_USAGE_TIMEOUT_MS = 10000;
export const CODEX_USAGE_MAX_BYTES = 256 * 1024;
const WEEKLY_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const finiteNumber = (value) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
};
const percent = (value) => {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  return Math.min(100, Math.max(0, number));
};
const epochMs = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!Number.isFinite(Number(trimmed))) {
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  const number = finiteNumber(value);
  if (number === undefined || number <= 0) return undefined;
  return number < 10_000_000_000 ? number * 1000 : number;
};
const cleanPlan = (value, limit = 80) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) || undefined : undefined;

function resetMs(source, now) {
  const direct = epochMs(source.reset_at ?? source.resets_at);
  if (direct !== undefined) return direct;
  const after = finiteNumber(source.reset_after_seconds ?? source.reset_in_seconds);
  if (after !== undefined && after >= 0 && after <= 366 * 24 * 60 * 60) return now + Math.round(after * 1000);
  return undefined;
}

function usageWindow(value, fallbackWindowSeconds, now = Date.now()) {
  const source = record(value);
  const used = percent(source.used_percent ?? source.utilization);
  const resetAt = resetMs(source, now);
  if (used === undefined) return undefined;
  const windowSeconds = finiteNumber(source.limit_window_seconds) ?? fallbackWindowSeconds;
  const safeWindow =
    windowSeconds !== undefined && Number.isFinite(windowSeconds) && windowSeconds > 0 && windowSeconds <= 366 * 24 * 60 * 60
      ? Math.round(windowSeconds)
      : undefined;
  return {
    usedPercent: used,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(safeWindow !== undefined ? { windowSeconds: safeWindow } : {}),
  };
}

export function parseCodexUsageBody(body, now = Date.now()) {
  const source = record(body);
  const rateLimit = record(source.rate_limit);
  const primary = usageWindow(rateLimit.primary_window, 5 * 60 * 60, now);
  const secondary = usageWindow(rateLimit.secondary_window, 7 * 24 * 60 * 60, now);
  if (!primary && !secondary) return null;
  let shortWindow = primary || undefined;
  let weeklyWindow = secondary || undefined;
  if (primary && secondary) {
    const p = primary.windowSeconds;
    const s = secondary.windowSeconds;
    if (p !== undefined && s !== undefined && p > s) {
      shortWindow = secondary;
      weeklyWindow = primary;
    } else {
      shortWindow = primary;
      weeklyWindow = secondary;
    }
  } else if (primary && !secondary) {
    if ((primary.windowSeconds ?? 0) >= WEEKLY_THRESHOLD_SECONDS) {
      shortWindow = undefined;
      weeklyWindow = primary;
    } else {
      shortWindow = primary;
      weeklyWindow = undefined;
    }
  } else if (!primary && secondary) {
    if ((secondary.windowSeconds ?? 0) >= WEEKLY_THRESHOLD_SECONDS) {
      shortWindow = undefined;
      weeklyWindow = secondary;
    } else {
      shortWindow = secondary;
      weeklyWindow = undefined;
    }
  }
  const creditsSource = record(source.credits);
  const balanceRaw = creditsSource.balance;
  const balance =
    typeof balanceRaw === 'string' || typeof balanceRaw === 'number'
      ? String(balanceRaw).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) || undefined
      : undefined;
  return {
    plan: cleanPlan(source.plan_type),
    limitReached: typeof rateLimit.limit_reached === 'boolean' ? rateLimit.limit_reached : undefined,
    short: shortWindow,
    weekly: weeklyWindow,
    credits: {
      ...(typeof creditsSource.has_credits === 'boolean' ? { hasCredits: creditsSource.has_credits } : {}),
      ...(typeof creditsSource.unlimited === 'boolean' ? { unlimited: creditsSource.unlimited } : {}),
      ...(balance !== undefined ? { balance } : {}),
    },
  };
}

export function parseClaudeUsageBody(body, now = Date.now()) {
  const source = record(body);
  const short = usageWindow(source.five_hour, 5 * 60 * 60, now);
  const weekly = usageWindow(source.seven_day, 7 * 24 * 60 * 60, now);
  return short || weekly ? { short, weekly } : null;
}

export function toPublicSnapshot(
  parsed,
  { fetchedAt = Date.now(), cached = false, provider = 'openai-codex' } = {},
) {
  if (!parsed) return { available: false, reason: 'unavailable', provider, fetchedAt, cached };
  const shape = (window) =>
    window
      ? {
          usedPercent: Math.round(window.usedPercent * 10) / 10,
          remainingPercent: Math.max(0, Math.round(100 - window.usedPercent)),
          ...(window.resetAt !== undefined ? { resetAt: window.resetAt } : {}),
          ...(window.windowSeconds !== undefined ? { windowSeconds: window.windowSeconds } : {}),
        }
      : null;
  return {
    available: true,
    provider,
    plan: parsed.plan,
    limitReached: parsed.limitReached,
    short: shape(parsed.short),
    weekly: shape(parsed.weekly),
    credits: parsed.credits && Object.keys(parsed.credits).length ? parsed.credits : undefined,
    fetchedAt,
    cached: cached === true,
  };
}

async function getJson(url, headers, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Usage endpoint returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    if (text.length > CODEX_USAGE_MAX_BYTES) throw new Error('Usage response too large.');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function checkToken(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16384) throw new Error('Missing access token.');
}

export async function fetchCodexUsage({ accessToken, accountId, fetchImpl = fetch, timeoutMs = CODEX_USAGE_TIMEOUT_MS } = {}) {
  checkToken(accessToken);
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  if (typeof accountId === 'string' && accountId && accountId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(accountId))
    headers['chatgpt-account-id'] = accountId;
  return getJson(CODEX_USAGE_URL, headers, fetchImpl, timeoutMs);
}

export async function fetchClaudeUsage({ accessToken, fetchImpl = fetch, timeoutMs = CODEX_USAGE_TIMEOUT_MS } = {}) {
  checkToken(accessToken);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  return getJson(CLAUDE_USAGE_URL, headers, fetchImpl, timeoutMs);
}
