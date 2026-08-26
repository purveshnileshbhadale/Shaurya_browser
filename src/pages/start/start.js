/**
 * Start page (spec §2).
 *
 * Runs on `aether://start`, which is a real origin with its own storage, so
 * widget state persists per profile without touching the settings document.
 * The speed dial seeds from actual top sites on first run rather than
 * shipping a list of sponsored placeholders.
 */

const api = window.aether;

const dial = document.getElementById('dial');
const widgets = document.getElementById('widgets');
const clockEl = document.getElementById('clock');
const searchInput = document.getElementById('search');
const blockedStat = document.getElementById('blocked-stat');

let settings = {};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  settings = await api.invoke('settings.get', { path: 'startPage' }).catch(() => ({}));

  document.getElementById('bg').dataset.background = settings.background || 'aurora';
  applyAppearance();
  startClock();
  await renderDial();
  renderWidgets();
  renderStats();

  document.getElementById('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = searchInput.value.trim();
    if (value) api.invoke('tabs.navigate', { raw: value });
  });

  document.getElementById('customise').addEventListener('click', () => {
    api.invoke('tabs.navigate', { url: 'aether://settings/#startPage' });
  });
}());

async function applyAppearance() {
  const appearance = await api.invoke('settings.get', { path: 'appearance' }).catch(() => ({}));
  const root = document.documentElement;
  if (appearance.theme && appearance.theme !== 'system') root.dataset.theme = appearance.theme;
  if (appearance.accent) root.style.setProperty('--accent', appearance.accent);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function startClock() {
  if (!settings.widgets?.clock && settings.widgets?.clock !== undefined) {
    // The clock doubles as the page's heading, so it stays unless explicitly off.
  }
  const tick = () => {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = document.createElement('small');
    date.textContent = now.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    clockEl.appendChild(date);
  };
  tick();
  // Align to the next minute so the display never lags behind the real time.
  setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, (60 - new Date().getSeconds()) * 1000);
}

// ---------------------------------------------------------------------------
// Speed dial
// ---------------------------------------------------------------------------

async function renderDial() {
  let tiles = settings.speedDial || [];

  // First run: seed from the user's own most-visited sites.
  if (!tiles.length) {
    const history = await api.invoke('history.query', { limit: 60 }).catch(() => []);
    const byHost = new Map();
    for (const entry of history) {
      try {
        const host = new URL(entry.url).hostname;
        if (!byHost.has(host)) byHost.set(host, { url: entry.url, title: entry.title });
      } catch { /* skip malformed */ }
    }
    tiles = [...byHost.values()].slice(0, 10);
  }

  dial.replaceChildren();
  for (const tile of tiles) dial.appendChild(tileEl(tile, tiles));

  const add = el('button', 'dial-tile is-add');
  add.append(el('div', 'dial-icon', '+', { background: 'var(--bg-hover)', color: 'var(--text-tertiary)' }));
  add.appendChild(el('div', 'dial-label', 'Add site'));
  add.addEventListener('click', async () => {
    const url = prompt('Site URL');
    if (!url) return;
    const next = [...tiles, { url, title: hostOf(url) }];
    await save(next);
    settings.speedDial = next;
    renderDial();
  });
  dial.appendChild(add);
}

function tileEl(tile, tiles) {
  const button = el('button', 'dial-tile');
  button.title = tile.url;

  const iconWrap = el('div', 'dial-icon', '', { background: colorFor(tile.url) });
  const host = hostOf(tile.url);
  // Favicons come from the site's own /favicon.ico, fetched by the page's
  // own origin — no third-party favicon service, which would leak the user's
  // browsing to whoever runs it.
  const img = document.createElement('img');
  img.src = `${new URL(tile.url).origin}/favicon.ico`;
  img.alt = '';
  img.onerror = () => { img.remove(); iconWrap.textContent = host[0]?.toUpperCase() || '?'; };
  iconWrap.appendChild(img);

  button.append(iconWrap, el('div', 'dial-label', tile.title || host));

  const remove = el('span', 'dial-remove', '×');
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    const next = tiles.filter((t) => t.url !== tile.url);
    await save(next);
    settings.speedDial = next;
    renderDial();
  });
  button.appendChild(remove);

  button.addEventListener('click', () => api.invoke('tabs.navigate', { url: tile.url }));
  return button;
}

