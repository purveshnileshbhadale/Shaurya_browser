/**
 * DOM helpers.
 *
 * A hyperscript-style `h()` plus a keyed list reconciler. This is
 * deliberately not a framework: the browser chrome is a handful of lists and
 * a toolbar, and shipping a virtual DOM to render them would cost more in
 * startup time than it saves in code — and startup time is what a browser is
 * judged on.
 *
 * The reconciler exists because the tab strip must not rebuild rows on every
 * update: doing so kills CSS transitions, drops drag state and re-triggers
 * favicon loads.
 */

/**
 * Create an element.
 *
 * @param {string} tag           `div`, `button.class#id`, `svg:path`
 * @param {object} [props]       attributes, `class`, `style`, `on*` handlers
 * @param {...(Node|string|Array)} children
 * @returns {Element}
 */
export function h(tag, props = null, ...children) {
  const namespace = tag.startsWith('svg:') ? 'http://www.w3.org/2000/svg' : null;
  const spec = namespace ? tag.slice(4) : tag;

  // Parse `div.a.b#id` shorthand.
  const match = /^([\w-]+)((?:[.#][\w-]+)*)$/.exec(spec);
  const name = match ? match[1] : spec;
  const el = namespace
    ? document.createElementNS(namespace, name)
    : document.createElement(name);

  if (match && match[2]) {
    for (const token of match[2].match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') el.classList.add(token.slice(1));
      else el.id = token.slice(1);
    }
  }

  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

/** Apply a props object to an element. */
export function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      // Accept a string, an array, or a { name: boolean } map.
      if (Array.isArray(value)) el.classList.add(...value.filter(Boolean));
      else if (typeof value === 'object') {
        for (const [name, on] of Object.entries(value)) el.classList.toggle(name, Boolean(on));
      } else {
        for (const name of String(value).split(/\s+/).filter(Boolean)) el.classList.add(name);
      }
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'html') {
      // Only ever used with strings this code produced.
      el.innerHTML = value;
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key === 'ref' && typeof value === 'function') {
      value(el);
    } else if (key in el && !(el instanceof SVGElement)) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }
  return el;
}

function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** `document.querySelector`, scoped. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Remove every child. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * Keyed list reconciliation.
 *
 * Reuses existing elements by key, updates them in place, moves them into
 * the right order and removes the rest. Preserves focus, transitions and
 * drag state across renders — which is the entire reason this exists rather
 * than `container.innerHTML = ...`.
 *
 * @param {Element} container
 * @param {Array} items
 * @param {(item:any) => string} keyOf
 * @param {(item:any) => Element} create
 * @param {(el:Element, item:any) => void} [update]
 */
export function reconcile(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of [...container.children]) {
    const key = child.dataset.key;
    if (key !== undefined) existing.set(key, child);
  }

  let cursor = null; // the node the next item must be placed after

  for (const item of items) {
    const key = String(keyOf(item));
    let el = existing.get(key);

    if (el) {
      existing.delete(key);
      if (update) update(el, item);
    } else {
      el = create(item);
      el.dataset.key = key;
    }

    // Only touch the DOM when the position actually changed.
    const shouldBeAfter = cursor ? cursor.nextSibling : container.firstChild;
    if (shouldBeAfter !== el) {
      container.insertBefore(el, shouldBeAfter);
    }
    cursor = el;
  }

  for (const stale of existing.values()) stale.remove();
  return container;
}

/**
 * Delegated event binding.
 * One listener on a container beats one per row, and it keeps working as
 * rows come and go.
 */
export function delegate(container, eventName, selector, handler) {
  container.addEventListener(eventName, (event) => {
    const target = event.target.closest(selector);
    if (target && container.contains(target)) handler(event, target);
  });
}

