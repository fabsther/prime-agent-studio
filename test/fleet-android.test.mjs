import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const android = new URL('../android/', import.meta.url);
const read = (path) => readFile(new URL(path, android), 'utf8');

test('Android summary fixture follows Fleet v1 machine/project/session contract', async () => {
  const summary = JSON.parse(await read('app/src/test/resources/summary.json'));
  assert.equal(summary.machine.apiVersion, 1);
  assert.equal(typeof summary.generatedAt, 'number');
  assert.deepEqual(summary.machine.capabilities, ['summary', 'download-range', 'roadmap-delegation']);
  const project = summary.projects[0];
  assert.equal(project.git.originKey, 'github.com/example/prime');
  assert.equal(typeof project.git.dirty, 'boolean');
  assert.equal(project.sessions[0].roadmapLink.ownerMachineId, 'b');
  assert.equal(project.sessions[0].agents[0].parentId, null);
  assert.equal(summary.projects[1].git, null);
});

test('Android French and English string resource names stay aligned', async () => {
  const keys = async (language) => {
    const directory = new URL(`app/src/main/res/${language}/`, android);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.xml'));
    const documents = await Promise.all(files.map((file) => readFile(new URL(file, directory), 'utf8')));
    return documents
      .flatMap((text) => [...text.matchAll(/<string\s+name="([^"]+)"/g)].map((match) => match[1]))
      .sort();
  };
  const french = await keys('values');
  assert.ok(french.length > 10);
  assert.deepEqual(french, await keys('values-en'));
  assert.equal(new Set(french).size, french.length);
});

test('Android wrapper is pinned and credentials are excluded from backup', async () => {
  const wrapper = await read('gradle/wrapper/gradle-wrapper.properties');
  assert.match(wrapper, /gradle-9\.6\.1-bin\.zip/);
  assert.match(wrapper, /distributionSha256Sum=[a-f0-9]{64}/);
  const manifest = await read('app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(await read('app/build.gradle.kts'), /minSdk = 26/);
});
