/**
 * Command palette (spec §2).
 *
 * Cmd/Ctrl+K over open tabs, history, bookmarks, settings, installed
 * extensions and every command — one box, fuzzy-matched, ranked in the main
 * process so all six sources compete on one scale.
 *
 * It renders in the overlay view, which sits above the page views. That is
 * the only way a palette can visually cover page content in a
 * multi-WebContentsView browser.
 */
import { h, icon, clear, delegate } from '../core/dom.js';
import { invoke } from '../core/store.js';

export function createPalette({ root, onClose }) {
  let results = [];
  let selected = 0;
  let searchToken = 0;

  const input = h('input.palette-input', {
    type: 'text',
    placeholder: 'Search tabs, history, bookmarks, settings and commands…',
    spellcheck: 'false',
    autocomplete: 'off',
    oninput: () => search(input.value),
    onkeydown: (event) => onKeyDown(event),
  });

  const list = h('div.palette-list');

  const panel = h('div.palette', {},
    h('div.palette-head', {}, icon('search'), input),
    list,
    h('div.palette-foot', {},
      hint('↑↓', 'navigate'),
      hint('↵', 'open'),
      hint('esc', 'close')));

  const backdrop = h('div.palette-backdrop', {
    onclick: (event) => { if (event.target === backdrop) close(); },
  }, panel);

  root.appendChild(backdrop);

  delegate(list, 'click', '.palette-item', (_event, el) => {
    run(results[Number(el.dataset.index)]);
  });
  delegate(list, 'mousemove', '.palette-item', (_event, el) => {
    select(Number(el.dataset.index));
  });

  async function search(query) {
    const token = ++searchToken;
    const found = await invoke('palette.search', { query }, { quiet: true }).catch(() => []);
    // Discard a stale response so a slow query cannot clobber a fresh one.
    if (token !== searchToken) return;
    results = found;
    selected = 0;
    render();
  }

  function render() {
    clear(list);
    if (!results.length) {
      list.appendChild(h('div.empty', {}, 'No matches'));
      return;
    }

    let lastKind = null;
    for (const [index, result] of results.entries()) {
      if (result.kind !== lastKind) {
        list.appendChild(h('div.palette-group', { text: groupLabel(result.kind) }));
        lastKind = result.kind;
      }
      list.appendChild(h('div.palette-item', {
        class: { 'is-selected': index === selected },
        dataset: { index: String(index) },
      },
      icon(result.icon || 'globe', { class: 'palette-icon' }),
      h('div.palette-text', {},
        h('div.palette-title.truncate', { text: result.title }),
        result.subtitle && h('div.palette-sub.truncate', { text: result.subtitle })),
      result.accelerator && h('kbd.palette-accel', { text: prettyAccelerator(result.accelerator) })));
    }
    scrollSelectedIntoView();
  }

  function select(index) {
    if (index === selected) return;
    selected = index;
    for (const el of list.querySelectorAll('.palette-item')) {
      el.classList.toggle('is-selected', Number(el.dataset.index) === selected);
    }
  }

  function scrollSelectedIntoView() {
    const el = list.querySelector('.palette-item.is-selected');
    // `nearest` avoids the jarring re-centre that `center` causes when
    // arrowing one row at a time.
    el?.scrollIntoView({ block: 'nearest' });
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      if (results.length) select((selected + 1) % results.length);
      scrollSelectedIntoView();
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      if (results.length) select((selected - 1 + results.length) % results.length);
      scrollSelectedIntoView();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(results[selected]);
    }
  }

  async function run(result) {
    if (!result) return;
    close();
    await invoke('palette.run', result).catch(() => {});
  }

  function open() {
    backdrop.style.display = 'flex';
    input.value = '';
    input.focus();
    search('');
  }

  function close() {
    backdrop.style.display = 'none';
    onClose?.();
  }

  return { open, close, element: backdrop };
}

function groupLabel(kind) {
  return {
    command: 'Commands',
    tab: 'Open tabs',
    bookmark: 'Bookmarks',
    history: 'History',
    setting: 'Settings',
    extension: 'Extensions',
  }[kind] || kind;
}

function hint(key, label) {
  return h('span.palette-hint', {}, h('kbd', { text: key }), h('span', { text: label }));
}

/** Render an Electron accelerator the way the platform writes it. */
export function prettyAccelerator(accelerator) {
  if (!accelerator) return '';
  const mac = navigator.platform.toLowerCase().includes('mac');
  return accelerator
    .replace(/CmdOrCtrl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Cmd|Command/g, '⌘')
    .replace(/Control|Ctrl/g, mac ? '⌃' : 'Ctrl')
    .replace(/Alt|Option/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .replace(/\+/g, mac ? '' : '+')
    .replace(/Left/g, '←').replace(/Right/g, '→')
    .replace(/Up/g, '↑').replace(/Down/g, '↓');
}
