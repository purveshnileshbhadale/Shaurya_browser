'use strict';
/**
 * Modes (spec §2 "Mode Switcher", §3, §4, §5).
 *
 * A mode is a *document*, not a code path. It names which features are on,
 * which panels the chrome offers, how the chrome looks, and which runtime
 * behaviours are armed. Switching modes swaps the document; nothing branches
 * on `if (mode === 'gamer')` anywhere in the UI or the services.
 *
 * That is a deliberate constraint from the spec ("swappable panels rather
 * than hardcoded branches, so future modes can be added the same way"), and
 * it is what makes custom modes possible at all: a user-built mode is the
 * same shape as a built-in one, so it needs no new support anywhere.
 *
 * Three layers decide whether a feature is on, nearest wins:
 *
 *   1. user override for the active mode   settings.modes.overrides[modeId]
 *   2. the mode document's own overlay     mode.features
 *   3. the user's stored preference        settings.features
 *
 * The stored preference is never written by a mode switch. That is the whole
 * point of the layering: a round trip through Gamer Mode must leave Default
 * exactly as it was, or the switcher quietly eats the user's configuration.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../util/logger');

const log = createLogger('modes');

/**
 * @typedef {object} ModeDoc
 * @property {string} id
 * @property {string} name
 * @property {string} tagline        one line, shown in the switcher
 * @property {string} icon
 * @property {string} [accent]       hex; overrides appearance.accent while active
 * @property {boolean} [builtin]
 * @property {string} [basedOn]      for custom modes: the builtin it started from
 * @property {Record<string, boolean>} features   overlay on the Feature Store
 * @property {object} [appearance]   theme/density/font overrides while active
 * @property {string[]} panels       side-panel ids this mode surfaces, in order
 * @property {string[]} [quickActions] toolbar action ids beyond the baseline
 * @property {object} [behaviors]    runtime switches services subscribe to
 */

/**
 * The baseline every mode shares. Listed explicitly rather than left implicit
 * so that a mode which omits a key is visibly *not overriding* it, instead of
 * accidentally inheriting whatever the previous mode set.
 */
const BASELINE_PANELS = ['ai', 'notes'];

