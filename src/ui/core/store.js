/**
 * Renderer state and the bridge to the main process.
 *
 * A single observable store, updated by IPC events, with components
 * subscribing to the slices they care about. Renders are batched into one
 * animation frame so a burst of tab events costs one layout pass, not twenty
 * — which is the difference between a 60fps tab strip and a stuttering one.
 */

const bridge = window.aether;

/** Subscribers, keyed by the state slice they watch. */
const subscribers = new Map();
let pendingSlices = new Set();
let frame = null;

/** The whole renderer's state. */
export const state = {
  ready: false,
  window: null,
  tabs: { tabs: [], order: [], activeId: null, groups: [], workspaces: [], activeWorkspaceId: null },
  layout: null,
  settings: {},
  features: [],
  footprint: null,
  profiles: [],
  shortcuts: [],
  vault: null,
  vpn: null,
  sync: null,
  adblock: { count: 0, lifetime: 0, topHosts: [] },
  downloads: [],
  permissions: { pending: [], site: null },
  panel: null,          // { kind, ... } — which side panel is open
  omnibox: { value: '', focused: false, suggestions: [], selectedIndex: 0 },
  find: null,           // { text, matches, active }
  ai: { conversationId: null, messages: [], streaming: false, sources: [], confirm: null },
  notes: [],
  http: null,
  ws: { sockets: [], frames: [] },
  servers: [],
  cors: { anyActive: false },
  extensions: [],
  toast: null,
  version: null,
  onboarding: null,
  // What the *operating system* is drawing around us: the native window
  // buttons' colours, how much room they take, and which backdrop material
  // the window got. Supplied by the main process because only it can see
  // them — the renderer's CSS never paints these pixels.
  chrome: null,

  // --- modes (spec §2) and the mode-scoped services --------------------
  modes: {
    activeId: 'default',
    active: null,
    modes: [],
    appearance: {},
    panels: ['ai', 'notes'],
    quickActions: [],
    behaviors: {},
  },
  perf: { system: null, tabs: [], turbo: { on: false }, overlay: null },
  recorder: { recording: false, bufferArmed: false },
  streams: { open: false, saved: [] },
  games: { library: [], patchNotes: [], presence: {} },
  deals: { watched: [], deals: [] },
  creator: { kits: { kits: [] }, queue: [], scripts: [] },
  student: { sources: [], timer: { running: false }, decks: [], deadlines: null },
  ghost: { tor: {}, doh: {}, breach: {} },
  devtools: { docker: null, mocks: [], snippets: null, graphql: null },
  terminal: { sessions: [], output: {} },
  media: { sessions: [], active: null, activeId: null, anyPlaying: false, backgroundPlay: true },
};

/**
 * Subscribe to one or more slices.
 * @param {string|string[]} slices
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(slices, fn) {
  const list = Array.isArray(slices) ? slices : [slices];
  for (const slice of list) {
    if (!subscribers.has(slice)) subscribers.set(slice, new Set());
    subscribers.get(slice).add(fn);
  }
  return () => {
    for (const slice of list) subscribers.get(slice)?.delete(fn);
  };
}

/**
 * Merge into a slice and schedule a render.
 * @param {string} slice
 * @param {object|Function} value  object to merge, or an updater
 */
export function update(slice, value) {
  const next = typeof value === 'function' ? value(state[slice]) : value;
  state[slice] = next && typeof next === 'object' && !Array.isArray(next)
    && state[slice] && typeof state[slice] === 'object' && !Array.isArray(state[slice])
    ? { ...state[slice], ...next }
    : next;
  notify(slice);
}

/** Replace a slice outright. */
export function set(slice, value) {
  state[slice] = value;
  notify(slice);
}

