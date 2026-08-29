/**
 * Toolbar: navigation, the address bar, and the per-site privacy controls.
 *
 * The address bar has two states. Unfocused it shows a *formatted* URL —
 * host emphasised, scheme and path dimmed — which is the single most
 * effective anti-phishing affordance a browser has. Focused it becomes a
 * plain editable input showing the real, complete URL, because hiding part
 * of it while the user edits is its own hazard.
 */
import { h, icon, clear, displayHost } from '../core/dom.js';
import { state, subscribe, invoke, selectors, toast } from '../core/store.js';
import { MODE_PANELS } from './mode-panels.js';

/**
 * The three panels every mode has access to, described here so the toolbar
 * can label them the same way it labels mode panels.
 */
const BASELINE_PANEL_META = {
  ai: { label: 'AI assistant', icon: 'sparkle' },
  notes: { label: 'Notes', icon: 'note' },
  dev: { label: 'Developer', icon: 'code' },
};

/** Headings for grouped omnibox results. Unlisted kinds render ungrouped. */
const KIND_LABELS = {
  tab: 'Open tabs',
  history: 'History',
  bookmark: 'Bookmarks',
  search: 'Search',
  url: 'Go to',
  setting: 'Settings',
  extension: 'Extensions',
  snippet: 'Snippets',
};

/**
 * Split a label around the typed substring so the match can be emphasised.
 *
 * Returns nodes rather than HTML: suggestion titles come from page titles and
 * history, which is attacker-influenced text, and this renderer is privileged.
 * Building text nodes means there is no string concatenation to get wrong.
 */
function highlight(text, query) {
  const label = String(text || '');
  const needle = String(query || '').trim();
  if (!needle || needle.length < 2) return [document.createTextNode(label)];

  const at = label.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1) return [document.createTextNode(label)];

  return [
    document.createTextNode(label.slice(0, at)),
    h('mark', { text: label.slice(at, at + needle.length) }),
    document.createTextNode(label.slice(at + needle.length)),
  ];
}

