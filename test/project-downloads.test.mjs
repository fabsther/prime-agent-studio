import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, open, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';
import { downloadContentType, downloadLimit, parseDownloadRange } from '../lib/project-downloads.mjs';
import { createLanGateway, hashAccessCode } from '../lib/lan.mjs';

function http(port, path, { method = 'GET', headers = {}, body, countOnly = false } = {}) {
  return new Promise((done, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      let bytes = 0,
        maxChunk = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        maxChunk = Math.max(maxChunk, chunk.length);
        if (!countOnly) chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () =>
        done({
          status: res.statusCode,
          headers: res.headers,
          bytes,
          maxChunk,
          text: countOnly ? undefined : Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(t, { gateway = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-downloads-'));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const app = createApp({
    agentHome: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    dataDir: join(root, 'data'),
    initialCwd: cwd,
    runtime: {
      getStatus: async () => ({ available: true }),
      getModels: async () => ({ models: [] }),
      close: async () => {},
    },
  });
  let remote;
  // Register cleanup before any bind/configuration can fail.
  t.after(async () => {
    if (remote?.listening) {
      remote.closeAllConnections();
      await new Promise((done) => remote.close(done));
    }
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  const port = app.server.address().port;
  if (gateway) {
    const salt = 'e54d6dd09bb15f7c347b38b671472aa9';
    remote = createLanGateway({
      host: '127.0.0.1',
      port: 0,
      upstreamPort: port,
      config: { salt, codeHash: hashAccessCode('49283175', salt), readOnly: true },
    });
    await new Promise((done) => remote.listen(0, '127.0.0.1', done));
  }
  const path = (name = 'outputs/report.pdf', route = 'download') =>
    `/api/project-files/${route}?${new URLSearchParams({ cwd, path: name })}`;
  return { root, cwd, path, port, remote, api: (url, options) => http(port, url, options) };
}

async function report(f) {
  await mkdir(join(f.cwd, 'outputs'));
  await writeFile(join(f.cwd, 'outputs/report.pdf'), '0123456789');
}

test('download range parser accepts bounded and open ranges and rejects unsupported/invalid ranges', () => {
  assert.equal(parseDownloadRange(undefined, 10), undefined);
  assert.deepEqual(parseDownloadRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseDownloadRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(parseDownloadRange('bytes=2-99', 10), { start: 2, end: 9 });
  for (const value of [
    'bytes=-3',
    'bytes=5-2',
    'bytes=10-',
    'bytes=0-1,4-5',
    'bytes=x-1',
    'items=0-1',
    'bytes=9007199254740992-',
  ])
    assert.equal(parseDownloadRange(value, 10), null, value);
  assert.equal(parseDownloadRange('bytes=0-', 0), null);
  assert.equal(downloadLimit(undefined), 2 * 1024 ** 3);
  for (const value of ['', '0', '-1', 'NaN', '1.5', '9007199254740992'])
    assert.equal(downloadLimit(value), 2 * 1024 ** 3);
  assert.equal(downloadLimit('1234'), 1234);
  for (const ext of ['pdf', 'png', 'jpg', 'zip', 'mp4', 'docx', 'xlsx', 'md', 'txt'])
    assert.notEqual(downloadContentType(`file.${ext}`), 'application/octet-stream');
  assert.equal(downloadContentType('unknown.xyz'), 'application/octet-stream');
});

test(
  'download HTTP supports 206, 416, If-Range, MIME, attachment and HEAD',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await report(f);
    const full = await f.api(f.path());
    assert.equal(full.status, 200);
    assert.equal(full.text, '0123456789');
    assert.equal(full.headers['content-type'], 'application/pdf');
    assert.equal(full.headers['accept-ranges'], 'bytes');
    assert.match(full.headers['content-disposition'], /^attachment;/);
    assert.match(full.headers.etag, /^"[a-f0-9]+-[a-f0-9]+"$/);
    const part = await f.api(f.path(), { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.text, '2345');
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal(part.headers['content-length'], '4');
    assert.equal((await f.api(f.path(), { headers: { Range: 'bytes=7-' } })).text, '789');
    for (const range of ['bytes=10-', 'bytes=8-2', 'invalid', 'bytes=0-1,5-6']) {
      const invalid = await f.api(f.path(), { headers: { Range: range } });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers['content-range'], 'bytes */10');
      assert.equal(invalid.bytes, 0);
    }
    for (const condition of [full.headers.etag, full.headers['last-modified']])
      assert.equal(
        (await f.api(f.path(), { headers: { Range: 'bytes=2-5', 'If-Range': condition } })).status,
        206,
      );
    for (const condition of ['"stale"', `W/${full.headers.etag}`, 'Thu, 01 Jan 1970 00:00:00 GMT', 'invalid'])
      assert.equal(
        (await f.api(f.path(), { headers: { Range: 'bytes=2-5', 'If-Range': condition } })).status,
        200,
      );
    const head = await f.api(f.path(), { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.headers.etag, full.headers.etag);
    assert.equal(head.bytes, 0);
    await writeFile(join(f.cwd, 'empty.txt'), '');
    assert.equal((await f.api(f.path('empty.txt'))).bytes, 0);
    assert.equal((await f.api(f.path('empty.txt'), { headers: { Range: 'bytes=0-' } })).status, 416);
  },
);

test(
  'downloads stream a file over 60 MiB over HTTP without whole-file Buffer allocations, locally and through gateway',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { gateway: true });
    const size = 64 * 1024 * 1024 + 17;
    const handle = await open(join(f.cwd, 'large.zip'), 'w');
    await handle.truncate(size);
    await handle.close();
    const login = await http(f.remote.address().port, '/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=49283175',
    });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const alloc = Buffer.alloc;
    Buffer.alloc = (length, ...args) => {
      assert.ok(length < 1024 * 1024, `Unexpected full-file allocation: ${length}`);
      return alloc(length, ...args);
    };
    try {
      for (const port of [f.port, f.remote.address().port]) {
        const result = await http(port, f.path('large.zip'), {
          headers: { Cookie: cookie },
          countOnly: true,
        });
        assert.equal(result.status, 200);
        assert.equal(result.bytes, size);
        assert.ok(result.maxChunk <= 1024 * 1024);
      }
    } finally {
      Buffer.alloc = alloc;
    }
  },
);

test(
  'read-only gateway forwards Range and If-Range and passes response headers, status and HEAD',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { gateway: true });
    await report(f);
    const port = f.remote.address().port;
    assert.equal((await http(port, f.path(), { method: 'HEAD' })).status, 401);
    const login = await http(port, '/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=49283175',
    });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const head = await http(port, f.path(), { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.bytes, 0);
    const part = await http(port, f.path(), {
      headers: { Cookie: cookie, Range: 'bytes=3-6', 'If-Range': head.headers.etag },
    });
    assert.equal(part.status, 206);
    assert.equal(part.text, '3456');
    assert.equal(part.headers['content-range'], 'bytes 3-6/10');
    assert.equal(part.headers.etag, head.headers.etag);
    assert.equal(part.headers['accept-ranges'], 'bytes');
    assert.equal(
      (await http(port, f.path(), { headers: { Cookie: cookie, Range: 'bytes=10-' } })).status,
      416,
    );
    assert.equal(
      (await http(port, f.path(), { headers: { Cookie: cookie, Range: 'bytes=3-6', 'If-Range': '"stale"' } }))
        .status,
      200,
    );
    const recent = await http(port, f.path('', 'recent-outputs'), { headers: { Cookie: cookie } });
    assert.equal(recent.status, 200);
    assert.equal(JSON.parse(recent.text)[0].path, 'outputs/report.pdf');
    assert.equal(
      (await http(port, '/api/projects/pick-directory', { method: 'HEAD', headers: { Cookie: cookie } }))
        .status,
      404,
    );
  },
);

test(
  'download retains path guards and applies the configurable size limit before reading',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await report(f);
    const oldLimit = process.env.STUDIO_DOWNLOAD_LIMIT_BYTES;
    process.env.STUDIO_DOWNLOAD_LIMIT_BYTES = '9';
    try {
      assert.equal((await f.api(f.path())).status, 413);
      assert.equal((await f.api(f.path(), { method: 'HEAD' })).status, 413);
    } finally {
      if (oldLimit === undefined) delete process.env.STUDIO_DOWNLOAD_LIMIT_BYTES;
      else process.env.STUDIO_DOWNLOAD_LIMIT_BYTES = oldLimit;
    }
    for (const path of ['../outside.pdf', '.git/config', 'node_modules/a', 'file:ads', 'outputs'])
      assert.ok((await f.api(f.path(path))).status >= 400, path);
    await symlink(f.root, join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(f.root, 'outside.pdf'), 'outside');
    assert.equal((await f.api(f.path('escape/outside.pdf'))).status, 403);
    await mkdir(join(f.cwd, 'private'));
    await writeFile(join(f.cwd, 'private/auth.json'), 'private');
    const files = createProjectFiles({
      store: { findProject: async () => ({ cwd: f.cwd }) },
      protectedRoots: [join(f.cwd, 'private')],
    });
    await assert.rejects(files.download(f.cwd, 'private/auth.json'), { status: 403 });
  },
);

test(
  'recent outputs return the newest 50 regular files under the project, excluding hidden, blocked, protected and symlink directories',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await report(f);
    for (const folder of ['.hidden', 'node_modules', 'private', 'nested']) await mkdir(join(f.cwd, folder));
    for (const path of ['.hidden/secret.pdf', 'node_modules/report.pdf', 'private/auth.json', '.secret'])
      await writeFile(join(f.cwd, path), 'private');
    await symlink(f.root, join(f.cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (let i = 0; i < 55; i++) {
      const name = join(f.cwd, 'nested', `file-${i}.txt`);
      await writeFile(name, `${i}`);
      const date = new Date(Date.now() + i * 1000);
      await utimes(name, date, date);
    }
    const files = createProjectFiles({
      store: { findProject: async () => ({ cwd: f.cwd }) },
      protectedRoots: [join(f.cwd, 'private')],
    });
    const { files: recent, partial } = await files.recentOutputs(f.cwd);
    assert.equal(partial, false);
    assert.equal(recent.length, 50);
    assert.equal(recent[0].path, 'nested/file-54.txt');
    assert.equal(recent[49].path, 'nested/file-5.txt');
    assert.equal(recent[0].size, 2);
    assert.ok(
      recent.every((file) => file.path.startsWith('nested/') && Number.isFinite(file.modifiedAt)),
    );
    assert.equal((await f.api(f.path('', 'recent-outputs'))).status, 200);
  },
);

test(
  'recent outputs report a cut scan with a header while preserving the array contract',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { gateway: true });
    await report(f);
    const remotePort = f.remote.address().port;
    const login = await http(remotePort, '/lan/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'code=49283175',
    });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const now = Date.now;
    let ticks = 0;
    Date.now = () => now() + ++ticks * 3000;
    try {
      for (const port of [f.port, remotePort]) {
        const result = await http(port, f.path('', 'recent-outputs'), { headers: { Cookie: cookie } });
        assert.equal(result.status, 200);
        assert.equal(result.headers['x-studio-outputs-partial'], 'true');
        assert.deepEqual(JSON.parse(result.text), []);
      }
    } finally {
      Date.now = now;
    }
  },
);
