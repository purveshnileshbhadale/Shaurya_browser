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
  { id: 'vpn', name: 'Shaurya VPN', category: 'Privacy',
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
  { id: 'backgroundPlay', name: 'Background Play', category: 'Interface',
    description: 'Audio and video keep playing when you switch tabs, minimise the '
      + 'window, or the screen sleeps — with hardware media-key control.',
    default: true, cost: 'light',
    costNote: 'A playing tab is exempted from background throttling and holds a wake lock' },
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
    description: 'Full Chrome DevTools plus the Shaurya dev panels.',
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

  // ---- Gaming ----------------------------------------------------------
  // Off by default in the raw preference layer: a user who never switches to
  // Gamer Mode should never pay for any of this. Gamer Mode turns them on
  // through its overlay, which is exactly what the overlay is for.
  { id: 'turbo', name: 'Turbo', category: 'Gaming',
    description: 'One switch that suspends background tabs, extensions and sync to hand CPU, RAM and GPU to the foreground.',
    default: false, cost: 'none', costNote: 'Frees resources rather than costing them' },
  { id: 'lowLatency', name: 'Low-Latency Mode', category: 'Gaming',
    description: 'Drops non-essential animations and background network work while active.',
    default: false, cost: 'none' },
  { id: 'hardwareOverlay', name: 'Hardware Overlay', category: 'Gaming',
    description: 'Always-on-top CPU / RAM / FPS readout that stays legible over a fullscreen game.',
    default: false, cost: 'light', costNote: 'One sampling timer and a small always-on-top window' },
  { id: 'tabLimits', name: 'Per-Tab Resource Caps', category: 'Gaming',
    description: 'Live CPU and memory on each tab, with a right-click cap that throttles or sleeps a greedy one.',
    default: false, cost: 'light', costNote: 'Samples process metrics on an interval' },
  { id: 'recorder', name: 'Recorder & Clipper', category: 'Gaming',
    description: 'Full recording plus instant-replay clipping of the last N seconds.',
    default: false, cost: 'heavy', costNote: 'The replay buffer holds encoded video in memory' },
  { id: 'streamPlayer', name: 'Stream Mini Player', category: 'Gaming',
    description: 'Always-on-top Twitch and YouTube player that survives switching tabs.',
    default: false, cost: 'moderate', costNote: 'A second renderer decoding video' },
  { id: 'gameFeeds', name: 'Game Feeds', category: 'Gaming',
    description: 'Steam and Epic library status, Discord presence, and patch-note feeds from favourited sites.',
    default: false, cost: 'light', requires: ['history'] },
  { id: 'deals', name: 'Deals & Key Tracker', category: 'Gaming',
    description: 'Price watch across storefronts for wishlisted games, with a start-page feed.',
    default: false, cost: 'light' },
  { id: 'gamepadNav', name: 'Gamepad Navigation', category: 'Gaming',
    description: 'Browse with a controller: stick to scroll, face buttons to activate, bumpers to change tab.',
    default: false, cost: 'none' },
  { id: 'rgbTheme', name: 'Animated Theming', category: 'Gaming',
    description: 'Bold accents and animated chrome backgrounds. Off leaves Gamer Mode calm but still fast.',
    default: false, cost: 'light', costNote: 'A compositor-only animation on the chrome layer' },

  // ---- Developer (mode-deepening) --------------------------------------
  { id: 'terminal', name: 'Terminal Panel', category: 'Developer',
    description: 'A local shell in the sidebar, confined to profiles of kind "dev".',
    default: false, cost: 'moderate', costNote: 'A shell process per open session',
    requires: ['devtools'] },
  { id: 'dbClient', name: 'Database Client', category: 'Developer',
    description: 'Read-only Postgres, MySQL and SQLite browsing with schema inspection.',
    default: false, cost: 'light', requires: ['devtools'] },
  { id: 'graphql', name: 'GraphQL Explorer', category: 'Developer',
    description: 'Introspected schema browser, query editor and history.',
    default: false, cost: 'light', requires: ['httpClient'] },
  { id: 'docker', name: 'Container Status', category: 'Developer',
    description: 'Running containers, ports and health over the local Docker socket.',
    default: false, cost: 'light', requires: ['devtools'] },
  { id: 'profiler', name: 'Profiler & Audits', category: 'Developer',
    description: 'Request waterfall and a per-page performance/accessibility audit.',
    default: false, cost: 'moderate', costNote: 'Audits drive a real page load',
    requires: ['devtools'] },
  { id: 'snippets', name: 'Snippet Manager', category: 'Developer',
    description: 'Reusable code snippets, syncable and insertable from the palette.',
    default: false, cost: 'none' },
  { id: 'apiMocking', name: 'API Mocking', category: 'Developer',
    description: 'Intercept matching requests and return a stubbed response.',
    default: false, cost: 'light', requires: ['devtools'] },
  { id: 'depWatch', name: 'Dependency Watcher', category: 'Developer',
    description: 'Flags outdated and CVE-affected packages in manifests you open.',
    default: false, cost: 'light' },

  // ---- Gaming (mode-deepening) -----------------------------------------
  { id: 'pingTester', name: 'Ping & Region Tester', category: 'Gaming',
    description: 'Latency graph overlay and a server-region ping test.',
    default: false, cost: 'light' },
  { id: 'gamepadRemap', name: 'Controller Remapping', category: 'Gaming',
    description: 'Rebind gamepad buttons and axes for browser navigation.',
    default: false, cost: 'none', requires: ['gamepadNav'] },
  { id: 'shotGallery', name: 'Screenshot Gallery', category: 'Gaming',
    description: 'Captures and clips organised by game, with one-click share.',
    default: false, cost: 'light' },
  { id: 'streamLayouts', name: 'Streaming Layouts', category: 'Gaming',
    description: 'Quick-apply overlay, chat and webcam arrangements.',
    default: false, cost: 'none', requires: ['streamPlayer'] },
  { id: 'cloudSaves', name: 'Cloud Save Status', category: 'Gaming',
    description: 'Surfaces save-sync state and flags conflicts before they cost progress.',
    default: false, cost: 'light', requires: ['gameFeeds'] },

  // ---- Creator ---------------------------------------------------------
  { id: 'assetLibrary', name: 'Asset Library', category: 'Creator',
    description: 'Search royalty-free video, audio and images without leaving the page.',
    default: false, cost: 'light' },
  { id: 'brandKit', name: 'Brand Kit', category: 'Creator',
    description: 'Saved colours and fonts, applied into web editors in one click.',
    default: false, cost: 'none' },
  { id: 'uploadScheduler', name: 'Upload Scheduler', category: 'Creator',
    description: 'Queue a post or video across connected platforms from one panel.',
    default: false, cost: 'light' },
  { id: 'thumbnailAB', name: 'Thumbnail A/B', category: 'Creator',
    description: 'Compare two thumbnails against a simulated feed layout.',
    default: false, cost: 'none' },
  { id: 'creatorAnalytics', name: 'Channel Analytics', category: 'Creator',
    description: 'Views and engagement from connected channels in the sidebar.',
    default: false, cost: 'light' },
  { id: 'teleprompter', name: 'Teleprompter', category: 'Creator',
    description: 'Scrollable always-on-top script overlay with keyboard or pedal control.',
    default: false, cost: 'light' },
  { id: 'focusCanvas', name: 'Focus Canvas', category: 'Creator',
    description: 'Hides all chrome except the tab you are editing in.',
    default: false, cost: 'none' },

  // ---- Student ---------------------------------------------------------
  { id: 'citations', name: 'Citation Manager', category: 'Student',
    description: 'Capture a source in one click; export APA, MLA or Chicago.',
    default: false, cost: 'none' },
  { id: 'pdfAnnotate', name: 'PDF Annotation', category: 'Student',
    description: 'Highlight and annotate PDFs, synced and searchable afterwards.',
    default: false, cost: 'light' },
  { id: 'focusBlocker', name: 'Focus Timer & Blocker', category: 'Student',
    description: 'Pomodoro timer with per-site time limits and block lists.',
    default: false, cost: 'none' },
  { id: 'flashcards', name: 'AI Flashcards', category: 'Student',
    description: 'Turn slides, PDFs and long readings into a study deck.',
    default: false, cost: 'light', requires: ['ai'] },
  { id: 'deadlines', name: 'Deadline Tracker', category: 'Student',
    description: 'Assignment due dates, importable from an LMS calendar feed.',
    default: false, cost: 'none' },
  { id: 'ocrSearch', name: 'OCR Search', category: 'Student',
    description: 'Full-text search across scanned course material.',
    default: false, cost: 'heavy', costNote: 'OCR is CPU-bound; runs on demand',
    requires: ['pdfAnnotate'] },
  { id: 'studyRoom', name: 'Group Study Room', category: 'Student',
    description: 'A voice or video room pinned over the tabs you are studying.',
    default: false, cost: 'moderate' },

  // ---- Ghost -----------------------------------------------------------
  { id: 'tor', name: 'Tor Routing', category: 'Ghost',
    description: 'Route a window through Tor, independently of the VPN.',
    default: false, cost: 'moderate', costNote: 'Needs a local Tor SOCKS proxy' },
  { id: 'fingerprintRandom', name: 'Per-Tab Randomisation', category: 'Ghost',
    description: 'Randomises canvas, audio and font signals per tab rather than per origin.',
    default: false, cost: 'light', requires: ['fingerprint'] },
  { id: 'metadataStrip', name: 'Metadata Stripping', category: 'Ghost',
    description: 'Removes EXIF and document metadata from files you download or upload.',
    default: false, cost: 'light' },
  { id: 'shredder', name: 'Secure Shredder', category: 'Ghost',
    description: 'Overwrite-then-unlink deletion for downloaded files.',
    default: false, cost: 'none' },
  { id: 'breachMonitor', name: 'Breach Monitor', category: 'Ghost',
    description: 'Continuously re-checks saved accounts against known breaches.',
    default: false, cost: 'light', requires: ['passwords'] },
  { id: 'dohPicker', name: 'DNS-over-HTTPS Picker', category: 'Ghost',
    description: 'Choose or self-specify the encrypted DNS resolver.',
    default: false, cost: 'none' },
  { id: 'panicButton', name: 'Panic Button', category: 'Ghost',
    description: 'One key closes and wipes the window, or the entire browser state.',
    default: false, cost: 'none' },

  // ---- Modes -----------------------------------------------------------
  { id: 'modes', name: 'Mode Switcher', category: 'Modes',
    description: 'The toolbar control that reconfigures the browser for what you are doing.',
    default: true, cost: 'none' },

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
    /**
     * An optional overlay consulted before the stored preference.
     *
     * Modes need to turn features on and off without *destroying* what the
     * user chose for themselves — otherwise a round trip through Gamer Mode
     * would silently rewrite their preferences, and switching back to Default
     * would not restore them. So a mode contributes an overlay rather than
     * writing to `settings.features`, and the stored layer stays pristine.
     *
     * Injected rather than imported: the Feature Store must not know that
     * modes exist, or the two services could not be constructed in either
     * order.
     *
     * @type {null | ((id: string) => boolean|undefined)}
     */
    this._resolver = null;
    this._seedDefaults();
  }

  /**
   * Install the overlay resolver. Returns `undefined` from the resolver to
   * mean "no opinion, use the stored preference".
   */
  setResolver(fn) {
    this._resolver = typeof fn === 'function' ? fn : null;
    this.emit('changed', this.list());
  }

  /** The stored preference for a feature, ignoring any overlay. */
  base(id) {
    const def = this._byId.get(id);
    if (!def) return false;
    if (def.core) return true;
    return this.settings.get(`features.${id}`) === true;
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

    const overlaid = this._resolver ? this._resolver(id) : undefined;
    const on = typeof overlaid === 'boolean' ? overlaid : this.base(id);
    if (!on) return false;
    // A feature is only really on when its dependencies are.
    return (def.requires || []).every((dep) => this.enabled(dep));
  }

  /**
   * Recompute and announce. Called when the overlay changes underneath us —
   * the stored preferences did not move, but the answers did, and every
   * subsystem that gates on `enabled()` needs to hear about it.
   *
   * @param {string[]} ids feature ids whose resolved value may have changed
   */
  refresh(ids = CATALOG.map((f) => f.id)) {
    for (const id of ids) {
      if (!this._byId.has(id)) continue;
      this.emit('toggled', { id, enabled: this.enabled(id) });
    }
    this.emit('changed', this.list());
  }

  /**
   * Install a sink for toggles made while an overlay is active.
   *
   * Without this, turning the REST client off inside Programmer Mode would
   * write to the stored preference, so leaving the mode would leave it off
   * everywhere — the user asked a question about *this mode* and got a global
   * answer. With it, the mode absorbs the change and Default is unaffected.
   *
   * @param {null | ((changes: Record<string, boolean>) => void)} fn
   */
  setOverrideSink(fn) {
    this._overrideSink = typeof fn === 'function' ? fn : null;
  }

  /**
   * Toggle a feature. Cascades: enabling pulls in requirements, disabling
   * pushes down dependents, so the UI can never land in an inconsistent
   * state like "REST client on, DevTools off".
   *
   * Cascades are computed against *resolved* values, not stored ones, so a
   * dependency a mode switched on still counts as satisfied.
   */
  toggle(id, value) {
    const def = this._byId.get(id);
    if (!def) throw new Error(`unknown feature "${id}"`);
    if (def.core) throw new Error(`"${id}" is a core guarantee and cannot be disabled`);

    /** @type {Record<string, boolean>} */
    const changes = {};
    const resolved = (fid) => (fid in changes ? changes[fid] : this.enabled(fid));

    const setOn = (fid) => {
      if (resolved(fid) === true) return;
      changes[fid] = true;
      for (const dep of this._byId.get(fid)?.requires || []) setOn(dep);
    };
    const setOff = (fid) => {
      if (resolved(fid) === false) return;
      changes[fid] = false;
      for (const other of CATALOG) {
        if ((other.requires || []).includes(fid)) setOff(other.id);
      }
    };

    if (value) setOn(id); else setOff(id);

    if (this._overrideSink) {
      // A mode is active: it absorbs the change, base preferences untouched.
      this._overrideSink(changes);
    } else {
      const next = { ...(this.settings.get('features') || {}), ...changes };
      this.settings.set('features', next);
    }

    for (const fid of Object.keys(changes)) {
      this.emit('toggled', { id: fid, enabled: this.enabled(fid) });
    }
    this.emit('changed', this.list());
    return this.list();
  }

  /** Catalog + current state, grouped for the settings screen. */
  list() {
    const state = this.settings.get('features') || {};
    return CATALOG.map((f) => {
      const overlaid = this._resolver ? this._resolver(f.id) : undefined;
      return {
        ...f,
        enabled: this.enabled(f.id),
        raw: state[f.id] === true,
        // Lets the Feature Store screen say "on because Gamer Mode says so"
        // rather than showing a switch whose position the user did not choose.
        source: typeof overlaid === 'boolean' ? 'mode' : 'preference',
        blockedBy: (f.requires || []).filter((d) => !this.enabled(d)),
      };
    });
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
