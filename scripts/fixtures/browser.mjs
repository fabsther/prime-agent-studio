// Shared Playwright browser selection for Studio UI tests.
// Honors PRIME_STUDIO_TEST_BROWSER when set (use "chromium" for the bundled
// build, otherwise a channel name such as "msedge" or "chrome").
// Without an explicit choice, tries the requested channel first (when the
// caller hardcodes one) then installed browsers in order: msedge, chrome,
// then the bundled chromium. This keeps Edge machines on Edge while letting
// Edge-less machines (Chrome only) run headless.
import { chromium } from '@playwright/test';

function studioOverrides() {
  const env = (process.env.PRIME_STUDIO_TEST_BROWSER || '').trim();
  if (!env) return null;
  if (env === 'chromium') return { bundled: true };
  return { channel: env };
}

export async function launchStudioBrowser(options = {}) {
  const override = studioOverrides();
  if (override) {
    const { channel: _ignored, ...rest } = options;
    if (override.bundled) return chromium.launch({ headless: true, ...rest });
    return chromium.launch({ channel: override.channel, headless: true, ...rest });
  }
  const { channel, ...rest } = options;
  const order = [];
  if (channel) order.push(channel);
  for (const fallback of ['msedge', 'chrome']) if (!order.includes(fallback)) order.push(fallback);
  for (const name of order) {
    try {
      return await chromium.launch({ channel: name, headless: true, ...rest });
    } catch {
      // Try the next installed browser.
    }
  }
  return chromium.launch({ headless: true, ...rest });
}

export async function launchStudioPersistentContext(dir, options = {}) {
  const override = studioOverrides();
  if (override) {
    const { channel: _ignored, ...rest } = options;
    if (override.bundled)
      return chromium.launchPersistentContext(dir, { headless: true, ...rest });
    return chromium.launchPersistentContext(dir, { channel: override.channel, headless: true, ...rest });
  }
  const { channel, ...rest } = options;
  const order = [];
  if (channel) order.push(channel);
  for (const fallback of ['msedge', 'chrome']) if (!order.includes(fallback)) order.push(fallback);
  for (const name of order) {
    try {
      return await chromium.launchPersistentContext(dir, { channel: name, headless: true, ...rest });
    } catch {
      // Try the next installed browser.
    }
  }
  return chromium.launchPersistentContext(dir, { headless: true, ...rest });
}
