'use strict';
/**
 * Feature Store (spec §7).
 *
 * Every heavy or "borrowed" subsystem is registered here with a cost
 * estimate and a default. Services ask `features.enabled(id)` before doing
 * expensive work, and turning a feature off genuinely tears its resources
 * down — the point is that a user who wants a minimal browser gets one,
 * not that a checkbox hides a button.
 */
const EventEmitter = require('node:events');

/**
 * @typedef {object} FeatureDef
 * @property {string} id
 * @property {string} name
 * @property {string} category
 * @property {string} description
 * @property {boolean} default
 * @property {'none'|'light'|'moderate'|'heavy'} cost   runtime footprint
 * @property {string} [costNote]
 * @property {boolean} [core]      cannot be disabled (privacy guarantees)
 * @property {string[]} [requires] other feature ids
 */

/** @type {FeatureDef[]} */
const CATALOG = [
  // ---- Privacy ---------------------------------------------------------
  { id: 'adblock', name: 'Ad & Tracker Blocking', category: 'Privacy',
    description: 'Network-layer filtering with auto-updating EasyList/EasyPrivacy rules.',
    default: true, cost: 'light', costNote: '~40 MB resident for the compiled rule index' },
  { id: 'vpn', name: 'Aether VPN', category: 'Privacy',
    description: 'WireGuard tunnel with kill switch. Free tier is bandwidth-capped.',
    default: false, cost: 'moderate', costNote: 'Adds a background tunnel process' },
  { id: 'passwords', name: 'Password Manager', category: 'Privacy',
    description: 'Local encrypted vault, autofill and breach checking.',
    default: true, cost: 'light' },
  { id: 'fingerprint', name: 'Fingerprint Resistance', category: 'Privacy',
    description: 'Normalises canvas, audio, font and hardware signals.',
    default: true, cost: 'light' },
  { id: 'httpsOnly', name: 'HTTPS-Only Mode', category: 'Privacy',
    description: 'Upgrades every navigation to HTTPS and interstitials on failure.',
    default: true, cost: 'none' },

  // ---- Interface -------------------------------------------------------
  { id: 'verticalTabs', name: 'Vertical Tabs', category: 'Interface',
    description: 'Sidebar tab strip with groups and workspaces.',
    default: true, cost: 'none' },
  { id: 'splitView', name: 'Split Screen', category: 'Interface',
    description: 'Two tabs side by side with a draggable divider.',
    default: true, cost: 'light', costNote: 'A second live renderer stays resident' },
  { id: 'commandPalette', name: 'Command Palette', category: 'Interface',
    description: 'Ctrl/Cmd+K fuzzy search over tabs, history, bookmarks, settings.',
    default: true, cost: 'none' },
  { id: 'startPage', name: 'Custom Start Page', category: 'Interface',
    description: 'Speed dial, background and widgets.',
    default: true, cost: 'none' },
  { id: 'hibernation', name: 'Tab Hibernation', category: 'Interface',
    description: 'Suspends idle tabs to reclaim memory and CPU.',
    default: true, cost: 'none', costNote: 'Saves memory rather than costing it' },
  { id: 'screenshot', name: 'Screenshot & Annotation', category: 'Interface',
    description: 'Region, visible and full-page capture with markup tools.',
    default: true, cost: 'light' },
  { id: 'reader', name: 'Reader Mode', category: 'Interface',
    description: 'Distraction-free article view.', default: true, cost: 'none' },
  { id: 'pip', name: 'Picture-in-Picture', category: 'Interface',
    description: 'Detach any video into a floating always-on-top window.',
    default: true, cost: 'none' },
  { id: 'gestures', name: 'Trackpad Gestures', category: 'Interface',
    description: 'Swipe to navigate, pinch to zoom.', default: true, cost: 'none' },

  // ---- AI --------------------------------------------------------------
  { id: 'ai', name: 'AI Assistant', category: 'AI',
    description: 'Side-panel assistant grounded in the current tab.',
    default: true, cost: 'moderate', costNote: 'On-device model uses ~1.5 GB when loaded' },
  { id: 'aiNotes', name: 'AI Notes', category: 'AI',
    description: 'Turn articles, transcripts and PDFs into structured notes.',
    default: true, cost: 'light', requires: ['ai'] },
  { id: 'aiLocal', name: 'On-Device Inference', category: 'AI',
    description: 'Runs quick tasks locally so page text never leaves the machine.',
    default: false, cost: 'heavy', costNote: 'Downloads and resident model weights',
    requires: ['ai'] },

  // ---- Developer -------------------------------------------------------
  { id: 'devtools', name: 'Developer Tools', category: 'Developer',
    description: 'Full Chrome DevTools plus the Aether dev panels.',
    default: true, cost: 'light' },
  { id: 'httpClient', name: 'REST Client', category: 'Developer',
    description: 'Sidebar HTTP client with saved collections and timing.',
    default: true, cost: 'light', requires: ['devtools'] },
  { id: 'wsInspector', name: 'WebSocket Inspector', category: 'Developer',
    description: 'Live frame log for every open socket.',
    default: true, cost: 'light', requires: ['devtools'] },
  { id: 'jsonViewer', name: 'JSON Viewer', category: 'Developer',
    description: 'Auto-formats raw JSON responses.', default: true, cost: 'none' },
  { id: 'markdownPreview', name: 'Markdown Preview', category: 'Developer',
    description: 'Renders local .md files opened in the browser.',
    default: true, cost: 'none' },
  { id: 'localServers', name: 'Localhost Manager', category: 'Developer',
    description: 'Launch static servers and list listening ports.',
    default: true, cost: 'light', requires: ['devtools'] },
  { id: 'gitCards', name: 'Git-Aware Bookmarks', category: 'Developer',
    description: 'PR status, CI checks and diffs on GitHub/GitLab hover.',
    default: true, cost: 'light' },
  { id: 'colorTools', name: 'Color Picker & Contrast', category: 'Developer',
    description: 'Screen eyedropper with WCAG contrast readout.',
    default: true, cost: 'none', requires: ['devtools'] },
  { id: 'responsiveMode', name: 'Responsive Design Mode', category: 'Developer',
    description: 'Device presets and network throttling.',
    default: true, cost: 'none', requires: ['devtools'] },
  { id: 'extensionDev', name: 'Extension Developer Mode', category: 'Developer',
    description: 'Load unpacked extensions with hot reload and a manifest linter.',
    default: false, cost: 'light' },

  // ---- Data ------------------------------------------------------------
  { id: 'sync', name: 'Encrypted Sync', category: 'Data',
    description: 'Zero-knowledge sync across desktop and Android.',
    default: false, cost: 'light' },
  { id: 'sessions', name: 'Named Sessions', category: 'Data',
    description: 'Save and reopen exact window layouts including split state.',
    default: true, cost: 'none' },
  { id: 'pwa', name: 'PWA Install', category: 'Data',
    description: 'Install sites as standalone app windows.',
    default: true, cost: 'none' },
  { id: 'history', name: 'Browsing History', category: 'Data',
    description: 'Records visited pages locally for search and the palette.',
    default: true, cost: 'none' },
];

