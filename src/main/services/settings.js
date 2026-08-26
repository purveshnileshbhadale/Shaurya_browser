'use strict';
/**
 * Settings service — the browser's configuration spine.
 *
 * One flat-ish document with a declared default shape, addressed by dot
 * paths (`privacy.httpsOnly`). Everything that a user can change lives
 * here, which makes export, sync and "reset to defaults" one-liners.
 */
const EventEmitter = require('node:events');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');

/**
 * Default configuration. Chosen to match what a privacy-forward consumer
 * browser ships with: blocking on, HTTPS-only on, telemetry absent entirely.
 */
const DEFAULTS = {
  version: 1,

  appearance: {
    theme: 'system',            // system | light | dark
    accent: '#6C8CFF',
    density: 'comfortable',     // comfortable | compact
    tabOrientation: 'vertical', // vertical | horizontal
    sidebarWidth: 248,
    showTabThumbnails: true,
    animations: true,
    roundedCorners: 12,
    monoUi: false,              // monospace chrome font (Programmer Mode)
    backgroundFx: 'none',       // none | rgb — animated chrome background
    perProfileTheme: {},        // profileId -> { theme, accent }
  },

  modes: {
    active: 'default',          // default | programmer | gamer | <custom id>
    custom: [],                 // user-built modes; see services/modes.js
    overrides: {},              // modeId -> { featureId: boolean }
    lastUsed: {},               // modeId -> timestamp, for switcher ordering
    rememberPerProfile: false,  // opt-in: each profile remembers its own mode
    switchAnimation: true,
  },

  gaming: {
    turbo: {
      suspendBackgroundTabs: true,
      suspendExtensions: true,
      pauseSync: true,
      keepAudible: true,        // never suspend a tab that is making sound
    },
    overlay: {
      metrics: ['cpu', 'ram', 'fps'],
      position: 'top-right',
      opacity: 0.85,
      scale: 1,
    },
    recorder: {
      replaySeconds: 30,        // instant-replay ring buffer depth
      fps: 30,
      resolution: 1080,
      directory: '',            // empty = platform videos folder
      audio: true,
    },
    tabCaps: {},                // host -> { cpuPercent, memoryMb }
    gamepadBindings: {},        // button/axis -> command id
    pingRegions: [],            // user-added region endpoints
    streamLayout: 'solo',       // solo | chat | webcam | full
    streams: [],                // saved Twitch/YouTube channels
    feeds: [],                  // patch-note RSS sources
    steam: { apiKey: '', steamId: '' },
    discordPresence: true,
    wishlist: [],               // { title, storeIds, targetPrice }
    dealsCurrency: 'USD',
  },

  study: {
    blockList: ['reddit.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com',
      'instagram.com', 'facebook.com'],
    siteLimits: {},             // host -> minutes per day
    usage: { date: '', hosts: {} },
    citationStyle: 'apa',
    timerPreset: 'pomodoro',
    ocrEngine: null,            // pluggable; null means "text layers only"
    roomUrl: '',
    roomPinned: false,
  },

  creator: {
    brandKits: [],              // { id, name, colours[], fonts[] }
    activeKit: '',
    assetSources: { openverse: true, wikimedia: true, pexels: false },
    pexelsKey: '',
    scheduleQueue: [],          // { id, platform, when, title, body, assetPath }
    connectedChannels: [],      // { platform, handle, tokenRef }
    teleprompter: {
      speed: 40,                // px per second
      fontSize: 34,
      mirrored: false,
      opacity: 0.9,
      pedalKey: 'F13',          // most USB pedals emit a spare function key
    },
    thumbnailSlots: [],         // two candidate image paths for A/B
  },

  ghost: {
    torPerWindow: true,         // Ghost windows route through Tor when able
    panicScope: 'window',       // window | browser
    panicPreserveSettings: true,
    shredPasses: 3,
    stripOnUpload: true,
    stripOnDownload: true,
  },

  startPage: {
    mode: 'speeddial',          // speeddial | blank | url
    customUrl: '',
    background: 'aurora',
    widgets: { weather: true, todo: true, notes: true, clock: false },
    weatherLocation: '',
    speedDial: [],              // filled from top sites on first run
    columns: 5,
  },

  search: {
    engine: 'duckduckgo',
    engines: {
      duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
      google: { name: 'Google', url: 'https://www.google.com/search?q=%s', suggest: '' },
      brave: { name: 'Brave', url: 'https://search.brave.com/search?q=%s', suggest: '' },
      startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=%s', suggest: '' },
    },
    suggestionsEnabled: false,  // off by default: it leaks keystrokes
  },

  privacy: {
    adblock: true,
    adblockAggressive: false,   // also strips first-party trackers
    httpsOnly: true,
    fingerprintResistance: true,
    blockThirdPartyCookies: true,
    doNotSell: true,
    clearOnExit: [],            // e.g. ['cookies','cache']
    dohProvider: 'system',      // see services/ghost/index.js DOH_PROVIDERS
    dohUrl: '',
    siteSettings: {},           // host -> { adblock, permissions: {...} }
    defaultPermissions: {
      camera: 'ask', microphone: 'ask', geolocation: 'ask',
      notifications: 'ask', clipboard: 'ask', midi: 'deny',
      'display-capture': 'ask', usb: 'deny', serial: 'deny', hid: 'deny',
    },
  },

  vpn: {
    enabled: false,
    region: 'auto',
    killSwitch: true,
    autoConnect: false,
    tier: 'free',               // free | pro
    excludedApps: [],
  },

  ai: {
    enabled: true,
    defaultModel: 'local',      // local | hosted
    hosted: { provider: 'anthropic', model: 'claude-sonnet-5', apiKeyRef: 'vault:ai.anthropic' },
    local: { provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'llama3.2:3b' },
    multiTabContext: false,     // explicit opt-in per spec
    confirmRealWorldActions: true, // never disableable through the UI
    notesFormat: 'structured',
    autoQuiz: false,
    exportTargets: { markdown: true, pdf: true, notion: false, obsidian: false },
    obsidianVault: '',
    notionToken: '',
  },

  devtools: {
    jsonViewer: true,
    markdownPreview: true,
    gitCards: true,
    corsDisabledProfiles: [],   // profile ids where CORS is relaxed
    responsivePresets: [],      // user-added on top of built-ins
    throttlingProfile: 'none',
    hotReloadExtensions: true,
  },

  tabs: {
    hibernateAfterMinutes: 30,
    hibernateEnabled: true,
    hibernateExcludeAudible: true,
    hibernateExcludePinned: true,
    confirmCloseMultiple: true,
    openInBackground: true,
    warmSpare: true,
  },

  sync: {
    enabled: false,
    endpoint: '',
    deviceName: '',
    collections: {
      bookmarks: true, history: true, passwords: true, notes: true,
      extensions: true, devCollections: true, sessions: true,
    },
  },

  downloads: { directory: '', askEveryTime: false },

  shortcuts: {},                // overrides on top of the default scheme

  features: {},                 // Feature Store toggles; see feature-store.js

  onboarding: { completed: false, version: 0 },

  subscription: { tier: 'free' }, // free | pro — gates *caps*, never privacy
};