/** @type {ModeDoc[]} */
const BUILTIN_MODES = [
  {
    id: 'default',
    name: 'Default',
    tagline: 'The browser, as you configured it.',
    icon: 'globe',
    builtin: true,
    // No overlay at all: Default is defined as "whatever the user chose".
    // An empty object here is load-bearing, not a placeholder.
    features: {},
    appearance: {},
    panels: [...BASELINE_PANELS, 'dev'],
    quickActions: [],
    behaviors: {},
  },

  {
    id: 'programmer',
    name: 'Programmer',
    tagline: 'DevTools, REST, sockets and a dense terminal chrome.',
    icon: 'code',
    accent: '#4ade80',
    builtin: true,
    features: {
      devtools: true, httpClient: true, wsInspector: true, jsonViewer: true,
      localServers: true, colorTools: true, responsiveMode: true,
      gitCards: true, markdownPreview: true, extensionDev: true,
      sessions: true, commandPalette: true,
      // Gaming machinery is explicitly off rather than merely unmentioned:
      // a user who enabled Turbo in Gamer Mode should not carry it into a
      // debugging session, where suspended background tabs look like bugs.
      turbo: false, lowLatency: false, hardwareOverlay: false,
      recorder: false, streamPlayer: false, gameFeeds: false,
      deals: false, gamepadNav: false, rgbTheme: false, tabLimits: false,
    },
    appearance: {
      theme: 'dark',
      density: 'compact',
      monoUi: true,
      backgroundFx: 'none',
      roundedCorners: 6,
    },
    panels: ['dev', 'ai', 'notes'],
    quickActions: ['devtools', 'http', 'localservers'],
    behaviors: {
      devtoolsOneClick: true,
      preferMonospace: true,
    },
  },

  {
    id: 'gamer',
    name: 'Gamer',
    tagline: 'Turbo, overlays, clips and streams.',
    icon: 'gamepad',
    accent: '#a855f7',
    builtin: true,
    features: {
      turbo: true, lowLatency: true, hardwareOverlay: true, tabLimits: true,
      recorder: true, streamPlayer: true, gameFeeds: true, deals: true,
      gamepadNav: true, rgbTheme: true, hibernation: true,
      // Dev panels leave the toolbar, but DevTools itself stays available —
      // removing a browser's inspector because someone is gaming would be
      // gratuitous, and F12 must keep working.
      httpClient: false, wsInspector: false, localServers: false,
      responsiveMode: false, extensionDev: false,
    },
    appearance: {
      theme: 'dark',
      density: 'comfortable',
      monoUi: false,
      backgroundFx: 'rgb',
      roundedCorners: 14,
    },
    panels: ['stream', 'games', 'deals', 'perf', 'ai'],
    quickActions: ['turbo', 'record', 'overlay'],
    behaviors: {
      aggressiveHibernate: true,
      suspendBackgroundOnTurbo: true,
      gamepadNav: true,
    },
  },

  {
    id: 'creator',
    name: 'Creator',
    tagline: 'Assets, brand kit, scheduling and a teleprompter.',
    icon: 'wand',
    accent: '#f97316',
    builtin: true,
    features: {
      assetLibrary: true, brandKit: true, uploadScheduler: true,
      thumbnailAB: true, creatorAnalytics: true, teleprompter: true,
      focusCanvas: true, screenshot: true, aiNotes: true,
      turbo: false, lowLatency: false, hardwareOverlay: false,
      gamepadNav: false, rgbTheme: false, extensionDev: false,
    },
    appearance: {
      theme: 'dark',
      density: 'comfortable',
      monoUi: false,
      backgroundFx: 'none',
      roundedCorners: 16,
    },
    panels: ['assets', 'brand', 'schedule', 'ai', 'notes'],
    quickActions: ['teleprompter', 'thumbnail', 'focuscanvas'],
    behaviors: {
      hideChromeOnFocusCanvas: true,
    },
  },

  {
    id: 'student',
    name: 'Student',
    tagline: 'Citations, PDFs, flashcards and a focus timer.',
    icon: 'book',
    accent: '#0ea5e9',
    builtin: true,
    features: {
      citations: true, pdfAnnotate: true, focusBlocker: true,
      flashcards: true, deadlines: true, ocrSearch: true, studyRoom: true,
      ai: true, aiNotes: true, reader: true,
      turbo: false, hardwareOverlay: false, recorder: false,
      streamPlayer: false, gameFeeds: false, deals: false,
      gamepadNav: false, rgbTheme: false, extensionDev: false,
    },
    appearance: {
      theme: 'light',
      density: 'comfortable',
      monoUi: false,
      backgroundFx: 'none',
      roundedCorners: 12,
    },
    panels: ['study', 'citations', 'deadlines', 'ai', 'notes'],
    quickActions: ['cite', 'focustimer', 'flashcards'],
    behaviors: {
      readerFirst: true,
    },
  },

  {
    id: 'ghost',
    name: 'Ghost',
    tagline: 'Tor, randomised fingerprints, and a panic key.',
    icon: 'ghost',
    accent: '#94a3b8',
    builtin: true,
    features: {
      tor: true, fingerprintRandom: true, metadataStrip: true,
      shredder: true, breachMonitor: true, dohPicker: true,
      panicButton: true, fingerprint: true, httpsOnly: true, adblock: true,
      // Everything that keeps a record, or talks to a third party on the
      // user's behalf, is off. Ghost Mode that quietly wrote history or
      // synced would be worse than no Ghost Mode, because it would be
      // trusted.
      history: false, sync: false, aiNotes: false, gameFeeds: false,
      deals: false, creatorAnalytics: false, uploadScheduler: false,
      streamPlayer: false, recorder: false, hardwareOverlay: false,
      startPage: false, gitCards: false,
    },
    appearance: {
      theme: 'dark',
      density: 'compact',
      monoUi: false,
      backgroundFx: 'none',
      roundedCorners: 4,
    },
    panels: ['ghost', 'breach', 'ai'],
    quickActions: ['tor', 'panic', 'shred'],
    behaviors: {
      minimalChrome: true,
      distinctWindow: true,
      noHistory: true,
      panicKey: true,
    },
  },
];

/** Appearance keys a mode is allowed to touch. Anything else is ignored. */
const APPEARANCE_KEYS = [
  'theme', 'density', 'monoUi', 'backgroundFx', 'roundedCorners', 'animations',
];

class ModeService extends EventEmitter {
  /**
   * @param {import('./settings').SettingsService} settings
   * @param {import('./feature-store').FeatureStore} features
   */
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;