export function createToolbar({ container }) {
  let inputEl = null;
  let suggestionsEl = null;

  // ---- structure (built once; contents update in place) ----------------

  const back = navButton('back', 'Back', () => invoke('tabs.goBack', {}));
  const forward = navButton('forward', 'Forward', () => invoke('tabs.goForward', {}));
  const reload = h('button.icon-btn.no-drag', {
    title: 'Reload',
    onclick: () => {
      const tab = selectors.activeTab();
      if (tab?.loading) invoke('tabs.stop', {});
      else invoke('tabs.reload', {});
    },
  }, icon('reload'));

  const leadIcon = h('span.omnibox-lead', {
    title: 'Site information',
    onclick: (e) => openPopover('site', e.currentTarget),
  }, icon('globe'));

  const display = h('div.omnibox-display');

  inputEl = h('input.omnibox-input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'Search or enter address',
    style: { display: 'none' },
    onfocus: () => enterEditing(),
    onblur: () => setTimeout(exitEditing, 120), // let a suggestion click land
    oninput: () => onType(),
    onkeydown: (e) => onKeyDown(e),
  });

  const shield = h('button.icon-btn.no-drag', {
    title: 'Tracker blocking',
    style: { position: 'relative' },
    onclick: (e) => openPopover('shield', e.currentTarget),
  }, icon('shield'), h('span.shield-count', { style: { display: 'none' } }));

  const bookmark = h('button.icon-btn.no-drag', {
    title: 'Bookmark this page',
    onclick: () => invoke('bookmarks.add', {}).then(() => toast('Bookmarked', 'success')),
  }, icon('star'));

  const readerBtn = h('button.icon-btn.no-drag', {
    title: 'Reader mode',
    onclick: () => invoke('reader.toggle', {}).catch(() => {}),
  }, icon('book'));

  const omnibox = h('div.omnibox', {},
    leadIcon,
    display,
    inputEl,
    h('div.omnibox-actions', {}, readerBtn, bookmark, shield));

  suggestionsEl = h('div.omnibox-suggestions', { style: { display: 'none' } });

  // Which panel buttons appear is the active mode's decision (spec §1). This
  // slot is re-rendered on every mode change; the buttons after it are
  // baseline browser controls and never move.
  const panelButtons = h('div.panel-buttons', {
    style: { display: 'flex', gap: '2px', flex: 'none' },
  });

  const rightGroup = h('div', { style: { display: 'flex', gap: '2px', flex: 'none' } },
    panelButtons,
    toolbarButton('vpn', 'VPN', (e) => openPopover('vpn', e.currentTarget), 'vpn-button'),
    toolbarButton('download', 'Downloads', (e) => openPopover('downloads', e.currentTarget)),
    toolbarButton('more', 'Menu', (e) => openPopover('menu', e.currentTarget)));

  renderPanelButtons();
  subscribe('modes', renderPanelButtons);

  /**
   * Build one button per panel the active mode surfaces.
   *
   * Labels and icons come from the panel registry rather than being repeated
   * here, so a panel is described in exactly one place.
   */
  function renderPanelButtons() {
    clear(panelButtons);
    const ids = state.modes?.panels?.length ? state.modes.panels : ['ai', 'notes', 'dev'];

    for (const id of ids) {
      const view = BASELINE_PANEL_META[id] || MODE_PANELS[id];
      // A mode may name a panel this build does not have. Skipping keeps the
      // rest of the toolbar working.
      if (!view) continue;
      panelButtons.appendChild(
        toolbarButton(view.icon, view.label, () => togglePanel(id)),
      );
    }
  }

  const windowControls = h('div.window-controls', {},
    h('button.icon-btn', { title: 'Minimise', onclick: () => invoke('window.minimize', {}) },
      h('svg:svg', { viewBox: '0 0 24 24' }, h('svg:path', { d: 'M5 12h14' }))),
    h('button.icon-btn', { title: 'Maximise', onclick: () => invoke('window.maximize', {}) },
      h('svg:svg', { viewBox: '0 0 24 24' }, h('svg:path', { d: 'M5 5h14v14H5z' }))),
    h('button.icon-btn', { title: 'Close', onclick: () => invoke('window.close', {}) },
      icon('close')));

  const progress = h('div.load-progress', { style: { display: 'none' } });

  container.append(back, forward, reload, omnibox, rightGroup, windowControls, progress);
  document.body.appendChild(suggestionsEl);

  // ---- editing ---------------------------------------------------------

  function enterEditing() {
    const tab = selectors.activeTab();
    omnibox.classList.add('is-focused');
    display.style.display = 'none';
    inputEl.style.display = '';
    // Show the *whole* URL while editing; the formatted view is for reading.
    inputEl.value = tab?.url?.startsWith('shaurya://start') ? '' : (tab?.url || '');
    inputEl.select();
    state.omnibox.focused = true;
  }

  function exitEditing() {
    if (document.activeElement === inputEl) return;
    omnibox.classList.remove('is-focused');
    inputEl.style.display = 'none';
    display.style.display = '';
    suggestionsEl.style.display = 'none';
    state.omnibox.focused = false;
    render();
  }

  let suggestToken = 0;
  async function onType() {
    const query = inputEl.value;
    const token = ++suggestToken;
    if (!query.trim()) {
      suggestionsEl.style.display = 'none';
      return;
    }
    const results = await invoke('omnibox.suggest', { query }, { quiet: true }).catch(() => []);
    // A slow response for an older keystroke must not overwrite a newer one.
    if (token !== suggestToken) return;
    renderSuggestions(results);
  }

  function renderSuggestions(results) {
    state.omnibox.suggestions = results;
    state.omnibox.selectedIndex = 0;
    clear(suggestionsEl);
    if (!results.length) {
      suggestionsEl.style.display = 'none';
      return;
    }

    // Group by kind with a heading on each run. An undifferentiated list of
    // twelve rows makes the user read every one; a labelled run of three lets
    // them jump straight to the section they meant. Headings are rendered
    // only when the kind actually changes, so a homogeneous list stays flat.
    const typed = inputEl.value.trim();
    let lastKind = null;

    for (const [i, result] of results.entries()) {
      if (result.kind && result.kind !== lastKind) {
        lastKind = result.kind;
        const label = KIND_LABELS[result.kind];
        if (label) suggestionsEl.appendChild(h('div.suggestion-group', { text: label }));
      }

      suggestionsEl.appendChild(h('div.suggestion', {
        class: { 'is-selected': i === 0 },
        dataset: { index: String(i), kind: result.kind || 'other' },
        role: 'option',
        'aria-selected': String(i === 0),
        onmousedown: (e) => { e.preventDefault(); commit(result); },
        onmouseenter: () => selectSuggestion(i),
      },
      h('span.suggestion-icon', {}, icon(result.icon || 'globe')),
      h('div.suggestion-text', {},
        // Highlighting what the user typed is what makes a suggestion list
        // scannable — the eye locks onto the bold run rather than reading.
        h('div.suggestion-title.truncate', {}, ...highlight(result.title, typed)),
        h('div.suggestion-sub.truncate', { text: result.subtitle || '' })),
      // Only the action a row performs, and only where it is not obvious.
      result.kind === 'tab' ? h('span.chip', { text: 'Switch to' }) : null,
      i === 0 ? h('kbd.suggestion-enter', { text: '↵' }) : null));
    }

    const rect = omnibox.getBoundingClientRect();
    Object.assign(suggestionsEl.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.bottom + 4}px`,
      width: `${rect.width}px`,
    });
  }

  function selectSuggestion(index) {
    state.omnibox.selectedIndex = index;
    for (const el of suggestionsEl.children) {
      if (!el.dataset.index) continue;   // a group heading, not a row
      const selected = Number(el.dataset.index) === index;
      el.classList.toggle('is-selected', selected);
      el.setAttribute('aria-selected', String(selected));
      // The Enter hint follows the selection rather than sitting on row zero
      // forever, so it always shows what pressing Enter will actually do.
      el.querySelector('.suggestion-enter')?.remove();
      if (selected) el.appendChild(h('kbd.suggestion-enter', { text: '↵' }));
    }
  }

  function onKeyDown(event) {
    const { suggestions, selectedIndex } = state.omnibox;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!suggestions.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (selectedIndex + delta + suggestions.length) % suggestions.length;
      selectSuggestion(next);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = suggestions[selectedIndex];
      if (chosen && inputEl.value.trim()) commit(chosen);
      else commit({ kind: 'navigate', raw: inputEl.value });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      inputEl.blur();
    }
  }

  function commit(result) {
    suggestionsEl.style.display = 'none';
    inputEl.blur();
    if (result.kind === 'tab' && result.tabId) {
      invoke('tabs.activate', { id: result.tabId });
    } else {
      invoke('tabs.navigate', result.url ? { url: result.url } : { raw: result.raw });
    }
  }

  // ---- render ----------------------------------------------------------

  function render() {
    const tab = selectors.activeTab();

    back.disabled = !tab?.canGoBack;
    forward.disabled = !tab?.canGoForward;
    clear(reload);
    reload.appendChild(icon(tab?.loading ? 'stop' : 'reload'));
    reload.title = tab?.loading ? 'Stop' : 'Reload';
    progress.style.display = tab?.loading ? 'block' : 'none';

    if (!state.omnibox.focused) renderDisplay(tab);

    // Lead icon reflects the real security state of the origin.
    clear(leadIcon);
    leadIcon.className = 'omnibox-lead';
    if (!tab?.url || tab.url.startsWith('shaurya://')) {
      leadIcon.appendChild(icon('sparkle'));
    } else if (tab.url.startsWith('https://')) {
      leadIcon.classList.add('secure');
      leadIcon.appendChild(icon('lock'));
    } else {
      leadIcon.classList.add('insecure');
      leadIcon.appendChild(icon('warning'));
      leadIcon.title = 'This connection is not encrypted';
    }

    // Blocked-count badge on the shield (spec §3).
    const count = state.adblock?.count || 0;
    const badge = shield.querySelector('.shield-count');
    badge.style.display = count > 0 ? 'grid' : 'none';
    badge.textContent = count > 99 ? '99+' : String(count);

    // Running on the bundled seed means the real subscriptions have never
    // downloaded. A plain "0 blocked" would read as "this page is clean",
    // which is the opposite of what is happening, so say so on the control
    // the user would look at.
    const degraded = Boolean(state.adblock?.seedOnly);
    shield.classList.toggle('is-degraded', degraded);
    shield.title = degraded
      ? 'Limited protection — filter lists have not downloaded yet'
      : `${count} tracker${count === 1 ? '' : 's'} blocked on this page`;

    readerBtn.style.display = selectors.feature('reader') ? '' : 'none';
    readerBtn.classList.toggle('is-active', Boolean(tab?.readerMode));

    // VPN button reflects connection state.
    const vpnButton = rightGroup.querySelector('.vpn-button');
    if (vpnButton) {
      vpnButton.style.display = selectors.feature('vpn') ? '' : 'none';
      vpnButton.classList.toggle('is-active', state.vpn?.status === 'connected');
    }

    for (const [id, feature] of [['sparkle', 'ai'], ['note', 'aiNotes'], ['code', 'devtools']]) {
      const button = rightGroup.querySelector(`[data-icon="${id}"]`);
      if (button) button.style.display = selectors.feature(feature) ? '' : 'none';
    }
  }

  function renderDisplay(tab) {
    clear(display);
    const url = tab?.url || '';
    if (!url || url.startsWith('shaurya://start')) {
      display.appendChild(h('span.omnibox-path', { text: 'Search or enter address' }));
      return;
    }
    try {
      const parsed = new URL(url);
      display.append(
        h('span.omnibox-scheme', { text: parsed.protocol === 'https:' ? '' : `${parsed.protocol}//` }),
        h('span.omnibox-host', { text: displayHost(url) }),
        h('span.omnibox-path', { text: parsed.pathname === '/' ? '' : parsed.pathname + parsed.search })
      );
    } catch {
      display.appendChild(h('span.omnibox-host', { text: url }));
    }
  }

  function focusAddressBar() {
    inputEl.focus();
  }

  subscribe(['tabs', 'adblock', 'vpn', 'features', 'settings'], render);
  render();

  return { render, focusAddressBar, element: container };
}

function navButton(name, title, onclick) {
  return h('button.icon-btn.no-drag', { title, onclick }, icon(name));
}

function toolbarButton(name, title, onclick, extraClass) {
  const button = h('button.icon-btn.no-drag', {
    title,
    onclick,
    dataset: { icon: name },
  }, icon(name));
  if (extraClass) button.classList.add(extraClass);
  return button;
}

function togglePanel(kind) {
  window.dispatchEvent(new CustomEvent('shaurya:panel', { detail: { kind } }));
}

function openPopover(kind, anchor) {
  window.dispatchEvent(new CustomEvent('shaurya:popover', { detail: { kind, anchor } }));
}
