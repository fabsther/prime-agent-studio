import { t as tr, bindText, translateKnown, onLanguageChange, getLanguage } from './i18n.js';

// R2 conversation sync panel (Preferences > Synchronisation).
// Local only: the host hides the tab when remote or readOnly.
// Secrets are write only: the server never echoes them back and the
// inputs are cleared after every load and save.
//
// Shared monitor: one poller for the whole Studio (footer, badges, header
// and Preferences). GET /api/sync every 30 s, every 2 s while running.
// Paused when the document is hidden. app.js starts it once with
// initSyncMonitor({ api, getContext }); the panel subscribes to it.

let sharedApi = null;
let sharedGetContext = null;
let sharedData = null;
let sharedListeners = new Set();
let sharedTimer = 0;
let sharedInFlight = false;
let sharedStarted = false;

function sharedAllowed() {
  try {
    const ctx = sharedGetContext?.();
    if (!ctx) return true;
    return !ctx.remote && !ctx.readOnly;
  } catch {
    return true;
  }
}

function notifyShared() {
  for (const fn of [...sharedListeners]) {
    try {
      fn(sharedData);
    } catch {}
  }
}

function scheduleShared() {
  if (!sharedStarted) return;
  if (sharedTimer) clearTimeout(sharedTimer);
  sharedTimer = 0;
  if (typeof document !== 'undefined' && document.hidden) return;
  const delay = sharedData?.running ? 2000 : 30000;
  sharedTimer = setTimeout(() => void fetchShared(), delay);
}

async function fetchShared() {
  if (!sharedStarted) return;
  if (typeof document !== 'undefined' && document.hidden) {
    scheduleShared();
    return;
  }
  if (!sharedApi || !sharedAllowed()) {
    scheduleShared();
    return;
  }
  if (sharedInFlight) return;
  sharedInFlight = true;
  try {
    const next = await sharedApi('/api/sync');
    sharedData = next;
    notifyShared();
  } catch {
    // Keep the last known state; the next tick retries quietly.
  } finally {
    sharedInFlight = false;
    scheduleShared();
  }
}

export function getSyncSnapshot() {
  return sharedData;
}

export function subscribeSync(listener) {
  sharedListeners.add(listener);
  if (sharedData) {
    try {
      listener(sharedData);
    } catch {}
  }
  return () => sharedListeners.delete(listener);
}

export function initSyncMonitor({ api, getContext } = {}) {
  if (api) sharedApi = api;
  if (getContext) sharedGetContext = getContext;
  if (sharedStarted) {
    scheduleShared();
    return;
  }
  sharedStarted = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (sharedTimer) clearTimeout(sharedTimer);
        sharedTimer = 0;
      } else {
        void fetchShared();
      }
    });
  }
  void fetchShared();
}

export function refreshSyncNow() {
  return fetchShared();
}

export function setSyncSnapshot(data) {
  sharedData = data;
  notifyShared();
  scheduleShared();
}

export function patchSyncSession(id, syncState) {
  if (!sharedData || !id) return;
  const sessions = { ...(sharedData.sessions || {}) };
  if (syncState === 'synced' || syncState === 'pending') sessions[id] = syncState;
  else delete sessions[id];
  sharedData = { ...sharedData, sessions };
  notifyShared();
}

// Badge for a project folder. Returns 'synced', 'pending', 'syncing',
// 'error' or null (no badge: sync off, unconfigured, opted out, missing).
export function projectSyncState(project, snapshot = sharedData) {
  if (!snapshot?.configured) return null;
  if (!project || project.sync === false) return null;
  if (project.exists === false) return null;
  if (snapshot.running) return 'syncing';
  const last = snapshot.lastSync;
  if (last && last.ok === false) return 'error';
  const map = snapshot.sessions || {};
  for (const s of project.sessions || []) {
    if (!s?.id) continue;
    const st = map[s.id];
    if (st === 'pending') return 'pending';
    if (st !== 'synced') return 'pending';
  }
  return 'synced';
}