    // Wire both directions of the overlay. `enabled()` consults resolve();
    // toggles made while a mode is active land in that mode's overrides.
    this.features.setResolver((id) => this.resolveFeature(id));
    this._syncOverrideSink();
  }

  // -- catalog -----------------------------------------------------------

  /** Every mode, built-in first, each marked with whether it is active. */
  list() {
    const activeId = this.activeId();
    return [...BUILTIN_MODES, ...this.customModes()].map((m) => ({
      ...m,
      active: m.id === activeId,
      // Overrides are per-mode, so the badge can say "3 changes from the
      // preset" and offer a reset without touching the preset itself.
      overrideCount: Object.keys(this._overridesFor(m.id)).length,
    }));
  }

  /** @returns {ModeDoc[]} */
  customModes() {
    const stored = this.settings.get('modes.custom');
    return Array.isArray(stored) ? stored : [];
  }

  activeId() {
    const id = this.settings.get('modes.active') || 'default';
    // A custom mode can be deleted while active; fall back rather than
    // leaving the browser pointing at a document that no longer exists.
    return this.byId(id) ? id : 'default';
  }

  /** @returns {ModeDoc|null} */
  byId(id) {
    return BUILTIN_MODES.find((m) => m.id === id)
      || this.customModes().find((m) => m.id === id)
      || null;
  }

  /** The active mode document, with user overrides folded into `features`. */
  active() {
    const doc = this.byId(this.activeId()) || BUILTIN_MODES[0];
    return {
      ...doc,
      features: { ...(doc.features || {}), ...this._overridesFor(doc.id) },
      appearance: this.appearanceFor(doc.id),
      panels: doc.panels || BASELINE_PANELS,
      behaviors: doc.behaviors || {},
    };
  }

  // -- feature resolution ------------------------------------------------

  /**
   * The overlay the Feature Store consults.
   * @returns {boolean|undefined} undefined means "no opinion".
   */
  resolveFeature(featureId) {
    const id = this.activeId();
    const overrides = this._overridesFor(id);
    if (typeof overrides[featureId] === 'boolean') return overrides[featureId];

    const doc = this.byId(id);
    const overlay = doc?.features || {};
    if (typeof overlay[featureId] === 'boolean') return overlay[featureId];

    return undefined;
  }

  _overridesFor(modeId) {
    const all = this.settings.get('modes.overrides') || {};
    return all[modeId] || {};
  }

  /**
   * Default mode deliberately has *no* override sink: with no overlay in
   * play, a toggle there is a plain preference change and should behave
   * exactly as it did before modes existed.
   */
  _syncOverrideSink() {
    if (this.activeId() === 'default') {
      this.features.setOverrideSink(null);
    } else {
      this.features.setOverrideSink((changes) => this._writeOverrides(changes));
    }
  }

  _writeOverrides(changes) {
    const modeId = this.activeId();
    const all = { ...(this.settings.get('modes.overrides') || {}) };
    all[modeId] = { ...(all[modeId] || {}), ...changes };
    this.settings.set('modes.overrides', all);
    this.emit('changed', this.snapshot());
  }

  /** Forget this mode's user overrides, returning it to its preset. */
  resetOverrides(modeId = this.activeId()) {
    const all = { ...(this.settings.get('modes.overrides') || {}) };
    delete all[modeId];
    this.settings.set('modes.overrides', all);
    this.features.refresh();
    this.emit('changed', this.snapshot());
    return this.snapshot();
  }

  // -- appearance --------------------------------------------------------

  /**
   * The appearance the chrome should render, mode overrides folded over the
   * user's own appearance settings.
   *
   * A mode supplies *presentation*, so it wins while it is active — but only
   * for the keys it actually names, and only in memory. `settings.appearance`
   * is never written, so leaving the mode restores the user's look exactly.
   */
  appearanceFor(modeId = this.activeId()) {
    const base = this.settings.get('appearance') || {};
    const doc = this.byId(modeId);
    const over = doc?.appearance || {};

    const merged = { ...base };
    for (const key of APPEARANCE_KEYS) {
      if (over[key] !== undefined) merged[key] = over[key];
    }
    if (doc?.accent) merged.accent = doc.accent;
    // Honour the user's own animation preference even inside a mode that
    // wants motion: reduced-motion is an accessibility need, not a style.
    if (base.animations === false) merged.animations = false;
    return merged;
  }

  // -- switching ---------------------------------------------------------

  /**
   * Activate a mode.
   *
   * Deliberately cheap: it writes one setting, re-points the overlay, and
   * announces. It does not touch tabs, sessions, windows or profiles, which
   * is what makes "no restart, no lost tabs" true by construction rather
   * than by careful bookkeeping.
   */
  activate(id) {
    const doc = this.byId(id);
    if (!doc) throw new Error(`unknown mode "${id}"`);

    const previous = this.activeId();
    if (previous === id) return this.snapshot();

    this.settings.set('modes.active', id);
    this.settings.set('modes.lastUsed', { ...(this.settings.get('modes.lastUsed') || {}), [id]: Date.now() });
    this._syncOverrideSink();

    // Every feature whose resolved value could have moved: the union of both
    // documents' overlays and both override sets. Narrower than "everything",
    // so subsystems that did not change do not get torn down and rebuilt.
    const touched = new Set([
      ...Object.keys(this.byId(previous)?.features || {}),
      ...Object.keys(doc.features || {}),
      ...Object.keys(this._overridesFor(previous)),
      ...Object.keys(this._overridesFor(id)),
    ]);
    this.features.refresh([...touched]);

    const snapshot = this.snapshot();
    log.info(`mode ${previous} -> ${id}`);
    this.emit('changed', snapshot);
    return snapshot;
  }

  // -- custom modes (spec §5) -------------------------------------------

  /**
   * Create a custom mode by mixing features from the built-ins.
   *
   * `basedOn` seeds the document so the builder starts from something
   * coherent; from then on the custom mode is fully independent, because a
   * live inheritance link would mean a future change to a built-in silently
   * rewrote a user's saved mode.
   */
  create({ name, basedOn = 'default', features = {}, appearance = {}, panels, tagline, icon, accent } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('a mode needs a name');

    const seed = this.byId(basedOn) || BUILTIN_MODES[0];
    const id = this._uniqueId(trimmed);

    /** @type {ModeDoc} */
    const doc = {
      id,
      name: trimmed,
      tagline: tagline || `Custom mode based on ${seed.name}.`,
      icon: icon || seed.icon,
      accent: accent || seed.accent,
      builtin: false,
      basedOn: seed.id,
      features: { ...(seed.features || {}), ...features },
      appearance: { ...(seed.appearance || {}), ...pick(appearance, APPEARANCE_KEYS) },
      panels: Array.isArray(panels) && panels.length ? panels : [...(seed.panels || BASELINE_PANELS)],
      quickActions: [...(seed.quickActions || [])],
      behaviors: { ...(seed.behaviors || {}) },
    };

    this.settings.set('modes.custom', [...this.customModes(), doc]);
    this.emit('changed', this.snapshot());
    return doc;
  }

  update(id, patch = {}) {
    const modes = this.customModes();
    const index = modes.findIndex((m) => m.id === id);
    if (index === -1) {
      throw new Error(BUILTIN_MODES.some((m) => m.id === id)
        ? `"${id}" is a built-in mode; customise it with overrides or copy it`
        : `unknown mode "${id}"`);
    }

    const next = [...modes];
    next[index] = {
      ...next[index],
      ...pick(patch, ['name', 'tagline', 'icon', 'accent', 'panels', 'quickActions']),
      features: patch.features ? { ...next[index].features, ...patch.features } : next[index].features,
      appearance: patch.appearance
        ? { ...next[index].appearance, ...pick(patch.appearance, APPEARANCE_KEYS) }
        : next[index].appearance,
      behaviors: patch.behaviors ? { ...next[index].behaviors, ...patch.behaviors } : next[index].behaviors,
      id: next[index].id,        // identity is not patchable
      builtin: false,
    };

    this.settings.set('modes.custom', next);
    if (this.activeId() === id) this.features.refresh();
    this.emit('changed', this.snapshot());
    return next[index];
  }

  remove(id) {
    if (BUILTIN_MODES.some((m) => m.id === id)) {
      throw new Error(`"${id}" is a built-in mode and cannot be removed`);
    }
    const next = this.customModes().filter((m) => m.id !== id);
    this.settings.set('modes.custom', next);

    // Removing the active mode drops us back to Default rather than leaving
    // the overlay pointing at a deleted document.
    if (this.activeId() === id) {
      this.settings.set('modes.active', 'default');
      this._syncOverrideSink();
      this.features.refresh();
    }
    this.resetOverrides(id);
    this.emit('changed', this.snapshot());
    return this.snapshot();
  }

  /** Copy any mode — built-in included — into an editable custom one. */
  duplicate(id, name) {
    const doc = this.byId(id);
    if (!doc) throw new Error(`unknown mode "${id}"`);
    return this.create({
      name: name || `${doc.name} copy`,
      basedOn: id,
      features: this._overridesFor(id),   // fold in what the user changed
      appearance: doc.appearance,
      panels: doc.panels,
      tagline: doc.tagline,
      icon: doc.icon,
      accent: doc.accent,
    });
  }

  _uniqueId(name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mode';
    const taken = new Set([...BUILTIN_MODES, ...this.customModes()].map((m) => m.id));
    if (!taken.has(slug)) return slug;
    let n = 2;
    while (taken.has(`${slug}-${n}`)) n += 1;
    return `${slug}-${n}`;
  }

  // -- projection --------------------------------------------------------

  /** Everything the renderer needs to draw the switcher and the chrome. */
  snapshot() {
    const active = this.active();
    return {
      activeId: active.id,
      active,
      modes: this.list().map(({ features, ...rest }) => rest),
      appearance: active.appearance,
      panels: active.panels,
      quickActions: active.quickActions || [],
      behaviors: active.behaviors || {},
    };
  }

  /** True when the active mode arms a named runtime behaviour. */
  behavior(name) {
    return this.active().behaviors?.[name] === true;
  }
}

/** Copy only the listed keys, skipping undefined so a patch stays a patch. */
function pick(source, keys) {
  const out = {};
  if (!source) return out;
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

module.exports = { ModeService, BUILTIN_MODES, APPEARANCE_KEYS };