function notify(slice) {
  pendingSlices.add(slice);
  if (frame) return;
  // Coalescing into one frame is what keeps a burst of `tabs:title` events
  // from causing a re-render per event.
  frame = requestAnimationFrame(() => {
    const slices = pendingSlices;
    pendingSlices = new Set();
    frame = null;

    const called = new Set();
    for (const name of slices) {
      for (const fn of subscribers.get(name) || []) {
        if (called.has(fn)) continue; // a component watching two changed slices renders once
        called.add(fn);
        try {
          fn();
        } catch (err) {
          console.error(`[aether] render for "${name}" failed:`, err);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/** Call a main-process handler; errors surface as a toast rather than silence. */
export async function invoke(channel, payload, { quiet = false } = {}) {
  try {
    return await bridge.invoke(channel, payload);
  } catch (err) {
    if (!quiet) toast(err.message, 'error');
    throw err;
  }
}

export function send(channel, payload) {
  bridge.send(channel, payload);
}

export function on(channel, handler) {
  return bridge.on(channel, handler);
}

export const env = bridge.env;

/** Transient message in the corner. */
export function toast(message, tone = 'info', { timeout = 4000 } = {}) {
  set('toast', { message, tone, at: Date.now() });
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => set('toast', null), timeout);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Pull the initial state dump and wire every push event. */
export async function boot() {
  const initial = await invoke('shell.bootstrap');

  set('window', initial.window);
  set('tabs', initial.tabs || state.tabs);
  set('layout', initial.layout);
  set('settings', initial.settings);
  set('features', initial.features);
  set('footprint', initial.footprint);
  set('profiles', initial.profiles);
  set('shortcuts', initial.shortcuts);
  set('vault', initial.vault);
  set('vpn', initial.vpn);
  set('sync', initial.sync);
  set('adblock', initial.adblock);
  set('version', initial.version);
  set('onboarding', initial.onboarding);
  // Before the first paint, so the toolbar never renders one frame with its
  // controls underneath the system's window buttons.
  if (initial.chrome) applyChrome(initial.chrome);
  // Seeded before the first applyTheme() below, so the window paints in the
  // active mode's chrome rather than flashing Default and correcting itself.
  if (initial.modes) set('modes', initial.modes);

  wireEvents();
  applyTheme();
  set('ready', true);
  return initial;
}

function wireEvents() {
  on('tabs:changed', (snapshot) => set('tabs', snapshot));
  on('tabs:title', ({ tab }) => {
    // Patch one tab in place rather than replacing the array, so the
    // reconciler only touches the row that changed.
    update('tabs', (tabs) => ({
      ...tabs,
      tabs: tabs.tabs.map((t) => (t.id === tab.id ? tab : t)),
    }));
  });
  on('tabs:navigation', ({ tabId, url, phase }) => {
    if (phase !== 'commit') return;
    if (tabId === state.tabs.activeId && !state.omnibox.focused) {
      update('omnibox', { value: url });
    }
  });
  on('tabs:find', (result) => update('find', result));

  on('groups:changed', (groups) => update('tabs', { groups }));
  on('workspaces:changed', (workspaces) => update('tabs', { workspaces }));
  on('layout:changed', (layout) => set('layout', layout));

  on('settings:changed', async () => {
    set('settings', await invoke('settings.get', {}, { quiet: true }));
    applyTheme();
  });
  on('features:changed', (payload) => {
    // The main process sends either the bare list or { features, footprint }
    // depending on which path announced the change.
    if (Array.isArray(payload)) set('features', payload);
    else {
      if (payload.features) set('features', payload.features);
      if (payload.footprint) set('footprint', payload.footprint);
    }
  });

  // --- modes -----------------------------------------------------------
  on('modes:changed', (snapshot) => {
    set('modes', snapshot);
    applyTheme();
  });

  on('perf:metrics', (m) => update('perf', (p) => ({ ...p, ...m })));
  on('perf:tabUsage', (tabs) => update('perf', (p) => ({ ...p, tabs })));
  on('perf:turbo', (t) => update('perf', (p) => ({ ...p, turbo: { ...p.turbo, ...t } })));
  on('recorder:state', (s) => set('recorder', s));
  on('recorder:clip', (file) => toast(`Saved ${file.kind} to ${file.path}`, 'success'));
  on('stream:changed', (s) => set('streams', s));
  on('games:changed', (s) => update('games', (g) => ({ ...g, ...s })));
  on('deals:changed', (s) => update('deals', (d) => ({ ...d, ...s })));
  on('creator:changed', (s) => update('creator', (c) => ({ ...c, ...s })));
  on('student:changed', (s) => update('student', (st) => ({ ...st, ...s })));
  on('student:timer', (t) => update('student', (st) => ({ ...st, timer: t })));
  on('ghost:changed', (s) => update('ghost', (g) => ({ ...g, ...s })));
  on('devtools:changed', (s) => update('devtools', (d) => ({ ...d, ...s })));
  on('media:changed', (s) => set('media', s));
  on('window:chrome', (info) => applyChrome(info));
  on('profiles:changed', (profiles) => set('profiles', profiles));

  on('adblock:count', (stats) => set('adblock', stats));
  on('vpn:status', (status) => set('vpn', status));
  on('vault:status', (status) => set('vault', status));
  on('sync:status', (status) => set('sync', status));
  on('downloads:changed', (downloads) => set('downloads', downloads));
  on('extensions:changed', (extensions) => set('extensions', extensions));
  on('notes:changed', (notes) => set('notes', notes));
  on('localservers:changed', (servers) => set('servers', servers));

  on('permissions:prompt', (prompt) => {
    update('permissions', (p) => ({ ...p, pending: [...p.pending, prompt] }));
  });

  on('ws:frame', ({ socketId, frame: f }) => {
    update('ws', (ws) => ({ ...ws, frames: [...ws.frames.slice(-999), { socketId, ...f }] }));
  });
  on('ws:status', (sockets) => update('ws', { sockets }));

  on('toast', ({ message, tone }) => toast(message, tone));

  // AI streaming: append deltas to the last assistant message.
  on('ai:stream', (delta) => {
    if (delta.type === 'start') {
      update('ai', (ai) => ({
        ...ai,
        streaming: true,
        sources: delta.sources || [],
        messages: [...ai.messages, { role: 'assistant', text: '', thinking: '', tools: [] }],
      }));
      return;
    }
    update('ai', (ai) => {
      const messages = [...ai.messages];
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return ai;
      if (delta.type === 'text') messages[messages.length - 1] = { ...last, text: last.text + delta.text };
      else if (delta.type === 'thinking') messages[messages.length - 1] = { ...last, thinking: last.thinking + delta.text };
      else if (delta.type === 'tool') {
        messages[messages.length - 1] = { ...last, tools: [...last.tools, { name: delta.tool, input: delta.input }] };
      }
      return { ...ai, messages };
    });
  });
  on('ai:done', ({ conversationId, usage }) => {
    update('ai', { streaming: false, conversationId, usage });
  });
  on('ai:error', ({ message }) => {
    update('ai', (ai) => ({
      ...ai,
      streaming: false,
      messages: [...ai.messages, { role: 'error', text: message }],
    }));
  });
  on('ai:confirm', (payload) => update('ai', { confirm: payload }));

  on('capture:result', (result) => {
    window.dispatchEvent(new CustomEvent('aether:capture', { detail: result }));
  });
  on('shortcut:invoked', ({ id }) => {
    window.dispatchEvent(new CustomEvent('aether:command', { detail: { id } }));
  });
  on('palette:open', () => {
    window.dispatchEvent(new CustomEvent('aether:command', { detail: { id: 'palette.open' } }));
  });
}

/** Push theme, accent and density onto the document element. */
export function applyTheme() {
  // The *resolved* appearance: a mode's presentation folded over the user's
  // own settings. Falling back to raw settings keeps this correct during the
  // first paint, before the mode snapshot has arrived.
  const appearance = { ...(state.settings.appearance || {}), ...(state.modes?.appearance || {}) };
  const root = document.documentElement;

  // Drives mode-scoped styling — the dense terminal chrome, the animated
  // Gamer background, the stripped-back Ghost frame — from one attribute,
  // so a new mode needs a CSS block rather than a code change.
  root.dataset.mode = state.modes?.activeId || 'default';
  root.dataset.mono = appearance.monoUi === true ? 'on' : 'off';
  root.dataset.fx = appearance.backgroundFx || 'none';

  root.dataset.theme = appearance.theme === 'system' ? '' : (appearance.theme || '');
  if (!root.dataset.theme) delete root.dataset.theme;

  root.dataset.density = appearance.density || 'comfortable';
  root.dataset.animations = appearance.animations === false ? 'off' : 'on';
  if (env.incognito === 'true') root.dataset.private = 'true';

  if (appearance.accent) {
    root.style.setProperty('--accent', appearance.accent);
    // A light accent needs dark text on it; a dark one needs light.
    root.style.setProperty('--accent-text', readableOn(appearance.accent));
  }
  if (appearance.roundedCorners != null) {
    root.style.setProperty('--radius', `${appearance.roundedCorners}px`);
  }
}

/**
 * Adopt the native chrome the OS gave this window.
 *
 * Two things have to be right or the seam shows:
 *
 * - **`--overlay-w`** reserves the strip Windows draws its own minimise/
 *   maximise/close into. Without it the omnibox's trailing buttons sit
 *   underneath three system buttons and cannot be clicked — they are real
 *   OS chrome, painted above the page.
 * - **`data-backdrop`** tells our surfaces to go translucent. A Mica window
 *   whose toolbar is opaque shows no material at all, so the option looks
 *   broken rather than subtle.
 */
export function applyChrome(info) {
  set('chrome', info);
  const root = document.documentElement;
  root.style.setProperty('--overlay-w', `${info.overlayWidth || 0}px`);
  if (info.backdrop && info.backdrop !== 'none') root.dataset.backdrop = info.backdrop;
  else delete root.dataset.backdrop;
}

/** Pick black or white for text on a background, by relative luminance. */
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const int = parseInt(m[1], 16);
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel((int >> 16) & 255)
    + 0.7152 * channel((int >> 8) & 255)
    + 0.0722 * channel(int & 255);
  return luminance > 0.45 ? '#16181d' : '#ffffff';
}

/** Convenience selectors used across components. */
export const selectors = {
  activeTab: () => state.tabs.tabs.find((t) => t.id === state.tabs.activeId) || null,
  feature: (id) => state.features.find((f) => f.id === id)?.enabled ?? false,
  shortcutFor: (id) => state.shortcuts.find((s) => s.id === id)?.accelerator || null,
  groupFor: (tab) => state.tabs.groups.find((g) => g.id === tab?.groupId) || null,
};
