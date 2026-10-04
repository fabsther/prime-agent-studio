import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange, getLanguage } from './i18n.js';

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

  let localProjects = [];
  let localProjectsLoaded = false;

  async function loadLocalProjects() {
    try {
      const overview = await api('/api/overview');
      if (Array.isArray(overview?.projects)) {
        localProjects = overview.projects;
        localProjectsLoaded = true;
        renderProjects();
      }
    } catch {}
  }

  function localNameOf(cwd) {
    const found = localProjects.find((entry) => String(entry?.cwd) === String(cwd));
    if (found?.name) return found.name;
    return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || String(cwd || '');
  }

  async function linkRemote(remote, cwd) {
    await api('/api/projects', {
      method: 'POST',
      body: { cwd, name: remote.name, sync: true, syncId: remote.id },
    });
    localProjectsLoaded = false;
    void loadLocalProjects();
    window.dispatchEvent(new CustomEvent('prime-studio:overview'));
    toast(() => tr('projects.sync_updated'));
    try {
      await api('/api/sync/run', { method: 'POST', body: {} });
    } catch (error) {
      toast(() => translateKnown(error.message), true);
      return;
    }
    await refreshSyncNow();
  }

  async function pickAndLink(remote, button) {
    button.disabled = true;
    try {
      const nativePicker =
        window.__PRIME_STUDIO_DESKTOP__ === true &&
        typeof window.__TAURI__?.core?.invoke === 'function';
      let cwd = '';
      if (nativePicker) {
        cwd = await window.__TAURI__.core.invoke('desktop_pick_directory', {
          cwd: '',
          title: tr('sync.choose_folder'),
        });
      } else {
        const result = await api('/api/projects/pick-directory', {
          method: 'POST',
          body: { cwd: '' },
        });
        cwd = result?.cwd || '';
      }
      if (cwd) await linkRemote(remote, cwd);
    } catch (error) {
      toast(() => translateKnown(error.message || String(error)), true);
    } finally {
      button.disabled = false;
    }
  }

  function renderProjects() {
    const section = $('sync-projects');
    const list = $('sync-projects-list');
    const empty = $('sync-projects-empty');
    if (!section || !list || !empty) return;
    const show = Boolean(data?.configured) && allowed();
    section.hidden = !show;
    if (!show) return;
    if (!localProjectsLoaded) void loadLocalProjects();
    const remotes = Array.isArray(data?.remoteProjects) ? data.remoteProjects : [];
    const links = data?.projectLinks && typeof data.projectLinks === 'object' ? data.projectLinks : {};
    bindText(empty, () => tr('sync.projects_empty'));
    empty.hidden = remotes.length > 0;
    const kept = new Map();
    for (const input of list.querySelectorAll('input[data-remote-path]'))
      kept.set(input.dataset.remotePath, input.value);
    const focused = document.activeElement?.dataset?.remotePath;
    list.replaceChildren();
    const desktopPicker =
      typeof window !== 'undefined' && window.__PRIME_STUDIO_DESKTOP__ === true;
    for (const remote of remotes) {
      if (!remote || typeof remote.id !== 'string') continue;
      const row = document.createElement('div');
      row.className = 'sync-project-row';
      const main = document.createElement('div');
      main.className = 'sync-project-main';
      const name = document.createElement('span');
      name.className = 'sync-project-name';
      bindText(name, () => remote.name || remote.id);
      main.append(name);
      if (remote.git) {
        const git = document.createElement('span');
        git.className = 'sync-project-git';
        git.textContent = remote.git;
        main.append(git);
      }
      if (Array.isArray(remote.devices) && remote.devices.length) {
        const devices = document.createElement('span');
        devices.className = 'sync-project-devices';
        const names = remote.devices.join(', ');
        bindText(devices, () => tr('sync.projects_devices', { value1: names }));
        main.append(devices);
      }
      row.append(main);
      const state = document.createElement('div');
      state.className = 'sync-project-state';
      if (remote.local) {
        const via = links[remote.local]?.via;
        const suffix =
          via === 'git'
            ? ` (${tr('sync.project_via_git')})`
            : via === 'name'
              ? ` (${tr('sync.project_via_name')})`
              : via === 'manual' || via === 'id'
                ? ` (${tr('sync.project_via_manual')})`
                : '';
        const localName = localNameOf(remote.local);
        bindText(state, () => tr('sync.project_linked', { value1: localName }) + suffix);
      } else {
        bindText(state, () => tr('sync.project_unlinked'));
        const controls = document.createElement('div');
        controls.className = 'sync-project-link';
        if (desktopPicker) {
          const choose = document.createElement('button');
          choose.type = 'button';
          choose.className = 'secondary-button';
          bindText(choose, () => tr('sync.choose_folder'));
          choose.onclick = () => void pickAndLink(remote, choose);
          controls.append(choose);
        } else {
          const input = document.createElement('input');
          input.dataset.remotePath = remote.id;
          input.autocomplete = 'off';
          input.spellcheck = false;
          bindAttribute(input, 'placeholder', () => tr('sync.project_path'));
          bindAttribute(input, 'aria-label', () => tr('sync.project_path'));
          if (kept.has(remote.id)) input.value = kept.get(remote.id);
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'secondary-button';
          bindText(add, () => tr('sync.project_add'));
          add.onclick = async () => {
            const cwd = input.value.trim();
            if (!cwd) {
              input.focus();
              return;
            }
            add.disabled = true;
            try {
              await linkRemote(remote, cwd);
            } catch (error) {
              toast(() => translateKnown(error.message || String(error)), true);
            } finally {
              add.disabled = false;
            }
          };
          controls.append(input, add);
        }
        state.append(controls);
      }
      row.append(state);
      list.append(row);
    }
    if (focused) list.querySelector(`input[data-remote-path="${CSS.escape(focused)}"]`)?.focus();
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
    // Configuration stays folded once set up; it opens to guide a first setup.
    if (!data.configured) $('sync-config').open = true;
    renderStatus();
    renderProjects();
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
    const dialog = $('sync-forget-dialog');
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    if (dialog.returnValue !== 'confirm') return;
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
