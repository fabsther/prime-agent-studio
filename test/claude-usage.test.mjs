import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_USAGE_URL, fetchClaudeUsage, parseClaudeUsageBody, toPublicSnapshot } from '../lib/codex-usage.mjs';

test('Claude OAuth usage maps five_hour/seven_day, keeps a window without reset and sends the OAuth beta header', async () => {
  const now = Date.parse('2026-09-27T10:00:00Z');
  const body = {
    five_hour: { utilization: 37, resets_at: '2026-09-27T12:00:00Z' },
    seven_day: { utilization: 0, resets_at: null },
    seven_day_opus: { utilization: 5, resets_at: null },
  };
  const snapshot = toPublicSnapshot(parseClaudeUsageBody(body, now), { fetchedAt: now, provider: 'anthropic' });
  assert.equal(snapshot.provider, 'anthropic');
  assert.deepEqual(snapshot.short, { usedPercent: 37, remainingPercent: 63, resetAt: Date.parse('2026-09-27T12:00:00Z'), windowSeconds: 18000 });
  assert.deepEqual(snapshot.weekly, { usedPercent: 0, remainingPercent: 100, windowSeconds: 604800 });
  assert.equal(parseClaudeUsageBody({}, now), null);
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  assert.deepEqual(await fetchClaudeUsage({ accessToken: 'token', fetchImpl }), body);
  assert.equal(seen.url, CLAUDE_USAGE_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer token');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  await assert.rejects(
    fetchClaudeUsage({ accessToken: 'token', fetchImpl: async () => ({ ok: false, status: 429 }) }),
    { status: 429 },
  );
});
