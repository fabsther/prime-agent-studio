import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAccessSettings } from '../public/remote-access.js';

// Only the DOM operations used by this small settings panel and its text bindings.
class Node {
  constructor(tag = '', nodeType = 1) {
    this.tag = tag;
    this.nodeType = nodeType;
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
  }
  get firstChild() {
    return this.childNodes[0];
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(text) {
    this.replaceChildren(textNode(text));
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  querySelectorAll(tag) {
    return this.childNodes.flatMap((node) => [
      ...(node.tag === tag ? [node] : []),
      ...node.querySelectorAll(tag),
    ]);
  }
  addEventListener(name, callback) {
    (this.listeners[name] ||= []).push(callback);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    for (const callback of this.listeners.close || []) callback();
  }
  reset() {}
  focus() {}
}
function textNode(text) {
  const node = new Node('', 3);
  node.data = text;
  return node;
}
function fixture(api, remote = false) {
  const ids = [
    'remote-access-dialog',
    'remote-code-form',
    'remote-code-fields',
    'remote-code',
    'remote-code-confirmation',
    'remote-code-error',
    'remote-access-status',
    'show-remote-code',
    'open-remote-access',
    'save-remote-code',
    'settings-dialog',
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Node()]));
  globalThis.document = {
    getElementById: (id) => nodes[id],
    createElement: (tag) => new Node(tag),
    createTextNode: textNode,
  };
  globalThis.window = { confirm: () => true };
  createRemoteAccessSettings({ api, isRemote: () => remote, toast: () => {} });
  const section = nodes['remote-access-dialog'].firstChild;
  return {
    nodes,
    section,
    status: section.childNodes[1],
    list: section.childNodes[2],
    refresh: section.querySelectorAll('button')[0],
    open: () => nodes['open-remote-access'].onclick(),
    close: () => nodes['remote-access-dialog'].close(),
  };
}
const settle = () => new Promise(setImmediate);
const device = {
  deviceId: 'device/one',
  deviceName: '<b>Phone</b>',
  createdAt: '2026-10-01T10:00:00Z',
  lastUsedAt: null,
};

test('paired devices load, confirm, revoke, retry errors, and ignore stale/remote requests', async (t) => {
  const originalDocument = globalThis.document,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });
  const calls = [];
  let getDevices = async () => [device],
    failDelete = false;
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/remote-access') return { revision: 1, configured: true };
    if (path === '/api/fleet/devices') return getDevices();
    if (failDelete) throw new Error('delete failed');
    return { revoked: true };
  };
  const panel = fixture(api);
  await panel.open();
  await settle();
  assert.equal(panel.section.hidden, false);
  assert.equal(panel.list.childNodes.length, 1);
  assert.equal(panel.list.querySelectorAll('strong')[0].textContent, device.deviceName);
  assert.match(panel.list.textContent, /Dernier accès : Jamais/);
  assert.equal(panel.refresh.disabled, false);
  const revoke = panel.list.querySelectorAll('button')[0];
  window.confirm = () => false;
  await revoke.onclick();
  assert.equal(
    calls.some((call) => call.options?.method === 'DELETE'),
    false,
  );
  window.confirm = () => true;
  failDelete = true;
  await revoke.onclick();
  assert.equal(panel.list.childNodes.length, 1);
  assert.match(panel.status.textContent, /Impossible de révoquer/);
  assert.equal(revoke.disabled, false);
  failDelete = false;
  await revoke.onclick();
  assert.deepEqual(calls.at(-1), {
    path: '/api/fleet/devices/device%2Fone',
    options: { method: 'DELETE' },
  });
  assert.equal(panel.list.childNodes.length, 0);
  assert.equal(panel.status.textContent, 'Aucun appareil associé.');

  getDevices = async () => {
    throw new Error('load failed');
  };
  panel.refresh.onclick();
  await settle();
  assert.match(panel.status.textContent, /Impossible de charger/);
  assert.equal(panel.refresh.disabled, false);
  let resolveOld;
  getDevices = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  panel.refresh.onclick();
  assert.equal(panel.refresh.disabled, true);
  panel.close();
  getDevices = async () => [];
  await panel.open();
  await settle();
  resolveOld([device]);
  await settle();
  assert.equal(panel.list.childNodes.length, 0, 'a closed-dialog response cannot replace the new list');
  assert.equal(panel.refresh.disabled, false);

  const count = calls.length;
  const remotePanel = fixture(api, true);
  await remotePanel.open();
  assert.equal(remotePanel.section.hidden, true);
  assert.equal(calls.length, count, 'remote clients cannot load paired devices');
});
