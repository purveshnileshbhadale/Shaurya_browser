'use strict';
/**
 * Keyboard-first navigation with a fully remappable scheme (spec §5).
 *
 * Every command in Shaurya is reachable from here, and every binding can be
 * changed. Two design points:
 *
 *  - Accelerators are stored in Electron's platform-neutral form
 *    (`CmdOrCtrl+K`), so one scheme is correct on macOS and Windows/Linux
 *    without a per-platform table.
 *  - Conflicts are detected and reported rather than silently allowed. Two
 *    commands on one chord means one of them appears broken.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../util/logger');

const log = createLogger('shortcuts');

/**
 * The default scheme. `scope: 'global'` bindings work even while focus is in
 * page content; `scope: 'chrome'` only when the browser UI has focus.
 */
const DEFAULTS = [
  // --- navigation ---
  { id: 'tab.new', label: 'New tab', group: 'Tabs', accelerator: 'CmdOrCtrl+T' },
  { id: 'tab.close', label: 'Close tab', group: 'Tabs', accelerator: 'CmdOrCtrl+W' },
  { id: 'tab.reopen', label: 'Reopen closed tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'tab.next', label: 'Next tab', group: 'Tabs', accelerator: 'Control+Tab' },
  { id: 'tab.previous', label: 'Previous tab', group: 'Tabs', accelerator: 'Control+Shift+Tab' },
  { id: 'tab.duplicate', label: 'Duplicate tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+D' },
  { id: 'tab.pin', label: 'Pin or unpin tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+P' },
  { id: 'tab.hibernate', label: 'Hibernate tab', group: 'Tabs', accelerator: 'CmdOrCtrl+Shift+H' },

  { id: 'window.new', label: 'New window', group: 'Window', accelerator: 'CmdOrCtrl+N' },
  { id: 'window.incognito', label: 'New private window', group: 'Window', accelerator: 'CmdOrCtrl+Shift+N' },
  { id: 'window.close', label: 'Close window', group: 'Window', accelerator: 'CmdOrCtrl+Shift+W' },
  { id: 'window.fullscreen', label: 'Toggle full screen', group: 'Window', accelerator: process.platform === 'darwin' ? 'Control+Cmd+F' : 'F11' },

  { id: 'nav.back', label: 'Back', group: 'Navigation', accelerator: process.platform === 'darwin' ? 'Cmd+Left' : 'Alt+Left' },
  { id: 'nav.forward', label: 'Forward', group: 'Navigation', accelerator: process.platform === 'darwin' ? 'Cmd+Right' : 'Alt+Right' },
  { id: 'nav.reload', label: 'Reload', group: 'Navigation', accelerator: 'CmdOrCtrl+R' },
  { id: 'nav.hardReload', label: 'Reload ignoring cache', group: 'Navigation', accelerator: 'CmdOrCtrl+Shift+R' },
  { id: 'nav.stop', label: 'Stop loading', group: 'Navigation', accelerator: 'Escape', scope: 'chrome' },
  { id: 'nav.home', label: 'Home', group: 'Navigation', accelerator: 'Alt+Home' },
  { id: 'nav.focusAddress', label: 'Focus address bar', group: 'Navigation', accelerator: 'CmdOrCtrl+L' },

  // --- interface ---
  { id: 'palette.open', label: 'Command palette', group: 'Interface', accelerator: 'CmdOrCtrl+K' },
  { id: 'sidebar.toggle', label: 'Toggle sidebar', group: 'Interface', accelerator: 'CmdOrCtrl+B' },
  { id: 'tabs.orientation', label: 'Switch vertical/horizontal tabs', group: 'Interface', accelerator: 'CmdOrCtrl+Alt+B' },
  { id: 'split.toggle', label: 'Toggle split screen', group: 'Interface', accelerator: 'CmdOrCtrl+Alt+S' },
  { id: 'reader.toggle', label: 'Reader mode', group: 'Interface', accelerator: 'CmdOrCtrl+Alt+R' },
  { id: 'pip.toggle', label: 'Picture-in-picture', group: 'Interface', accelerator: 'CmdOrCtrl+Alt+P' },
  { id: 'find.open', label: 'Find in page', group: 'Interface', accelerator: 'CmdOrCtrl+F' },
  { id: 'zoom.in', label: 'Zoom in', group: 'Interface', accelerator: 'CmdOrCtrl+Plus' },
  { id: 'zoom.out', label: 'Zoom out', group: 'Interface', accelerator: 'CmdOrCtrl+-' },
  { id: 'zoom.reset', label: 'Reset zoom', group: 'Interface', accelerator: 'CmdOrCtrl+0' },

  // --- panels ---
  // --- modes (spec §2) --------------------------------------------------
  { id: 'mode.switch', label: 'Open the Mode Switcher', group: 'Modes', accelerator: 'CmdOrCtrl+M' },
  { id: 'mode.next', label: 'Next mode', group: 'Modes', accelerator: 'CmdOrCtrl+Alt+M' },
  { id: 'mode.previous', label: 'Previous mode', group: 'Modes', accelerator: 'CmdOrCtrl+Alt+Shift+M' },
  { id: 'mode.default', label: 'Switch to Default', group: 'Modes', accelerator: '' },
  { id: 'mode.programmer', label: 'Switch to Programmer', group: 'Modes', accelerator: '' },
  { id: 'mode.gamer', label: 'Switch to Gamer', group: 'Modes', accelerator: '' },
  { id: 'mode.creator', label: 'Switch to Creator', group: 'Modes', accelerator: '' },
  { id: 'mode.student', label: 'Switch to Student', group: 'Modes', accelerator: '' },
  { id: 'mode.ghost', label: 'Switch to Ghost', group: 'Modes', accelerator: '' },

  // --- mode features ----------------------------------------------------
  { id: 'turbo.toggle', label: 'Toggle Turbo', group: 'Gaming', accelerator: 'CmdOrCtrl+Alt+T' },
  { id: 'recorder.clip', label: 'Save the last N seconds', group: 'Gaming', accelerator: 'CmdOrCtrl+Alt+C' },
  { id: 'overlay.toggle', label: 'Hardware overlay', group: 'Gaming', accelerator: 'CmdOrCtrl+Alt+O' },
  { id: 'student.cite', label: 'Cite this page', group: 'Student', accelerator: 'CmdOrCtrl+Alt+K' },
  { id: 'student.timer', label: 'Start or stop the focus timer', group: 'Student', accelerator: 'CmdOrCtrl+Alt+P' },
  { id: 'creator.focusCanvas', label: 'Focus canvas', group: 'Creator', accelerator: 'CmdOrCtrl+Alt+F' },
  // Deliberately a chord nobody hits by accident: this closes windows and
  // wipes state, and a single key would be a footgun on a shared machine.
  { id: 'ghost.panic', label: 'Panic — close and wipe', group: 'Ghost', accelerator: 'CmdOrCtrl+Alt+Shift+Backspace' },

  { id: 'panel.ai', label: 'AI assistant', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+A' },
  { id: 'panel.notes', label: 'Notes', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+M' },
  { id: 'panel.http', label: 'REST client', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+E' },
  { id: 'panel.ws', label: 'WebSocket inspector', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+K' },
  { id: 'panel.servers', label: 'Localhost manager', group: 'Panels', accelerator: 'CmdOrCtrl+Shift+L' },

  // --- developer ---
  { id: 'devtools.toggle', label: 'Developer tools', group: 'Developer', accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
  { id: 'devtools.console', label: 'Console', group: 'Developer', accelerator: process.platform === 'darwin' ? 'Alt+Cmd+J' : 'Ctrl+Shift+J' },
  { id: 'responsive.toggle', label: 'Responsive design mode', group: 'Developer', accelerator: process.platform === 'darwin' ? 'Alt+Cmd+M' : 'Ctrl+Shift+M' },
  { id: 'colorpicker.open', label: 'Colour picker', group: 'Developer', accelerator: 'CmdOrCtrl+Shift+C' },
  { id: 'source.view', label: 'View source', group: 'Developer', accelerator: 'CmdOrCtrl+U' },

  // --- capture & data ---
  { id: 'capture.region', label: 'Capture region', group: 'Capture', accelerator: 'CmdOrCtrl+Shift+S' },
  { id: 'capture.fullPage', label: 'Capture full page', group: 'Capture', accelerator: 'CmdOrCtrl+Shift+F' },
  { id: 'notes.generate', label: 'Generate notes from page', group: 'Capture', accelerator: 'CmdOrCtrl+Shift+G' },
  { id: 'bookmark.add', label: 'Bookmark this page', group: 'Data', accelerator: 'CmdOrCtrl+D' },
  { id: 'history.open', label: 'History', group: 'Data', accelerator: 'CmdOrCtrl+Y' },
  { id: 'downloads.open', label: 'Downloads', group: 'Data', accelerator: 'CmdOrCtrl+J' },
  { id: 'settings.open', label: 'Settings', group: 'Data', accelerator: 'CmdOrCtrl+,' },
  { id: 'session.save', label: 'Save session', group: 'Data', accelerator: 'CmdOrCtrl+Alt+N' },
  { id: 'vault.lock', label: 'Lock password vault', group: 'Data', accelerator: 'CmdOrCtrl+Alt+L' },
];

class ShortcutService extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.commands = DEFAULTS;
    this._byId = new Map(DEFAULTS.map((c) => [c.id, c]));
  }

  init() {
    const conflicts = this.conflicts();
    if (conflicts.length) {
      log.warn(`shortcut conflicts: ${conflicts.map((c) => c.accelerator).join(', ')}`);
    }
  }

  /** Current scheme: defaults merged with the user's overrides. */
  list() {
    const overrides = this.settings.get('shortcuts') || {};
    return this.commands.map((c) => ({
      ...c,
      accelerator: overrides[c.id] !== undefined ? overrides[c.id] : c.accelerator,
      customised: overrides[c.id] !== undefined,
      scope: c.scope || 'global',
    }));
  }

  /** The accelerator currently bound to a command id. */
  accelerator(id) {
    const overrides = this.settings.get('shortcuts') || {};
    if (overrides[id] !== undefined) return overrides[id];
    return this._byId.get(id)?.accelerator ?? null;
  }

  /**
   * Rebind a command. Pass `null` to unbind it entirely.
   * @returns {{ok:boolean, conflictsWith?:string}}
   */
  set(id, accelerator) {
    if (!this._byId.has(id)) throw new Error(`unknown command "${id}"`);

    if (accelerator) {
      const normalised = normalise(accelerator);
      const clash = this.list().find((c) => c.id !== id && normalise(c.accelerator) === normalised);
      if (clash) {
        // Refuse rather than silently shadowing: the user should decide
        // which command loses the chord.
        return { ok: false, conflictsWith: clash.id, conflictLabel: clash.label };
      }
      accelerator = normalised;
    }

    const overrides = { ...(this.settings.get('shortcuts') || {}) };
    overrides[id] = accelerator;
    this.settings.set('shortcuts', overrides);
    this.emit('changed', this.list());
    return { ok: true, accelerator };
  }

  /** Reset one command, or the whole scheme. */
  reset(id) {
    const overrides = { ...(this.settings.get('shortcuts') || {}) };
    if (id) delete overrides[id];
    else Object.keys(overrides).forEach((k) => delete overrides[k]);
    this.settings.set('shortcuts', id ? overrides : {});
    this.emit('changed', this.list());
    return this.list();
  }

  /** Any chord bound to more than one command. */
  conflicts() {
    const byAccel = new Map();
    for (const c of this.list()) {
      if (!c.accelerator) continue;
      const key = normalise(c.accelerator);
      const list = byAccel.get(key) || [];
      list.push(c.id);
      byAccel.set(key, list);
    }
    return [...byAccel.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([accelerator, ids]) => ({ accelerator, ids }));
  }

  /** Resolve a renderer keydown into a command id. */
  match({ key, ctrlKey, metaKey, altKey, shiftKey }) {
    const parts = [];
    if (ctrlKey || metaKey) parts.push('CmdOrCtrl');
    if (altKey) parts.push('Alt');
    if (shiftKey) parts.push('Shift');
    parts.push(normaliseKey(key));
    const chord = normalise(parts.join('+'));

    // Also try the platform-explicit forms so `Cmd+Left` matches on macOS.
    const explicit = normalise(
      [...(metaKey ? ['Cmd'] : []), ...(ctrlKey ? ['Control'] : []),
        ...(altKey ? ['Alt'] : []), ...(shiftKey ? ['Shift'] : []),
        normaliseKey(key)].join('+')
    );

    for (const c of this.list()) {
      if (!c.accelerator) continue;
      const bound = normalise(c.accelerator);
      if (bound === chord || bound === explicit) return c.id;
    }
    return null;
  }
}

/** Canonical form for comparison: sorted modifiers, uppercase key. */
function normalise(accelerator) {
  if (!accelerator) return '';
  const parts = String(accelerator).split('+').map((p) => p.trim());
  const key = parts.pop();
  const mods = parts
    .map((m) => (/^(cmd|command|meta|super)$/i.test(m) ? 'CmdOrCtrl'
      : /^(ctrl|control)$/i.test(m) ? 'Control'
        : /^(cmdorctrl|commandorcontrol)$/i.test(m) ? 'CmdOrCtrl'
          : /^alt|option$/i.test(m) ? 'Alt'
            : /^shift$/i.test(m) ? 'Shift' : m))
    .sort();
  return [...new Set(mods), normaliseKey(key)].join('+');
}

function normaliseKey(key) {
  if (!key) return '';
  const map = {
    ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right',
    ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', '+': 'Plus',
  };
  const mapped = map[key] || key;
  return mapped.length === 1 ? mapped.toUpperCase() : mapped;
}

module.exports = { ShortcutService, DEFAULTS: DEFAULTS, normalise };