/** Icon set. Stroke-based so `currentColor` and sizing just work. */
const ICON_PATHS = {
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  reload: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  stop: 'M18 6L6 18M6 6l12 12',
  home: 'M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14',
  close: 'M18 6L6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3',
  star: 'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z',
  shield: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M11 16v4',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  note: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h3',
  code: 'M8 6l-5 6 5 6M16 6l5 6-5 6',
  terminal: 'M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3',
  split: 'M12 4v16M4 4h16v16H4z',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  tab: 'M4 6h6l2 2h8v10H4z',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  puzzle: 'M11 3h2a2 2 0 0 1 2 2v1h1a2 2 0 0 1 2 2v2h1a2 2 0 1 1 0 4h-1v3a2 2 0 0 1-2 2h-3v-1a2 2 0 1 0-4 0v1H6a2 2 0 0 1-2-2v-3H3a2 2 0 1 1 0-4h1V8a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  unlock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.8-1',
  key: 'M15 7a4 4 0 1 1-3.9 5L7 16l-2 2-2-2 2-2 4-4A4 4 0 0 1 15 7z',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  crop: 'M6 2v16h16M2 6h16v16',
  book: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 3v18',
  pip: 'M3 5h18v14H3zM13 12h6v5h-6z',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  vpn: 'M12 3l8 3v6c0 4.4-3.4 8.4-8 9-4.6-.6-8-4.6-8-9V6zM9 12l2 2 4-4',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  check: 'M4 12l5 5L20 6',
  warning: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  pin: 'M12 3l3 5 5 1-4 4 1 5-5-3-5 3 1-5-4-4 5-1z',
  sleep: 'M17 3a9 9 0 1 1-9 9c0-.3 0-.6.1-.9A6 6 0 0 0 17 3z',
  volume: 'M5 9v6h4l5 4V5L9 9zM17 9a4 4 0 0 1 0 6',
  mute: 'M5 9v6h4l5 4V5L9 9zM17 10l4 4M21 10l-4 4',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.2 6.2A17 17 0 0 0 2 12s3.6 7 10 7c1.2 0 2.3-.2 3.3-.6',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.3 3.5A2 2 0 0 1 12 21zM7.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM16.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  device: 'M7 3h10v18H7zM11 18h2',
  send: 'M4 12l16-8-6 16-3-6z',
  translate: 'M4 6h10M9 4v2c0 4-2 7-5 8M7 12c1 3 3 5 6 6M14 20l4-10 4 10M15.5 17h5',
  compare: 'M12 3v18M8 7L4 11l4 4M16 7l4 4-4 4',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  json: 'M8 4c-2 0-3 1-3 3v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 2-1 3-3 3',
  regex: 'M12 4v10M8 6.5l8 5M16 6.5l-8 5M6 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 5a4 4 0 0 1 0 8M22 21a6 6 0 0 0-4-5.6',
  sync: 'M4 12a8 8 0 0 1 13.7-5.7L21 9M21 4v5h-5M20 12a8 8 0 0 1-13.7 5.7L3 15M3 20v-5h5',
  bell: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6zM10 20a2 2 0 0 0 4 0',
  mic: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  clipboard: 'M9 4h6v3H9zM7 5H5v15h14V5h-2',
  screen: 'M3 5h18v11H3zM8 20h8',

  // ---- modes (spec §2-§7) ----------------------------------------------
  gamepad: 'M7 12h4M9 10v4M15 11h.01M17.5 13h.01M6.5 7h11a4.5 4.5 0 0 1 4.4 5.4l-.9 4.5A2.6 2.6 0 0 1 16.5 18L15 16H9l-1.5 2a2.6 2.6 0 0 1-4.5-1.1l-.9-4.5A4.5 4.5 0 0 1 6.5 7z',
  wand: 'M4 20L16 8M14 4l1.2 2.8L18 8l-2.8 1.2L14 12l-1.2-2.8L10 8l2.8-1.2zM19 14l.7 1.6L21 16l-1.3.4L19 18l-.7-1.6L17 16l1.3-.4z',
  ghost: 'M5 21V10a7 7 0 0 1 14 0v11l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2zM9.5 10h.01M14.5 10h.01',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  record: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  gauge: 'M12 21a9 9 0 1 1 9-9M12 12l4-3M4 15h3M17 15h3',
  text: 'M4 6h16M4 12h16M4 18h10',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  quote: 'M9 7H5v5h4c0 2-1 3-3 3v2c3.5 0 5-2 5-6V7zM20 7h-4v5h4c0 2-1 3-3 3v2c3.5 0 5-2 5-6V7z',
  cards: 'M7 7h12v12H7zM4 4h12v2H5v11H4z',
  alert: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  container: 'M4 10h3v4H4zM8 10h3v4H8zM12 10h3v4h-3zM8 6h3v3H8zM3 15h18a4 4 0 0 1-4 4H8a5 5 0 0 1-5-4z',
  graph: 'M12 3l7 4v10l-7 4-7-4V7zM12 3v8M12 11l7-4M12 11l-7-4M12 11v10',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  snippet: 'M8 4h8a2 2 0 0 1 2 2v14l-6-3-6 3V6a2 2 0 0 1 2-2z',
  play: 'M7 4l12 8-12 8z',
  pause: 'M9 5v14M15 5v14',
  shuffle: 'M4 7h4l8 10h4M4 17h4l2-2.5M16 7h4M18 5l2 2-2 2M18 15l2 2-2 2',
};

/**
 * An inline SVG icon.
 *
 * Presentation is set on the element itself rather than inherited from an
 * ancestor rule. Relying on `.icon-btn svg { fill:none }` breaks the moment
 * an icon is used outside a button — the glyph fills solid black and renders
 * as a blob, because `fill` defaults to black and these are stroke drawings.
 *
 * @param {keyof ICON_PATHS} name
 */
export function icon(name, props = {}) {
  const d = ICON_PATHS[name] || ICON_PATHS.info;
  const { size, ...rest } = props;
  const svg = h('svg:svg', {
    viewBox: '0 0 24 24',
    width: size || 16,
    height: size || 16,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    ...rest,
  });
  // Each `M` starts a new subpath; separate elements keep joins clean.
  for (const segment of d.split('M').filter(Boolean)) {
    svg.appendChild(h('svg:path', { d: 'M' + segment }));
  }
  return svg;
}

export const ICONS = Object.keys(ICON_PATHS);

/** Favicon element with a lettered fallback when the site has none. */
export function favicon(url, faviconUrl, size = 16) {
  if (faviconUrl) {
    return h('img.favicon', {
      src: faviconUrl,
      width: size,
      height: size,
      loading: 'lazy',
      // A broken favicon must not leave a torn image in the tab strip.
      onerror: (e) => e.target.replaceWith(letterFavicon(url, size)),
    });
  }
  return letterFavicon(url, size);
}

function letterFavicon(url, size) {
  let letter = '?';
  let hue = 220;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    letter = host[0]?.toUpperCase() || '?';
    // Stable colour per host, so a site looks the same every visit.
    let hash = 0;
    for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    hue = hash % 360;
  } catch { /* internal page */ }

  return h('span.favicon-letter', {
    style: {
      width: `${size}px`,
      height: `${size}px`,
      background: `oklch(0.72 0.11 ${hue})`,
      fontSize: `${Math.round(size * 0.62)}px`,
    },
    text: letter,
  });
}

/** Format bytes for the UI. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Relative time, in the terse form a browser UI wants. */
export function formatRelative(timestamp) {
  if (!timestamp) return '';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * The part of a URL a user reads: the host, de-www'd.
 *
 * Returns the host *only* — callers render the scheme separately so it can
 * be visually de-emphasised. Including it here too produced
 * `aether://aether://onboarding` in the address bar.
 */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}
