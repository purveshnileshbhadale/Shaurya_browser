/**
 * The Mode Switcher (spec §2) — the browser's signature control.
 *
 * Three things make this feel instant rather than merely fast:
 *
 * 1. **The switch is optimistic.** The chrome repaints from the mode document
 *    it already has, then the main process confirms. Waiting for a round trip
 *    before moving would put ~8ms of dead air on a control the user hits many
 *    times a day, and it is the dead air, not the milliseconds, that reads as
 *    sluggish.
 *
 * 2. **The transition is a crossfade on the chrome only.** Page views are
 *    siblings of the chrome in the view tree and are never touched, which is
 *    how "no lost tabs" is true by construction — there is no code path here
 *    that could close one.
 *
 * 3. **It is one keystroke away.** Ctrl/Cmd+M opens it; the same chord cycles
 *    with Shift. Digits 1-9 pick a mode directly from the open menu.
 */
import { h, icon, clear } from '../core/dom.js';
import { state, subscribe, invoke, toast } from '../core/store.js';

/** How long the chrome crossfade runs. Matched in chrome.css. */
const TRANSITION_MS = 220;

export function createModeSwitcher({ container }) {
  let menu = null;

  const label = h('span.mode-label');
  const button = h('button.mode-switch.no-drag', {
    title: 'Switch mode',
    'aria-haspopup': 'menu',
    onclick: (event) => {
      event.stopPropagation();
      toggleMenu(event.currentTarget);
    },
  }, h('span.mode-dot'), label, icon('chevronDown'));

  container.appendChild(button);

  subscribe('modes', render);
  render();

  function render() {
    const modes = state.modes || {};
    const active = modes.modes?.find((m) => m.id === modes.activeId);

    clear(label);
    label.textContent = active?.name || 'Default';
    button.dataset.mode = modes.activeId || 'default';
    button.title = active?.tagline
      ? `${active.name} — ${active.tagline}`
      : 'Switch mode';

    // The dot carries the mode's accent, so the control reads at a glance
    // even when the sidebar is collapsed and the label is hidden.
    if (active?.accent) button.style.setProperty('--mode-accent', active.accent);
    else button.style.removeProperty('--mode-accent');

    if (menu) renderMenu();
  }

  // -- menu --------------------------------------------------------------

  function toggleMenu(anchor) {
    if (menu) return closeMenu();

    menu = h('div.mode-menu', { role: 'menu' });
    document.body.appendChild(menu);
    renderMenu();

    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.left = `${Math.max(8, rect.left)}px`;

    // Close on the next click anywhere else, and on Escape. Registered on
    // the next frame so the click that opened it does not immediately close
    // it again.
    requestAnimationFrame(() => {
      document.addEventListener('click', onDocumentClick);
      document.addEventListener('keydown', onMenuKey);
    });
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onMenuKey);
  }

  function onDocumentClick(event) {
    if (!menu?.contains(event.target)) closeMenu();
  }

  function onMenuKey(event) {
    if (event.key === 'Escape') { closeMenu(); return; }

    // 1-9 pick a mode directly. Faster than arrowing, and the numbers are
    // rendered beside each row so the shortcut is discoverable rather than
    // folklore.
    const digit = Number(event.key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
      const target = (state.modes.modes || [])[digit - 1];
      if (target) { event.preventDefault(); activate(target.id); }
    }
  }

  function renderMenu() {
    if (!menu) return;
    clear(menu);

    const modes = state.modes?.modes || [];
    const activeId = state.modes?.activeId;

    menu.append(h('div.mode-menu-head', {},
      h('span', { text: 'Modes' }),
      h('kbd', { text: prettyChord() })));

    modes.forEach((mode, index) => {
      const row = h('button.mode-row', {
        role: 'menuitem',
        dataset: { mode: mode.id, active: String(mode.id === activeId) },
        onclick: () => activate(mode.id),
      },
      h('span.mode-row-icon', { style: mode.accent ? { color: mode.accent } : {} },
        icon(mode.icon || 'globe')),
      h('span.mode-row-text', {},
        h('span.mode-row-name', { text: mode.name }),
        h('span.mode-row-tagline', { text: mode.tagline || '' })),
      // A mode the user has adjusted says so, and offers the way back.
      mode.overrideCount
        ? h('span.mode-row-badge', {
          title: `${mode.overrideCount} change(s) from the preset — click to reset`,
          onclick: (event) => {
            event.stopPropagation();
            invoke('modes.resetOverrides', { id: mode.id })
              .then(() => toast(`${mode.name} reset to its preset`, 'success'));
          },
        }, h('span', { text: `${mode.overrideCount}` }))
        : null,
      index < 9 ? h('kbd.mode-row-key', { text: String(index + 1) }) : null);

      menu.appendChild(row);
    });

    menu.append(
      h('div.mode-menu-sep'),
      h('button.mode-row.mode-row-quiet', {
        onclick: () => {
          closeMenu();
          invoke('tabs.create', { url: 'shaurya://settings#modes' });
        },
      }, h('span.mode-row-icon', {}, icon('sliders')),
      h('span.mode-row-text', {},
        h('span.mode-row-name', { text: 'Build a custom mode…' }),
        h('span.mode-row-tagline', { text: 'Mix features from any mode' }))),
    );
  }

  // -- switching ---------------------------------------------------------

  async function activate(id) {
    closeMenu();
    if (id === state.modes?.activeId) return;

    const target = (state.modes.modes || []).find((m) => m.id === id);

    // Paint the transition immediately. The class drives a crossfade over
    // the chrome layer only; page views are separate siblings in the main
    // process's view tree and are not involved.
    const root = document.documentElement;
    root.classList.add('mode-switching');
    if (target?.accent) root.style.setProperty('--mode-accent', target.accent);

    try {
      const snapshot = await invoke('modes.activate', { id });
      // The main process is authoritative; adopt its answer even though we
      // already moved, so an override we did not know about is reflected.
      if (snapshot?.activeId) state.modes = snapshot;
    } catch (err) {
      toast(`Could not switch mode: ${err.message}`, 'error');
    } finally {
      setTimeout(() => root.classList.remove('mode-switching'), TRANSITION_MS);
    }
  }

  /** Cycle to the next mode — what the bare shortcut does. */
  function cycle(offset = 1) {
    const modes = state.modes?.modes || [];
    if (modes.length < 2) return;
    const index = modes.findIndex((m) => m.id === state.modes.activeId);
    const next = modes[(index + offset + modes.length) % modes.length];
    activate(next.id);
  }

  return { open: () => toggleMenu(button), close: closeMenu, activate, cycle, element: button };
}

