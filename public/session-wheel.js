import { t, getLanguage } from './i18n.js';
import { projectFolderColor } from './project-navigation.js';

export function recentConversations(projects, language = getLanguage()) {
  const time = (value) => (typeof value === 'number' ? value : Date.parse(value)) || 0;
  const compare = new Intl.Collator(language, { sensitivity: 'base', numeric: true }).compare;
  return projects
    .flatMap((project) =>
      (project.sessions || [])
        .filter((session) => session.id && !session.archived)
        .map((session) => ({
          id: session.id,
          cwd: project.cwd,
          title: session.title || t('ui.nouvelle_session'),
          updatedAt: session.updatedAt,
          projectName: project.name || project.cwd.split(/[\\/]/).pop(),
          color: projectFolderColor(project),
        })),
    )
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, 6)
    .sort(
      (a, b) =>
        compare(a.title, b.title) || compare(a.projectName, b.projectName) || a.id.localeCompare(b.id),
    );
}

// Native dialog keeps the wheel above other dialogs and restores focus on cancellation.
export function createSessionWheel({ getContext, getActivity, activityDot, onSelect }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'session-wheel';
  dialog.className = 'session-wheel';
  dialog.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', 'session-wheel-heading');
  dialog.setAttribute('aria-describedby', 'session-wheel-help');
  dialog.innerHTML = `
    <div class="session-wheel-frame">
      <header class="session-wheel-heading">
        <span class="session-wheel-eyebrow"></span>
        <h2 id="session-wheel-heading"></h2>
      </header>
      <div class="session-wheel-stage">
        <div class="session-wheel-center">
          <kbd>Alt</kbd><span class="session-wheel-prompt"></span>
          <span class="session-wheel-center-mark" aria-hidden="true">↗</span>
        </div>
      </div>
      <p id="session-wheel-help" class="session-wheel-help"></p>
      <p class="sr-only session-wheel-status" role="status"></p>
    </div>`;
  document.body.append(dialog);
  const stage = dialog.querySelector('.session-wheel-stage');
  const prompt = dialog.querySelector('.session-wheel-prompt');
  const status = dialog.querySelector('.session-wheel-status');
  let items = [],
    buttons = [],
    selected = -1,
    held = '';
  const point = (radius, angle) => {
    const radians = (angle * Math.PI) / 180;
    return [300 + radius * Math.cos(radians), 300 + radius * Math.sin(radians)];
  };
  function select(index) {
    selected = index >= 0 && index < items.length ? index : -1;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === selected)));
    dialog.dataset.selected = String(selected >= 0);
    dialog.style.setProperty('--wheel-active', items[selected]?.color || 'var(--accent)');
    prompt.textContent = t(selected < 0 ? 'wheel.choose' : 'wheel.release');
    status.textContent = selected < 0 ? '' : `${items[selected].projectName}. ${items[selected].title}`;
  }
  function renderActivity() {
    if (!dialog.open) return;
    buttons.forEach((button, index) => {
      const activity = getActivity(items[index]);
      if (button.dataset.activity === activity) return;
      button.dataset.activity = activity;
      const badge = button.querySelector('.session-wheel-activity');
      badge.replaceChildren();
      const dot = activity === 'idle' ? null : activityDot(activity);
      if (dot) badge.append(dot);
      button.setAttribute('aria-description', dot?.getAttribute('aria-label') || '');
    });
  }
  function close(commit = false) {
    const item = commit ? items[selected] : null;
    held = '';
    if (dialog.open) dialog.close();
    if (item) void onSelect(item);
  }
  function open(code) {
    const context = getContext();
    items = recentConversations(context.projects);
    if (!items.length) return;
    held = code;
    for (const button of buttons) button.remove();
    dialog.querySelector('.session-wheel-eyebrow').textContent = t('wheel.eyebrow');
    dialog.querySelector('h2').textContent = t('wheel.title');
    dialog.querySelector('.session-wheel-help').textContent = t('wheel.help');
    buttons = items.map((item, index) => {
      const angle = -90 + index * 60;
      const start = angle - 28.5,
        end = angle + 28.5;
      const d = `M ${point(284, start)} A 284 284 0 0 1 ${point(284, end)} L ${point(108, end)} A 108 108 0 0 0 ${point(108, start)} Z`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-wheel-item';
      button.tabIndex = -1;
      button.dataset.sessionId = item.id;
      button.dataset.projectColor = item.color || 'transparent';
      button.style.setProperty('--wheel-color', item.color || 'var(--accent)');
      button.setAttribute('aria-current', item.id === context.sessionId ? 'page' : 'false');
      button.setAttribute('aria-label', `${index + 1}. ${item.projectName}. ${item.title}`);
      button.title = `${item.projectName}\n${item.title}`;
      button.innerHTML = `<svg viewBox="0 0 600 600" aria-hidden="true"><path d="${d}"/><path class="session-wheel-tint" d="${d}"/></svg>
        <span class="session-wheel-label"><span class="session-wheel-key"><kbd>${index + 1}</kbd><span class="session-wheel-activity"></span></span><span class="session-wheel-title"></span><strong class="session-wheel-project"></strong></span>`;
      const label = button.querySelector('.session-wheel-label');
      const [x, y] = point(196, angle);
      label.style.left = `${x / 6}%`;
      label.style.top = `${y / 6}%`;
      button.querySelector('strong').textContent = item.projectName;
      button.querySelector('.session-wheel-title').textContent = item.title;
      button.onclick = () => select(index);
      stage.append(button);
      return button;
    });
    select(-1);
    dialog.showModal();
    renderActivity();
    dialog.focus({ preventScroll: true });
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        event.key === 'Alt' &&
        !event.repeat &&
        !held &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.getModifierState('AltGraph')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        open(event.code);
        return;
      }
      if (!held) return;
      if (event.key === 'Alt') {
        event.preventDefault();
        return;
      }
      const number = /^(?:Numpad|Digit)([1-6])$/.exec(event.code);
      if (number && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        select(Number(number[1]) - 1);
      } else if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(event.key === 'Enter');
      } else {
        // Alt+Tab, Alt+F4, Alt+arrows and AltGr remain system/browser shortcuts.
        close();
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (event) => {
      if (!held || event.code !== held) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    },
    true,
  );
  dialog.addEventListener('pointermove', (event) => {
    const index = buttons.indexOf(event.target.closest('.session-wheel-item'));
    if (index !== selected) select(index);
  });
  dialog.addEventListener('pointerleave', () => select(-1));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  window.addEventListener('blur', () => close());
  window.addEventListener('resize', () => close());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
  });
  return { renderActivity, cancel: () => close() };
}
