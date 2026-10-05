import { t as tr, bindText } from './i18n.js';
import { SWITCH_PARAM } from './machine-list.js';
const button = document.getElementById('pwa-install');
// Arrival from the machine list of another address. A cross-site navigation does not send this
// origin's SameSite=Strict session cookie, so the sign-in page retries once from this origin.
// Only the bare landing page is reloaded; no parameter from the other site is kept.
const query = new URLSearchParams(location.search);
if (query.has(SWITCH_PARAM)) {
  if (document.querySelector('form[action="/lan/login"]')) location.replace('/');
  else {
    query.delete(SWITCH_PARAM);
    history.replaceState(
      history.state,
      '',
      location.pathname + (query.size ? `?${query}` : '') + location.hash,
    );
  }
}
const machines = document.getElementById('open-machines');
// The desktop window shows one local Studio; other machines open from the phone or a browser.
if (machines) machines.hidden = window.__PRIME_STUDIO_DESKTOP__ === true;
let invitation;
const standalone = () =>
  window.__PRIME_STUDIO_DESKTOP__ === true ||
  matchMedia('(display-mode: standalone)').matches ||
  navigator.standalone === true;
const update = () => {
  if (button) button.hidden = standalone();
};
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  invitation = event;
  update();
});
window.addEventListener('appinstalled', () => {
  invitation = null;
  if (button) button.hidden = true;
});
matchMedia('(display-mode: standalone)').addEventListener('change', update);
update();

function help() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const dialog = document.createElement('dialog');
  dialog.className = 'pwa-dialog';
  dialog.setAttribute('aria-labelledby', 'pwa-help-title');
  const title = document.createElement('h2');
  title.id = 'pwa-help-title';
  bindText(title, () => tr('ui.installer_prime_agent_studio'));
  const text = document.createElement('p');
  bindText(text, () =>
    !window.isSecureContext
      ? tr('ui.sur_le_telephone_ouvrez_l_adresse_https_du_studio_avec_tailscale')
      : ios
        ? tr('ui.ouvrez_cette_page_dans_safari_puis_utilisez_partager_sur_l_ecran')
        : tr('ui.dans_le_menu_de_votre_navigateur_choisissez_installer_l_applicati'),
  );
  const note = document.createElement('p');
  note.className = 'pwa-note';
  bindText(note, () => tr('ui.le_pc_doit_rester_allume_fermer_l_application_laisse_les_agents_t'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pwa-primary';
  bindText(close, () => tr('ui.compris'));
  close.onclick = () => dialog.close();
  dialog.append(title, text, note, close);
  document.body.append(dialog);
  dialog.onclick = (event) => {
    if (event.target === dialog) dialog.close();
  };
  dialog.onclose = () => {
    dialog.remove();
    button?.focus();
  };
  dialog.showModal();
}
if (button)
  button.onclick = async () => {
    if (!invitation) return help();
    const event = invitation;
    invitation = null;
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      help();
    }
  };
if (window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
    // Installation guidance remains usable if the server has not been updated yet.
  });
}
