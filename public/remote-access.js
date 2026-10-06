import { t as tr, bindText, bindAttribute, translateKnown, getLanguage } from './i18n.js';
export function createRemoteAccessSettings({ api, isRemote, toast }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('remote-access-dialog'),
    form = $('remote-code-form');
  const fields = ['remote-code', 'remote-code-confirmation'];
  const deviceSection = document.createElement('section');
  deviceSection.id = 'paired-devices';
  deviceSection.hidden = true;
  const deviceHeading = document.createElement('div');
  deviceHeading.className = 'paired-devices-heading';
  const deviceTitle = document.createElement('h3');
  deviceTitle.id = 'paired-devices-title';
  bindText(deviceTitle, () => tr('fleet.devices_title'));
  deviceSection.setAttribute('aria-labelledby', deviceTitle.id);
  const deviceRefresh = document.createElement('button');
  deviceRefresh.type = 'button';
  deviceRefresh.className = 'secondary-button';
  bindText(deviceRefresh, () => tr('fleet.devices_refresh'));
  deviceHeading.append(deviceTitle, deviceRefresh);
  const deviceStatus = document.createElement('p');
  deviceStatus.id = 'paired-devices-status';
  deviceStatus.className = 'remote-code-note';
  deviceStatus.setAttribute('role', 'status');
  const deviceList = document.createElement('ul');
  deviceList.id = 'paired-devices-list';
  deviceSection.append(deviceHeading, deviceStatus, deviceList);
  dialog.append(deviceSection);
  let devices = [],
    devicesBusy = false;
  function setDevicesBusy(value) {
    devicesBusy = value;
    deviceSection.setAttribute('aria-busy', String(value));
    deviceRefresh.disabled = value;
    for (const button of deviceList.querySelectorAll('button')) button.disabled = value;
  }
  function renderDevices() {
    deviceList.replaceChildren();
    bindText(deviceStatus, () => (devices.length ? '' : tr('fleet.devices_empty')));
    for (const device of devices) {
      const row = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = device.deviceName || device.deviceId;
      const dates = document.createElement('p');
      dates.className = 'remote-code-note';
      const date = (value) => {
        if (!value) return tr('fleet.devices_never');
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
          ? tr('fleet.devices_never')
          : parsed.toLocaleString(getLanguage());
      };
      bindText(dates, () =>
        tr('fleet.devices_dates', {
          created: date(device.createdAt),
          lastUsed: date(device.lastUsedAt),
        }),
      );
      info.append(name, dates);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary-button';
      bindText(revoke, () => tr('fleet.devices_revoke'));
      bindAttribute(revoke, 'aria-label', () => tr('fleet.devices_revoke_name', { name: name.textContent }));
      revoke.onclick = async () => {
        if (isRemote() || devicesBusy || !dialog.open) return;
        if (!window.confirm(tr('fleet.devices_confirm', { name: name.textContent }))) return;
        const turn = generation;
        setDevicesBusy(true);
        bindText(deviceStatus, () => '');
        try {
          await api('/api/fleet/devices/' + encodeURIComponent(device.deviceId), { method: 'DELETE' });
          if (turn !== generation) return;
          devices = devices.filter((item) => item.deviceId !== device.deviceId);
          renderDevices();
          deviceRefresh.focus();
        } catch {
          if (turn === generation) bindText(deviceStatus, () => tr('fleet.devices_revoke_failed'));
        } finally {
          if (turn === generation) setDevicesBusy(false);
        }
      };
      row.append(info, revoke);
      deviceList.append(row);
    }
  }
  async function refreshDevices(turn = generation) {
    if (isRemote() || devicesBusy || !dialog.open) return;
    setDevicesBusy(true);
    bindText(deviceStatus, () => tr('common.loading'));
    try {
      const data = await api('/api/fleet/devices');
      if (turn !== generation) return;
      devices = data;
      renderDevices();
    } catch {
      if (turn === generation) bindText(deviceStatus, () => tr('fleet.devices_load_failed'));
    } finally {
      if (turn === generation) setDevicesBusy(false);
    }
  }
  deviceRefresh.onclick = () => void refreshDevices();
  let revision,
    configured = false,
    busy = false,
    generation = 0;
  const showError = (message = '') => {
    bindText($('remote-code-error'), () => message);
    $('remote-code-error').hidden = !message;
  };
  function refresh() {
    $('remote-code-fields').disabled = busy || !configured;
    $('save-remote-code').disabled =
      busy || !configured || !/^[0-9]{8}$/.test($(fields[0]).value) || !/^[0-9]{8}$/.test($(fields[1]).value);
    bindText($('save-remote-code'), () => (busy ? tr('common.saving') : tr('ui.changer_le_code')));
  }
  function clear() {
    form.reset();
    for (const id of fields) $(id).type = 'password';
    revision = undefined;
    configured = false;
    devices = [];
    deviceSection.hidden = true;
    deviceList.replaceChildren();
    bindText(deviceStatus, () => '');
    setDevicesBusy(false);
    showError();
  }
  dialog.addEventListener('close', () => {
    generation++;
    clear();
  });
  $('show-remote-code').onchange = (event) => {
    for (const id of fields) $(id).type = event.target.checked ? 'text' : 'password';
  };
  for (const id of fields)
    $(id).oninput = () => {
      showError();
      refresh();
    };
  $('open-remote-access').onclick = async () => {
    if (isRemote()) return;
    $('settings-dialog').close();
    clear();
    const turn = ++generation;
    busy = false;
    refresh();
    bindText($('remote-access-status'), () => tr('ui.chargement_de_l_acces_mobile'));
    deviceSection.hidden = false;
    dialog.showModal();
    void refreshDevices(turn);
    try {
      const data = await api('/api/remote-access');
      if (turn !== generation) return;
      revision = data.revision;
      configured = data.configured;
      bindText($('remote-access-status'), () =>
        configured
          ? tr('ui.un_meme_code_pour_le_wi_fi_tailscale_et_la_pwa')
          : tr('ui.l_acces_mobile_n_est_pas_encore_configure_sur_ce_pc'),
      );
      refresh();
      if (configured) $(fields[0]).focus();
    } catch (error) {
      if (turn !== generation) return;
      bindText($('remote-access-status'), () => tr('ui.code_d_acces_indisponible'));
      showError(
        error.status === 404
          ? tr('ui.cette_option_necessite_un_redemarrage_du_studio_apres_la_fin_des')
          : translateKnown(error.message),
      );
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (isRemote() || busy || !configured) return;
    if (!form.reportValidity()) return;
    if ($(fields[0]).value !== $(fields[1]).value) {
      showError(tr('ui.les_deux_codes_ne_correspondent_pas'));
      $(fields[1]).focus();
      return;
    }
    const turn = generation;
    const body = { code: $(fields[0]).value, confirmation: $(fields[1]).value, revision };
    busy = true;
    refresh();
    showError();
    try {
      await api('/api/remote-access/code', { method: 'POST', body });
      if (turn === generation) dialog.close();
      toast(() => tr('ui.code_modifie_reconnectez_vos_appareils_avec_le_nouveau_code'));
    } catch (error) {
      if (turn === generation) showError(translateKnown(error.message));
    } finally {
      body.code = body.confirmation = '';
      if (turn === generation) {
        busy = false;
        refresh();
      }
    }
  };
}