function save(tiles) {
  return api.invoke('settings.set', { path: 'startPage.speedDial', value: tiles });
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function renderWidgets() {
  widgets.replaceChildren();
  const enabled = settings.widgets || {};
  if (enabled.todo !== false) widgets.appendChild(todoWidget());
  if (enabled.notes !== false) widgets.appendChild(notesWidget());
  if (enabled.weather) widgets.appendChild(weatherWidget());
}

/** A to-do list, stored in this origin's localStorage. */
function todoWidget() {
  const card = el('section', 'widget');
  card.appendChild(el('h3', '', 'To-do'));
  const list = el('div');
  card.appendChild(list);

  let items = readStore('todo', []);

  function render() {
    list.replaceChildren();
    for (const [index, item] of items.entries()) {
      const row = el('label', `todo-item${item.done ? ' done' : ''}`);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.addEventListener('change', () => {
        items[index].done = box.checked;
        writeStore('todo', items);
        render();
      });
      row.append(box, el('span', '', item.text));
      list.appendChild(row);
    }
  }

  const input = document.createElement('input');
  input.className = 'todo-add';
  input.placeholder = 'Add a task…';
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !input.value.trim()) return;
    items = [...items, { text: input.value.trim(), done: false }];
    writeStore('todo', items);
    input.value = '';
    render();
  });

  card.appendChild(input);
  render();
  return card;
}

/** Recent AI notes, so the start page surfaces what you saved. */
function notesWidget() {
  const card = el('section', 'widget');
  card.appendChild(el('h3', '', 'Recent notes'));
  const body = el('div');
  card.appendChild(body);

  api.invoke('notes.list', { }).then((notes) => {
    if (!notes.length) {
      body.appendChild(el('div', 'dimmer', 'Generate notes from any article to see them here.'));
      return;
    }
    for (const note of notes.slice(0, 4)) {
      const row = el('div', 'note-preview');
      row.appendChild(el('strong', '', note.title));
      row.append(document.createTextNode(note.excerpt || ''));
      row.addEventListener('click', () =>
        api.invoke('tabs.navigate', { url: `aether://notes/#${note.id}` }));
      body.appendChild(row);
    }
  }).catch(() => {
    body.appendChild(el('div', 'dimmer', 'Notes are turned off in the Feature Store.'));
  });

  return card;
}

/**
 * Weather from Open-Meteo, which needs no API key and no account — so the
 * widget works out of the box without asking the user to sign up for
 * anything, and the request carries only a coarse location.
 */
function weatherWidget() {
  const card = el('section', 'widget');
  card.appendChild(el('h3', '', 'Weather'));
  const body = el('div');
  card.appendChild(body);
  body.appendChild(el('div', 'dimmer', 'Loading…'));

  const place = settings.weatherLocation;
  if (!place) {
    body.replaceChildren(el('div', 'dimmer', 'Set a location in Settings › Start page.'));
    return card;
  }

  (async () => {
    try {
      const geo = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`
      ).then((r) => r.json());
      const spot = geo.results?.[0];
      if (!spot) throw new Error('location not found');

      const forecast = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}`
        + `&longitude=${spot.longitude}&current=temperature_2m,weather_code`
      ).then((r) => r.json());

      const current = forecast.current;
      body.replaceChildren();
      const now = el('div', 'weather-now');
      now.append(
        el('span', 'weather-temp', `${Math.round(current.temperature_2m)}°`),
        el('span', 'weather-desc', describeWeather(current.weather_code))
      );
      body.append(now, el('div', 'dimmer', spot.name));
    } catch (err) {
      body.replaceChildren(el('div', 'dimmer', `Weather unavailable (${err.message})`));
    }
  })();

  return card;
}

/** WMO weather codes, condensed to what a widget needs to say. */
function describeWeather(code) {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

async function renderStats() {
  const stats = await api.invoke('adblock.stats', {}).catch(() => null);
  if (!stats?.lifetime) return;
  blockedStat.textContent = `${stats.lifetime.toLocaleString()} trackers and ads blocked`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, className = '', text = '', style = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  if (style) Object.assign(node.style, style);
  return node;
}

function hostOf(url) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Stable per-host colour, so a tile looks the same on every visit. */
function colorFor(url) {
  const host = hostOf(url);
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `oklch(0.68 0.13 ${hash % 360})`;
}

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`aether.start.${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(`aether.start.${key}`, JSON.stringify(value));
  } catch { /* storage disabled; the widget still works for this session */ }
}