function prettyChord() {
  return navigator.platform?.startsWith('Mac') ? '⌘M' : 'Ctrl+M';
}

/**
 * Quick actions a mode puts in the toolbar.
 *
 * A registry, not a switch: a mode names action ids in its document, and
 * anything registered here becomes available to every mode — including
 * custom ones — without this file knowing which modes exist.
 */
export const QUICK_ACTIONS = {
  turbo: {
    icon: 'zap',
    label: 'Turbo',
    active: () => state.perf?.turbo?.on === true,
    run: () => invoke('perf.turbo', { on: !state.perf?.turbo?.on })
      .then((s) => toast(s.on
        ? `Turbo on — ${s.suspendedTabs} tab(s) suspended`
        : 'Turbo off', 'success')),
  },
  record: {
    icon: 'record',
    label: 'Save clip',
    active: () => state.recorder?.bufferArmed === true,
    run: () => invoke('recorder.clip', {})
      .then((c) => toast(`Clipped the last ${c.seconds}s`, 'success'))
      .catch((err) => toast(err.message, 'error')),
  },
  overlay: {
    icon: 'gauge',
    label: 'Hardware overlay',
    active: () => state.perf?.overlay?.visible === true,
    run: () => invoke('overlay.toggle', {}),
  },
  devtools: {
    icon: 'code',
    label: 'DevTools',
    run: () => invoke('devtools.toggle', {}),
  },
  http: {
    icon: 'send',
    label: 'REST client',
    run: () => window.shauryaPanels?.open('dev'),
  },
  localservers: {
    icon: 'server',
    label: 'Local servers',
    run: () => window.shauryaPanels?.open('dev'),
  },
  teleprompter: {
    icon: 'text',
    label: 'Teleprompter',
    run: () => window.shauryaPanels?.open('assets'),
  },
  thumbnail: {
    icon: 'image',
    label: 'Thumbnail A/B',
    run: () => window.shauryaPanels?.open('brand'),
  },
  focuscanvas: {
    icon: 'maximize',
    label: 'Focus canvas',
    active: () => state.creator?.focusCanvas?.active === true,
    run: () => invoke('creator.setFocusCanvas', { active: !state.creator?.focusCanvas?.active }),
  },
  cite: {
    icon: 'quote',
    label: 'Cite this page',
    run: () => invoke('student.capture', {})
      .then((s) => toast(`Captured "${s.title}"`, 'success'))
      .catch((err) => toast(err.message, 'error')),
  },
  focustimer: {
    icon: 'clock',
    label: 'Focus timer',
    active: () => state.student?.timer?.running === true,
    run: () => (state.student?.timer?.running
      ? invoke('student.stopTimer', {})
      : invoke('student.startTimer', {})),
  },
  flashcards: {
    icon: 'cards',
    label: 'Make flashcards',
    run: () => window.shauryaPanels?.open('study'),
  },
  tor: {
    icon: 'shield',
    label: 'Route through Tor',
    run: () => invoke('ghost.routeTor', { enabled: true })
      .then((r) => toast(`Routed through Tor at ${r.endpoint}`, 'success'))
      .catch((err) => toast(err.message, 'error')),
  },
  shred: {
    icon: 'trash',
    label: 'Shred a download',
    run: () => window.shauryaPanels?.open('ghost'),
  },
  panic: {
    icon: 'alert',
    label: 'Panic — close and wipe',
    danger: true,
    run: () => invoke('ghost.panic', { scope: 'window' }).catch(() => {}),
  },
};

/**
 * Render the active mode's quick actions into a toolbar slot.
 * Re-rendered whenever the mode changes, which is the only time the set can.
 */
export function createQuickActions({ container }) {
  subscribe('modes', render);
  subscribe('perf', render);
  subscribe('recorder', render);
  render();

  function render() {
    clear(container);
    const ids = state.modes?.quickActions || [];

    for (const id of ids) {
      const action = QUICK_ACTIONS[id];
      // A mode may name an action this build does not have — a custom mode
      // written against a newer version, say. Skipping is correct; throwing
      // would take the whole toolbar down with it.
      if (!action) continue;

      const isActive = action.active?.() === true;
      container.appendChild(h('button.icon-btn.no-drag.quick-action', {
        title: action.label,
        dataset: { active: String(isActive), danger: String(action.danger === true) },
        onclick: () => action.run(),
      }, icon(action.icon)));
    }
  }
}
