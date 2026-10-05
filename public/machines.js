// PWA level above each PC Studio: open, add (QR code or address), rename and remove machines.
// The list stays in this origin's storage; each PC keeps its own gateway, code and session.
import { t, bindText, bindAttribute } from './i18n.js';
import {
  MAX_MACHINES,
  STORAGE_KEY,
  cleanMachineName,
  defaultMachineName,
  hasOtherMachines,
  loadMachines,
  machineKind,
  machineUrl,
  parseMachineAddress,
  saveMachines,
} from './machine-list.js';

const here = location.origin;
const $ = (id) => document.getElementById(id);
const storage = (() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
})();
let machines = loadMachines(storage, here);

// Launched from the app icon without another machine: open this Studio directly, as before.
if (location.hash !== '#list' && !hasOtherMachines(machines, here)) location.replace('/');
else start();

function start() {
  const list = $('machine-list'),
    form = $('machine-form'),
    address = $('machine-address'),
    nameInput = $('machine-name'),
    manual = $('machine-manual'),
    remove = $('machine-remove'),
    message = $('machine-message'),
    dialog = $('machine-scanner'),
    video = $('machine-video'),
    photo = $('machine-photo'),
    scanStatus = $('machine-scan-status');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const KIND_LABELS = {
    https: () => t('machines.kind_https'),
    tailscale: () => t('machines.kind_tailscale'),
    lan: () => t('machines.kind_lan'),
  };
  const PATHS = {
    monitor: 'M3 4h18v12H3V4Zm9 12v4m-5 0h10',
    pencil: 'm16 3 5 5L8 21H3v-5L16 3Zm-2 2 5 5',
  };
  let editing = null,
    armed = 0,
    stream = null,
    timer = 0,
    generation = 0,
    decoder = null,
    rejected = '';

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PATHS[name]);
    svg.append(path);
    return svg;
  }
  const displayName = (machine) => machine.name || defaultMachineName(machine.origin);
  const announce = (text) => {
    $('machine-status').textContent = text;
  };
  function showMessage(text, error = false) {
    bindText(message, text);
    message.classList.toggle('is-error', error);
    message.hidden = false;
  }
  const hideMessage = () => {
    message.hidden = true;
  };
  function showFormError(text, field) {
    bindText($('machine-error'), text);
    $('machine-error').hidden = false;
    $('machine-form-note').hidden = true;
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.focus();
    }
  }
  function hideFormError() {
    $('machine-error').hidden = true;
    address.removeAttribute('aria-invalid');
  }

  function persist(previous) {
    try {
      if (!storage) throw new Error('Storage unavailable');
      saveMachines(storage, machines);
      return true;
    } catch {
      machines = previous;
      const text = () => t('machines.error_storage');
      if (form.hidden) showMessage(text, true);
      else showFormError(text);
      return false;
    }
  }

  function render() {
    const current = machines.find((machine) => machine.origin === here) || { origin: here, name: '' };
    const others = machines.filter((machine) => machine.origin !== here);
    list.replaceChildren(...[current, ...others].map(row));
    $('machine-empty').hidden = others.length > 0;
  }
  function row(machine) {
    const isHere = machine.origin === here,
      name = displayName(machine),
      host = new URL(machine.origin).host,
      kind = machineKind(machine.origin);
    const item = node('li', isHere ? 'machine is-current' : 'machine');
    item.dataset.origin = machine.origin;
    const link = node('a', 'machine-open');
    link.href = machineUrl(machine.origin, here);
    link.title = machine.origin;
    const symbol = node('span', 'machine-icon');
    symbol.append(icon('monitor'));
    const title = node('span', 'machine-title');
    title.append(node('span', 'machine-name', name));
    if (isHere) title.append(bindText(node('span', 'machine-badge'), () => t('machines.current')));
    // The type stays visible; a long address is the part that gets shortened.
    const meta = node('span', 'machine-meta');
    if (kind) meta.append(bindText(node('span', 'machine-kind'), KIND_LABELS[kind]));
    if (host !== name) meta.append(node('span', 'machine-address', host));
    const text = node('span', 'machine-text');
    text.append(title, meta);
    link.append(symbol, text);
    const edit = node('button', 'machine-action');
    edit.type = 'button';
    bindAttribute(edit, 'aria-label', () => t('machines.edit', { name }));
    bindAttribute(edit, 'title', () => t('machines.edit', { name }));
    edit.append(icon('pencil'));
    edit.onclick = () => {
      hideMessage();
      openForm(machine);
      (isHere ? nameInput : address).focus();
    };
    item.append(link, edit);
    return item;
  }

  function updatePlaceholder() {
    const origin = editing === here ? here : parseMachineAddress(address.value)?.origin;
    const fallback = origin ? defaultMachineName(origin) : '';
    bindAttribute(nameInput, 'placeholder', () => fallback || t('machines.name_placeholder'));
  }
  function openForm(machine = null, prefill = '') {
    editing = machine?.origin ?? null;
    form.hidden = false;
    manual.hidden = true;
    manual.setAttribute('aria-expanded', 'true');
    hideFormError();
    $('machine-form-note').hidden = true;
    address.value = machine ? machine.origin : prefill;
    address.disabled = editing === here;
    remove.hidden = !editing || editing === here;
    disarmRemove();
    nameInput.value = machine?.name ?? '';
    updatePlaceholder();
    bindText($('machine-form-title'), () => t(editing ? 'machines.edit_title' : 'machines.add_title'));
    bindText($('machine-submit-label'), () => t(editing ? 'machines.save' : 'machines.add'));
    form.scrollIntoView({ block: 'nearest' });
  }
  function closeForm() {
    form.hidden = true;
    form.reset();
    editing = null;
    address.disabled = false;
    remove.hidden = true;
    disarmRemove();
    hideFormError();
    manual.hidden = false;
    manual.setAttribute('aria-expanded', 'false');
  }
  function disarmRemove() {
    clearTimeout(armed);
    armed = 0;
    remove.classList.remove('armed');
    bindText($('machine-remove-label'), () => t('machines.remove_action'));
  }
  // Two taps: the first one arms the removal for a few seconds.
  remove.addEventListener('click', () => {
    if (!editing || editing === here) return;
    if (!armed) {
      armed = setTimeout(disarmRemove, 4000);
      remove.classList.add('armed');
      bindText($('machine-remove-label'), () => t('machines.confirm_remove_action'));
      announce(t('machines.confirm_remove_action'));
      return;
    }
    const previous = machines,
      origin = editing,
      name = displayName(machines.find((machine) => machine.origin === origin) || { origin, name: '' });
    machines = machines.filter((machine) => machine.origin !== origin);
    if (!persist(previous)) return disarmRemove();
    closeForm();
    render();
    announce(t('machines.removed', { name }));
    manual.focus();
  });
  function focusRow(origin) {
    for (const item of list.children)
      if (item.dataset.origin === origin) return item.querySelector('.machine-open')?.focus();
  }

  manual.onclick = () => {
    hideMessage();
    openForm();
    address.focus();
  };
  $('machine-cancel').onclick = () => {
    closeForm();
    manual.focus();
  };
  address.addEventListener('input', () => {
    hideFormError();
    updatePlaceholder();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const previous = machines,
      name = cleanMachineName(nameInput.value);
    let origin = here;
    if (editing !== here) {
      const parsed = parseMachineAddress(address.value);
      if (!parsed) return showFormError(() => t('machines.error_address'), address);
      origin = parsed.origin;
      if (origin !== editing && (origin === here || machines.some((machine) => machine.origin === origin)))
        return showFormError(() => t('machines.error_duplicate'), address);
    }
    const target = editing ?? origin,
      exists = machines.some((machine) => machine.origin === target);
    if (!exists && machines.length >= MAX_MACHINES)
      return showFormError(() => t('machines.error_full', { count: MAX_MACHINES }));
    const entry = { origin, name };
    machines = exists
      ? machines.map((machine) => (machine.origin === target ? entry : machine))
      : [...machines, entry];
    // This address is always listed; store it only to keep a custom name.
    if (origin === here && !name) machines = machines.filter((machine) => machine.origin !== here);
    if (!persist(previous)) return;
    const added = !editing;
    closeForm();
    render();
    announce(added ? t('machines.added', { name: displayName(entry) }) : t('machines.saved'));
    focusRow(origin);
  });

  function loadDecoder() {
    // jsQR registers a global; it is fetched only when a QR code is read.
    decoder ??= import('/vendor/jsqr.js').then(() => {
      if (typeof self.jsQR !== 'function') throw new Error('QR decoder unavailable');
      return self.jsQR;
    });
    decoder.catch(() => {
      decoder = null;
    });
    return decoder;
  }
  function decode(jsQR, source, width, height, limit, inversionAttempts) {
    const scale = Math.min(1, limit / Math.max(width, height)),
      w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    // Resizing clears and reallocates the canvas; camera frames keep the same size.
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    context.drawImage(source, 0, 0, w, h);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts })?.data || '';
  }
  function setScanStatus(key, error = false) {
    bindText(scanStatus, () => t(key));
    scanStatus.classList.toggle('is-error', error);
  }
  function stopCamera() {
    clearTimeout(timer);
    timer = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
  }
  // A scanned address only fills the form: the user checks it before adding.
  function accept(text) {
    const parsed = parseMachineAddress(text);
    if (!parsed) return false;
    if (dialog.open) dialog.close();
    hideMessage();
    openForm(null, parsed.origin);
    if (parsed.origin === here || machines.some((machine) => machine.origin === parsed.origin)) {
      showFormError(() => t('machines.error_duplicate'), address);
      return true;
    }
    bindText($('machine-form-note'), () => t('machines.qr_read'));
    $('machine-form-note').hidden = false;
    announce(t('machines.qr_read'));
    nameInput.focus();
    return true;
  }

  // The browser restores focus on close; accept() then moves it to the filled form.
  dialog.addEventListener('close', () => {
    generation++;
    stopCamera();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dialog.open) dialog.close();
  });
  $('machine-scan-close').onclick = () => dialog.close();
  $('machine-scan-photo').onclick = () => {
    dialog.close();
    photo.click();
  };
  $('machine-scan').onclick = async () => {
    hideMessage();
    // HTTP pages on a LAN IP have no live camera API; the photo picker still works there.
    if (!navigator.mediaDevices?.getUserMedia) return photo.click();
    const turn = ++generation;
    rejected = '';
    setScanStatus('machines.scan_starting');
    dialog.showModal();
    loadDecoder().catch(() => {});
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
    } catch (error) {
      if (turn === generation)
        setScanStatus(
          error?.name === 'NotAllowedError' ? 'machines.camera_denied' : 'machines.camera_unavailable',
          true,
        );
      return;
    }
    if (turn !== generation) return media.getTracks().forEach((track) => track.stop());
    stream = media;
    video.srcObject = media;
    video.play().catch(() => {});
    let jsQR;
    try {
      jsQR = await loadDecoder();
    } catch {
      if (turn !== generation) return;
      stopCamera();
      return setScanStatus('machines.decoder_error', true);
    }
    if (turn !== generation) return;
    setScanStatus('machines.scan_hint');
    const scan = () => {
      if (turn !== generation) return;
      if (video.readyState >= 2 && video.videoWidth) {
        const text = decode(jsQR, video, video.videoWidth, video.videoHeight, 720, 'dontInvert');
        if (text && accept(text)) return;
        if (text && text !== rejected) {
          rejected = text;
          setScanStatus('machines.qr_not_studio', true);
        }
      }
      timer = setTimeout(scan, 160);
    };
    scan();
  };
  photo.addEventListener('change', async () => {
    const file = photo.files?.[0];
    photo.value = '';
    if (!file) return;
    showMessage(() => t('machines.photo_reading'));
    let jsQR;
    try {
      jsQR = await loadDecoder();
    } catch {
      return showMessage(() => t('machines.decoder_error'), true);
    }
    try {
      const bitmap = await createImageBitmap(file);
      let text = '';
      try {
        const longest = Math.max(bitmap.width, bitmap.height),
          tried = new Set();
        for (const limit of [1280, 720, 2048]) {
          const scale = Math.min(1, limit / longest);
          if (tried.has(scale)) continue;
          tried.add(scale);
          text = decode(jsQR, bitmap, bitmap.width, bitmap.height, limit, 'attemptBoth');
          if (text) break;
        }
      } finally {
        bitmap.close?.();
      }
      if (!text) return showMessage(() => t('machines.qr_not_found'), true);
      if (!accept(text)) showMessage(() => t('machines.qr_not_studio'), true);
    } catch {
      showMessage(() => t('machines.qr_not_found'), true);
    }
  });

  addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    machines = loadMachines(storage, here);
    render();
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    machines = loadMachines(storage, here);
    render();
  });
  document.querySelector('main').hidden = false;
  render();
}
