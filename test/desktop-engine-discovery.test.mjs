import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultKernelRoot, desktopEngineDirs, discoverCli } from '../lib/agent.mjs';

test('discoverCli finds the engine bundled with the desktop app', async (t) => {
  const local = await mkdtemp(join(tmpdir(), 'desktop-engine-'));
  t.after(() => rm(local, { recursive: true, force: true }));
  const pkg = join(local, 'com.primeagent.studio', 'engine', 'prime-agent', '0.9.8-test');
  await mkdir(join(pkg, 'dist', 'bundle'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'prime-agent', version: '0.9.8', bin: 'dist/bundle/cli.js' }),
  );
  await writeFile(join(pkg, 'dist', 'bundle', 'cli.js'), '');
  await writeFile(join(pkg, 'dist', 'bundle', 'cli-node.js'), '');
  assert.deepEqual(desktopEngineDirs({ LOCALAPPDATA: local }), [pkg]);
  const found = discoverCli(undefined, { LOCALAPPDATA: local, APPDATA: join(local, 'none'), PATH: '' });
  assert.equal(found?.version, '0.9.8');
  assert.match(found.launchPath.replaceAll('\\', '/'), /cli-node\.js$/);
});

// A checkout with its own kernel keeps it; only checkouts without one fall back to the desktop kernel.
const ownKernel = existsSync(fileURLToPath(new URL('../.local/kernel-venv', import.meta.url)));
test(
  'defaultKernelRoot prefers the explicit setting, then the desktop kernel',
  { skip: ownKernel },
  async (t) => {
    const local = await mkdtemp(join(tmpdir(), 'desktop-kernel-'));
    t.after(() => rm(local, { recursive: true, force: true }));
    assert.equal(
      defaultKernelRoot({ PRIME_AGENT_GUI_KERNEL_ROOT: 'X:/kernel', LOCALAPPDATA: local }),
      'X:/kernel',
    );
    assert.equal(defaultKernelRoot({ LOCALAPPDATA: local }), undefined);
    const desktop = join(local, 'com.primeagent.studio');
    await mkdir(join(desktop, '.local'), { recursive: true });
    await writeFile(join(desktop, '.local', 'kernel-ready.json'), '{}');
    assert.equal(defaultKernelRoot({ LOCALAPPDATA: local }), desktop);
  },
);