export function createSyncSettings({ api, getContext, toast }) {
  const $ = (id) => document.getElementById(id);
  const form = $('sync-form');
  const content = $('sync-content');
  if (!form || !content) return { refresh: async () => {} };
  initSyncMonitor({ api, getContext });
  let data = sharedData;
  let busy = false;
  let running = false;
  let generation = 0;

  const allowed = () => !getContext().remote && !getContext().readOnly;

  const showError = (message = '') => {
    const node = $('sync-error');
    node.hidden = !message;
    bindText(node, () => (message ? translateKnown(message) : ''));
  };

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'fr-FR');
    } catch {
      return String(iso || '');
    }
  }

  function statusText() {
    if (!data) return tr('sync.loading');
    if (data.running) {
      const p = data.progress;
      return p?.total
        ? tr(p.phase === 'pull' ? 'sync.progress_pull' : 'sync.progress_push', {
            value1: String(p.done),
            value2: String(p.total),
          })
        : tr('sync.running');
    }
    const last = data.lastSync;
    if (!last) return data.configured ? tr('sync.never') : tr('sync.not_configured');
    const when = formatDate(last.at);
    if (last.ok)
      return tr('sync.last_ok', {
        value1: when,
        value2: formatBytes(last.sent),
        value3: String(last.received ?? 0),
        value4: String(last.pushed ?? 0),
      });
    return tr('sync.last_error', {
      value1: when,
      value2: translateKnown(last.error || ''),
    });
  }

  function renderStatus() {
    const node = $('sync-status');
    bindText(node, () => statusText());
    const last = data?.lastSync;
    node.dataset.state = data?.running ? 'running' : last && !last.ok ? 'error' : 'idle';
  }

  function render() {
    if (!data) return;
    const active = document.activeElement;
    const typing = (id) => active && active.id === id;
    if (!typing('sync-url')) $('sync-url').value = data.url || '';
    if (!typing('sync-access-key')) $('sync-access-key').value = data.accessKeyId || '';
    // Never echo secrets back into the inputs.
    if (!typing('sync-secret')) $('sync-secret').value = '';
    if (!typing('sync-passphrase')) $('sync-passphrase').value = '';
    if (!typing('sync-device')) $('sync-device').value = data.device || '';
    $('sync-secret').placeholder = data.hasSecret ? tr('sync.secret_kept') : '';
    $('sync-passphrase').placeholder = data.hasPassphrase ? tr('sync.passphrase_kept') : '';
    $('sync-run').hidden = !data.configured;
    $('sync-forget').hidden = !data.configured;
    renderStatus();
  }

  function setBusy(value, mode) {
    busy = value;
    for (const id of ['sync-url', 'sync-access-key', 'sync-secret', 'sync-passphrase', 'sync-device'])
      $(id).disabled = value || !allowed();
    $('sync-save').disabled = value || !allowed();
    $('sync-run').disabled = value || !allowed() || !data?.configured;
    $('sync-forget').disabled = value || !allowed() || !data?.configured;
    $('sync-refresh').disabled = value;
    if (mode === 'run' || data?.running) {
      $('sync-save').disabled = true;
      $('sync-run').disabled = true;
    }
    if (value && mode) {
      bindText($('sync-save'), () => (mode === 'save' ? tr('common.saving') : tr('sync.save_test')));
      bindText($('sync-run'), () => (mode === 'run' ? tr('sync.running') : tr('sync.run_now')));
    } else {
      bindText($('sync-save'), () => tr('sync.save_test'));
      bindText($('sync-run'), () => tr('sync.run_now'));
    }
    content.setAttribute('aria-busy', String(value));
    form.setAttribute('aria-busy', String(value));
  }

  function applyShared(next) {
    data = next;
    setSyncSnapshot(next);
    if (form.hidden) {
      content.hidden = true;
      form.hidden = false;
    }
    render();
    setBusy(false);
    if (data?.running) setBusy(false, 'run');
    showError();
  }

  const onShared = (next) => {
    if (!next) return;
    // A save or run owns its generation; background ticks must not
    // overwrite its busy state, only refresh the displayed status.
    if (busy) {
      data = next;
      setSyncSnapshot(next);
      renderStatus();
      return;
    }
    data = next;
    if (!form.hidden) {
      render();
      if (data?.running) setBusy(false, 'run');
      else setBusy(false);
    }
  };
  subscribeSync(onShared);

  async function refresh() {
    if (!allowed()) return;
    const turn = ++generation;
    setBusy(true);
    showError();
    try {
      const next = await api('/api/sync');
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      content.hidden = true;
      form.hidden = false;
      render();
      showError();
      if (data.running) {
        running = true;
        setBusy(false, 'run');
      }
    } catch (error) {
      if (turn !== generation) return;
      content.hidden = false;
      form.hidden = true;
      bindText(content.querySelector('.settings-footnote'), () => translateKnown(error.message));
      showError(error.message);
    } finally {
      if (turn === generation && !data?.running) setBusy(false);
    }
  }

  async function save(event) {
    event?.preventDefault();
    if (busy || !allowed() || !form.reportValidity()) return;
    const turn = ++generation;
    setBusy(true, 'save');
    showError();
    try {
      const body = {
        url: $('sync-url').value.trim(),
        accessKeyId: $('sync-access-key').value.trim(),
        device: $('sync-device').value.trim(),
      };
      // Empty means keep the stored value.
      if ($('sync-secret').value) body.secretAccessKey = $('sync-secret').value;
      if ($('sync-passphrase').value) body.passphrase = $('sync-passphrase').value;
      const next = await api('/api/sync', { method: 'PUT', body });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      toast(() => tr('sync.saved'));
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      if (turn === generation) setBusy(false);
    }
  }

  async function runNow() {
    if (busy || running || !allowed() || !data?.configured) return;
    const turn = ++generation;
    running = true;
    setBusy(true, 'run');
    showError();
    try {
      // The server answers 202 immediately with running:true; the first
      // sync can take minutes, so the shared poller follows GET /api/sync.
      const next = await api('/api/sync/run', { method: 'POST', body: {} });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      if (!data.running) {
        toast(
          () =>
            tr(
              data.lastSync && !data.lastSync.ok
                ? translateKnown(data.lastSync.error || '')
                : tr('sync.synced'),
            ),
          !data.lastSync || !data.lastSync.ok,
        );
      }
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      running = false;
      if (turn === generation && !data?.running) setBusy(false);
      else if (turn === generation && data?.running) setBusy(false, 'run');
    }
  }

  async function forget() {
    if (busy || !allowed() || !data?.configured) return;
    if (!confirm(tr('sync.forget_confirm'))) return;
    const turn = ++generation;
    setBusy(true, 'forget');
    showError();
    try {
      const next = await api('/api/sync', { method: 'DELETE' });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      toast(() => tr('sync.forgotten'));
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      if (turn === generation) setBusy(false);
    }
  }

  form.onsubmit = (event) => void save(event);
  $('sync-run').onclick = () => void runNow();
  $('sync-forget').onclick = () => void forget();
  $('sync-refresh').onclick = () => void refresh();
  onLanguageChange(() => {
    if (!form.hidden && data) render();
  });

  return { refresh };
}
