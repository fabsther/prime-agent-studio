import { t as tr, bindText, translateKnown, onLanguageChange, getLanguage } from './i18n.js';

// R2 conversation sync panel (Preferences > Synchronisation).
// Local only: the host hides the tab when remote or readOnly.
// Secrets are write only: the server never echoes them back and the
// inputs are cleared after every load and save.
export function createSyncSettings({ api, getContext, toast }) {
  const $ = (id) => document.getElementById(id);
  const form = $('sync-form');
  const content = $('sync-content');
  if (!form || !content) return { refresh: async () => {} };
  let data = null;
  let busy = false;
  let running = false;
  let pollTimer = 0;
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
    if (data.running) return tr('sync.running');
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
    $('sync-url').value = data.url || '';
    $('sync-access-key').value = data.accessKeyId || '';
    // Never echo secrets back into the inputs.
    $('sync-secret').value = '';
    $('sync-passphrase').value = '';
    $('sync-secret').placeholder = data.hasSecret ? tr('sync.secret_kept') : '';
    $('sync-passphrase').placeholder = data.hasPassphrase ? tr('sync.passphrase_kept') : '';
    $('sync-device').value = data.device || '';
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

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
  }

  async function pollWhileRunning(turn) {
    stopPolling();
    if (!data?.running || turn !== generation) return;
    renderStatus();
    pollTimer = setTimeout(async () => {
      if (turn !== generation) return;
      try {
        const next = await api('/api/sync');
        if (turn !== generation) return;
        data = next;
        render();
        setBusy(false);
        if (data.running) void pollWhileRunning(turn);
      } catch (error) {
        if (turn !== generation) return;
        showError(error.message);
        // Keep polling on transient read errors while the server runs.
        if (data?.running) void pollWhileRunning(turn);
      }
    }, 2000);
  }

  async function refresh() {
    if (!allowed()) return;
    const turn = ++generation;
    stopPolling();
    setBusy(true);
    showError();
    try {
      const next = await api('/api/sync');
      if (turn !== generation) return;
      data = next;
      content.hidden = true;
      form.hidden = false;
      render();
      showError();
      if (data.running) {
        running = true;
        setBusy(false, 'run');
        void pollWhileRunning(turn);
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
    stopPolling();
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
      render();
      showError();
      toast(() => tr('sync.saved'));
      if (data.running) void pollWhileRunning(turn);
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
    stopPolling();
    running = true;
    setBusy(true, 'run');
    showError();
    try {
      // The server answers 202 immediately with running:true; the first
      // sync can take minutes, so poll GET /api/sync until it settles.
      const next = await api('/api/sync/run', { method: 'POST', body: {} });
      if (turn !== generation) return;
      data = next;
      render();
      showError();
      if (data.running) {
        void pollWhileRunning(turn);
      } else {
        toast(() => tr(data.lastSync && !data.lastSync.ok ? translateKnown(data.lastSync.error || '') : tr('sync.synced')), !data.lastSync || !data.lastSync.ok);
      }
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      running = false;
      if (turn === generation && !data?.running) setBusy(false);
    }
  }

  async function forget() {
    if (busy || !allowed() || !data?.configured) return;
    if (!confirm(tr('sync.forget_confirm'))) return;
    const turn = ++generation;
    stopPolling();
    setBusy(true, 'forget');
    showError();
    try {
      const next = await api('/api/sync', { method: 'DELETE' });
      if (turn !== generation) return;
      data = next;
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