class FeatureStore extends EventEmitter {
  /** @param {import('./settings').SettingsService} settings */
  constructor(settings) {
    super();
    this.settings = settings;
    this.catalog = CATALOG;
    this._byId = new Map(CATALOG.map((f) => [f.id, f]));
    this._seedDefaults();
  }

  _seedDefaults() {
    const current = this.settings.get('features') || {};
    let dirty = false;
    for (const f of CATALOG) {
      if (typeof current[f.id] !== 'boolean') {
        current[f.id] = f.default;
        dirty = true;
      }
    }
    if (dirty) this.settings.set('features', current);
  }

  /** Is a feature on? Unknown ids are treated as off (fail closed). */
  enabled(id) {
    const def = this._byId.get(id);
    if (!def) return false;
    if (def.core) return true;
    const on = this.settings.get(`features.${id}`) === true;
    if (!on) return false;
    // A feature is only really on when its dependencies are.
    return (def.requires || []).every((dep) => this.enabled(dep));
  }

  /**
   * Toggle a feature. Cascades: enabling pulls in requirements, disabling
   * pushes down dependents, so the UI can never land in an inconsistent
   * state like "REST client on, DevTools off".
   */
  toggle(id, value) {
    const def = this._byId.get(id);
    if (!def) throw new Error(`unknown feature "${id}"`);
    if (def.core) throw new Error(`"${id}" is a core guarantee and cannot be disabled`);

    const next = { ...(this.settings.get('features') || {}) };
    const changed = [];

    const setOn = (fid) => {
      if (next[fid] === true) return;
      next[fid] = true;
      changed.push(fid);
      for (const dep of this._byId.get(fid)?.requires || []) setOn(dep);
    };
    const setOff = (fid) => {
      if (next[fid] === false) return;
      next[fid] = false;
      changed.push(fid);
      for (const other of CATALOG) {
        if ((other.requires || []).includes(fid)) setOff(other.id);
      }
    };

    if (value) setOn(id); else setOff(id);

    this.settings.set('features', next);
    for (const fid of changed) this.emit('toggled', { id: fid, enabled: next[fid] });
    this.emit('changed', this.list());
    return this.list();
  }

  /** Catalog + current state, grouped for the settings screen. */
  list() {
    const state = this.settings.get('features') || {};
    return CATALOG.map((f) => ({
      ...f,
      enabled: this.enabled(f.id),
      raw: state[f.id] === true,
      blockedBy: (f.requires || []).filter((d) => !this.enabled(d)),
    }));
  }

  /** Rough footprint estimate shown in the Feature Store header. */
  footprint() {
    const weights = { none: 0, light: 1, moderate: 3, heavy: 8 };
    const on = CATALOG.filter((f) => this.enabled(f.id));
    const score = on.reduce((n, f) => n + weights[f.cost], 0);
    return { activeCount: on.length, total: CATALOG.length, score,
      label: score <= 4 ? 'minimal' : score <= 10 ? 'balanced' : 'full' };
  }
}

module.exports = { FeatureStore, CATALOG };