class SettingsService extends EventEmitter {
  constructor() {
    super();
    this.store = new JsonStore(paths.settingsFile(), DEFAULTS);
    // Merge forward so an upgrade that adds a key doesn't require migration.
    this.store.data = deepDefaults(this.store.data, DEFAULTS);
  }

  /** Read a dot path, or the whole document when omitted. */
  get(path) {
    if (!path) return this.store.data;
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), this.store.data);
  }

  /** Write a dot path. Emits `changed` with { path, value }. */
  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = this.store.data;
    for (const k of keys) {
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[last] = value;
    this.store.save();
    this.emit('changed', { path, value });
    return value;
  }

  /** Apply many paths atomically (one save, one batched event). */
  patch(entries) {
    for (const [p, v] of Object.entries(entries)) {
      const keys = p.split('.');
      const last = keys.pop();
      let node = this.store.data;
      for (const k of keys) {
        if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
        node = node[k];
      }
      node[last] = v;
    }
    this.store.save();
    this.emit('changed', { path: '*', value: entries });
  }

  reset(section) {
    if (section) {
      this.store.data[section] = structuredClone(DEFAULTS[section]);
    } else {
      this.store.data = structuredClone(DEFAULTS);
    }
    this.store.save();
    this.emit('changed', { path: section || '*', value: this.get(section) });
  }

  flush() {
    this.store.flush();
  }
}

/** Recursively fill missing keys from `defaults` without clobbering values. */
function deepDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
  if (defaults && typeof defaults === 'object') {
    const out = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const [k, d] of Object.entries(defaults)) out[k] = deepDefaults(out[k], d);
    return out;
  }
  return value === undefined ? defaults : value;
}

module.exports = { SettingsService, DEFAULTS, deepDefaults };
