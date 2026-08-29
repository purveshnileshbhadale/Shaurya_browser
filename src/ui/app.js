/**
 * Chrome renderer entry point.
 *
 * Assembles the shell, wires the keyboard scheme, and keeps the CSS grid in
 * agreement with the geometry the main process actually applied to the page
 * views. That last part matters: if the chrome and the main process disagree
 * about the sidebar width by even a pixel, a strip of page shows through
 * beside the toolbar.
 */
import { h, icon, clear, $, formatRelative } from './core/dom.js';
import {
  state, subscribe, invoke, send, on, boot, toast, selectors, applyTheme, env,
} from './core/store.js';
import { createTabStrip } from './components/tabstrip.js';
import { createToolbar } from './components/toolbar.js';
import { createPanel } from './components/panels.js';
import { createModeSwitcher, createQuickActions } from './components/mode-switcher.js';
import { createGamepadNavigation } from './components/gamepad.js';
import { createNowPlaying } from './components/now-playing.js';
import { prettyAccelerator } from './components/palette.js';

const shell = $('#shell');
const sidebarScroll = $('#sidebar-tabs');
const tabstripEl = $('#tabstrip');
const toolbarEl = $('#toolbar');
const panelEl = $('#panel');

let toolbar = null;
let panel = null;
let findBar = null;
let modeSwitcher = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  document.documentElement.dataset.platform = env.platform;
  if (env.incognito === 'true') document.documentElement.dataset.private = 'true';

  try {
    const initial = await boot();

    createTabStrip({ container: sidebarScroll, orientation: 'vertical' });
    createTabStrip({ container: tabstripEl, orientation: 'horizontal' });
    toolbar = createToolbar({ container: toolbarEl });
    panel = createPanel({ container: panelEl });
    // Panels are reachable from the mode switcher's quick actions and from
    // shaurya:// pages, so the instance is published rather than passed
    // through four layers of arguments.
    window.shauryaPanels = panel;

    wireShellChrome();
    wireKeyboard();
    wireGamepad();
    wireEventBridges();
    syncLayout();

    // First run goes straight to onboarding (spec §9).
    if (!initial.onboarding?.completed) {
      invoke('tabs.navigate', { url: 'shaurya://onboarding' });
    }

    send('ui.ready', {});
  } catch (err) {
    console.error('[shaurya] failed to start', err);
    document.body.appendChild(h('div.toast', { dataset: { tone: 'error' } },
      `Shaurya failed to start: ${err.message}`));
  }
}());

// ---------------------------------------------------------------------------
// Shell chrome
// ---------------------------------------------------------------------------

function wireShellChrome() {
  // --- sidebar header ---
  const head = $('#sidebar-head');
  head.append(
    h('button.workspace-switch', {
      onclick: (e) => openWorkspaceMenu(e.currentTarget),
    }, h('span.workspace-dot'), h('span.truncate', { text: 'Shaurya' }),
       icon('chevronDown')),
    h('button.icon-btn', {
      title: 'New tab',
      onclick: () => invoke('tabs.create', {}),
    }, icon('plus')));

  // The Mode Switcher sits on its own row under the workspace picker: it
  // answers "what is this window for", which is a different question from
  // "which tab am I on", and interleaving them makes both harder to find.
  const modeBar = h('div#mode-bar');
  head.after(modeBar);
  // Switcher first so it anchors the row; the actions follow to its right and
  // change with the mode, since the mode document decides which appear.
  modeSwitcher = createModeSwitcher({ container: modeBar });
  const quickActions = h('div.quick-actions');
  modeBar.appendChild(quickActions);
  createQuickActions({ container: quickActions });

  // The now-playing bar sits directly above the footer controls: it appears
  // and disappears with playback, so anchoring it to the bottom keeps the
  // tab list from shifting under the pointer when a track starts.
  const foot = $('#sidebar-foot');
  const nowPlaying = createNowPlaying({ container: foot.parentElement });
  // Above the footer controls, not after them: the footer is a fixed row of
  // targets, and pushing it down when a track starts would move a button out
  // from under the pointer.
  foot.parentElement.insertBefore(nowPlaying.element, foot);

  // --- sidebar footer ---
  $('#sidebar-foot').append(
    h('button.icon-btn', {
      title: 'Toggle sidebar',
      onclick: toggleSidebar,
    }, icon('sidebar')),
    h('button.icon-btn', {
      title: 'Split screen',
      onclick: toggleSplit,
    }, icon('split')),
    h('button.icon-btn', {
      title: 'Settings',
      onclick: () => invoke('tabs.create', { url: 'shaurya://settings' }),
    }, icon('sliders')));

  // --- sidebar resize ---
  const handle = $('#sidebar-resize');
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    handle.classList.add('dragging');
    const move = (e) => {
      const width = Math.max(180, Math.min(480, e.clientX));
      shell.style.setProperty('--sidebar-w', `${width}px`);
    };
    const up = (e) => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      invoke('layout.setSidebarWidth', { width: Math.max(180, Math.min(480, e.clientX)) });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  subscribe(['layout', 'settings'], syncLayout);
  subscribe('toast', renderToast);
  subscribe(['tabs', 'find'], renderFindBar);
}

/**
 * Mirror the main process's geometry into the CSS grid.
 *
 * The main process is authoritative — it positions real WebContentsViews —
 * so the chrome follows it rather than the other way round.
 */
function syncLayout() {
  const layout = state.layout;
  if (!layout) return;

  shell.dataset.orientation = layout.tabOrientation;
  shell.dataset.sidebar = layout.sidebarWidth <= 60 ? 'collapsed' : 'expanded';
  shell.style.setProperty('--sidebar-w', `${layout.sidebarWidth}px`);
  shell.style.setProperty('--toolbar-h', `${layout.toolbarHeight}px`);
  shell.style.setProperty('--tabstrip-h', `${layout.horizontalTabStripHeight}px`);
  if (layout.panelWidth) panelEl.style.setProperty('--panel-w', `${layout.panelWidth}px`);

  renderSplitDivider(layout);
  renderCorsBanner();
}

/**
 * The divider between split panes. Positioned in the gap the main process
 * left, so dragging it maps directly onto the real pane boundary.
 */
function renderSplitDivider(layout) {
  let divider = $('#split-divider');
  if (!layout.divider) {
    divider?.remove();
    return;
  }
  if (!divider) {
    divider = h('div#split-divider.split-divider');
    document.body.appendChild(divider);
    divider.addEventListener('mousedown', (event) => {
      event.preventDefault();
      divider.classList.add('dragging');
      const move = (e) => {
        const rect = state.layout.contentRect;
        const ratio = (e.clientX - rect.x) / rect.width;
        invoke('layout.setSplitRatio', { ratio });
      };
      const up = () => {
        divider.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  Object.assign(divider.style, {
    left: `${layout.divider.x}px`,
    top: `${layout.divider.y}px`,
    width: `${layout.divider.width}px`,
    height: `${layout.divider.height}px`,
  });
}

/** The un-dismissable CORS warning (spec §5). */
async function renderCorsBanner() {
  const status = await invoke('cors.status', {}, { quiet: true }).catch(() => null);
  const existing = $('#cors-banner');
  if (!status?.anyActive) {
    existing?.remove();
    return;
  }
  if (existing) return;
  shell.insertBefore(
    h('div#cors-banner.warning-banner', {}, icon('warning'),
      h('span', { text: status.warning }),
      h('button.btn.btn-ghost', {
        onclick: () => invoke('cors.setEnabled', {
          profileId: status.active[0].profileId, enabled: false,
        }).then(renderCorsBanner),
      }, 'Turn off')),
    shell.firstChild
  );
}

function renderToast() {
  $('#toast')?.remove();
  if (!state.toast) return;
  document.body.appendChild(h('div#toast.toast', {
    dataset: { tone: state.toast.tone },
  }, icon(state.toast.tone === 'error' ? 'warning' : 'info'),
     h('span', { text: state.toast.message })));
}

function renderFindBar() {
  if (!state.find?.active) {
    findBar?.remove();
    findBar = null;
    return;
  }
  if (findBar) {
    findBar.querySelector('.find-count').textContent = state.find.matches != null
      ? `${state.find.activeMatchOrdinal || 0}/${state.find.matches}`
      : '';
    return;
  }

  const input = h('input', {
    placeholder: 'Find in page',
    oninput: () => invoke('tabs.findInPage', { text: input.value }),
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        invoke('tabs.findInPage', {
          text: input.value, findNext: true, forward: !event.shiftKey,
        });
      } else if (event.key === 'Escape') {
        closeFind();
      }
    },
  });

  findBar = h('div.find-bar', {}, input,
    h('span.find-count'),
    h('button.icon-btn', {
      title: 'Previous',
      onclick: () => invoke('tabs.findInPage', { text: input.value, findNext: true, forward: false }),
    }, icon('chevronDown', { style: 'transform:rotate(180deg)' })),
    h('button.icon-btn', {
      title: 'Next',
      onclick: () => invoke('tabs.findInPage', { text: input.value, findNext: true, forward: true }),
    }, icon('chevronDown')),
    h('button.icon-btn', { title: 'Close', onclick: closeFind }, icon('close')));

  document.body.appendChild(findBar);
  input.focus();
}

function closeFind() {
  invoke('tabs.stopFind', {});
  state.find = null;
  renderFindBar();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * Every command is reachable without a mouse (spec §5).
 *
 * Chords are matched against the *current* scheme, so a remap takes effect
 * immediately without a restart.
 */
function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    // Never steal a chord from a text field unless it is a global one.
    const typing = /^(INPUT|TEXTAREA)$/.test(event.target.tagName)
      || event.target.isContentEditable;

    const chord = chordFor(event);
    const command = state.shortcuts.find((s) => normalise(s.accelerator) === chord);
    if (!command) return;
    if (typing && !GLOBAL_WHILE_TYPING.has(command.id)) return;

    event.preventDefault();
    runCommand(command.id);
  });

  window.addEventListener('shaurya:command', (event) => runCommand(event.detail.id));
}

/** Commands that must work even while a text field has focus. */
const GLOBAL_WHILE_TYPING = new Set([
  'palette.open', 'tab.new', 'tab.close', 'window.new', 'window.incognito',
  'nav.focusAddress', 'find.open', 'devtools.toggle', 'settings.open',
]);

function chordFor(event) {
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push('CmdOrCtrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normaliseKey(event.key));
  return normalise(parts.join('+'));
}

function normalise(accelerator) {
  if (!accelerator) return '';
  const parts = String(accelerator).split('+').map((p) => p.trim());
  const key = parts.pop();
  const mods = parts.map((m) =>
    /^(cmd|command|meta|super|cmdorctrl|commandorcontrol|ctrl|control)$/i.test(m) ? 'CmdOrCtrl'
      : /^(alt|option)$/i.test(m) ? 'Alt'
        : /^shift$/i.test(m) ? 'Shift' : m).sort();
  return [...new Set(mods), normaliseKey(key)].join('+');
}

function normaliseKey(key) {
  const map = {
    ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right',
    ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc', '+': 'Plus', '=': 'Plus',
  };
  const mapped = map[key] || key;
  return mapped.length === 1 ? mapped.toUpperCase() : mapped;
}

/**
 * Gamepad navigation (spec §4).
 *
 * Controller commands are mapped onto the same command ids the keyboard
 * uses, so a remapped button and a remapped chord end up in exactly one
 * dispatch table — and a command added for the keyboard is immediately
 * bindable to a button with no extra work.
 */
function wireGamepad() {
  createGamepadNavigation({
    onCommand: (command) => {
      const mapped = GAMEPAD_COMMANDS[command];
      if (mapped) runCommand(mapped);
      else if (command === 'activate') document.activeElement?.click?.();
    },
  });
}

/** Controller command -> the browser command it runs. */
const GAMEPAD_COMMANDS = {
  back: 'nav.back',
  forward: 'nav.forward',
  reload: 'nav.reload',
  palette: 'palette.open',
  tabNext: 'tab.next',
  tabPrev: 'tab.previous',
  newTab: 'tab.new',
  closeTab: 'tab.close',
  zoomIn: 'zoom.in',
  zoomOut: 'zoom.out',
  turbo: 'turbo.toggle',
  clip: 'recorder.clip',
};

/** The single dispatch point for every command in the browser. */
async function runCommand(id) {
  const tab = selectors.activeTab();

  switch (id) {
    // --- tabs ---
    case 'tab.new': return invoke('tabs.create', {});
    case 'tab.close': return invoke('tabs.close', { id: tab?.id });
    case 'tab.duplicate': return invoke('tabs.duplicate', { id: tab?.id });
    case 'tab.pin': return invoke('tabs.pin', { id: tab?.id, pinned: !tab?.pinned });
    case 'tab.hibernate': return invoke('tabs.hibernate', { id: tab?.id });
    case 'tab.next': return cycleTab(1);
    case 'tab.previous': return cycleTab(-1);

    // --- window ---
    case 'window.new': return invoke('window.newWindow', {});
    case 'window.incognito': return invoke('window.newIncognitoWindow', {});
    case 'window.close': return invoke('window.close', {});
    case 'window.fullscreen': return invoke('window.maximize', {});

    // --- navigation ---
    case 'nav.back': return invoke('tabs.goBack', {});
    case 'nav.forward': return invoke('tabs.goForward', {});
    case 'nav.reload': return invoke('tabs.reload', {});
    case 'nav.hardReload': return invoke('tabs.reload', { hard: true });
    case 'nav.stop': return invoke('tabs.stop', {});
    case 'nav.home': return invoke('tabs.navigate', { url: 'shaurya://start' });
    case 'nav.focusAddress': return toolbar.focusAddressBar();

    // --- interface ---
    case 'palette.open': return openPalette();
    case 'sidebar.toggle': return toggleSidebar();
    case 'tabs.orientation': return toggleOrientation();
    case 'split.toggle': return toggleSplit();
    case 'reader.toggle': return invoke('reader.toggle', {});
    case 'pip.toggle': return invoke('media.pictureInPicture', {});
    case 'find.open': {
      state.find = { active: true };
      return renderFindBar();
    }
    case 'zoom.in': return zoom(0.5);
    case 'zoom.out': return zoom(-0.5);
    case 'zoom.reset': return invoke('tabs.zoom', { id: tab?.id, level: 0 });

    // --- modes (spec §2) ---
    case 'mode.switch': return modeSwitcher.open();
    case 'mode.next': return modeSwitcher.cycle(1);
    case 'mode.previous': return modeSwitcher.cycle(-1);
    case 'mode.default': case 'mode.programmer': case 'mode.gamer':
    case 'mode.creator': case 'mode.student': case 'mode.ghost':
      return modeSwitcher.activate(id.split('.')[1]);

    // --- mode features ---
    case 'turbo.toggle':
      return invoke('perf.turbo', { on: !state.perf?.turbo?.on })
        .then((s) => toast(s.on
          ? `Turbo on — ${s.suspendedTabs} tab(s) suspended`
          : 'Turbo off', 'success'));
    case 'recorder.clip':
      return invoke('recorder.clip', {})
        .then((c) => toast(`Clipped the last ${c.seconds}s`, 'success'))
        .catch((err) => toast(err.message, 'error'));
    case 'overlay.toggle': return invoke('overlay.toggle', {});
    case 'student.cite':
      return invoke('student.capture', {})
        .then((s) => toast(`Captured "${s.title}"`, 'success'))
        .catch((err) => toast(err.message, 'error'));
    case 'student.timer':
      return state.student?.timer?.running
        ? invoke('student.stopTimer', {})
        : invoke('student.startTimer', {});
    case 'creator.focusCanvas': {
      const next = !state.creator?.focusCanvas?.active;
      document.documentElement.dataset.focusCanvas = String(next);
      return invoke('creator.setFocusCanvas', { active: next });
    }
    case 'ghost.panic': return invoke('ghost.panic', { scope: 'window' }).catch(() => {});

    // --- panels ---
    case 'panel.ai': return panel.open('ai');
    case 'panel.notes': return panel.open('notes');
    case 'panel.http':
    case 'panel.ws':
    case 'panel.servers': return panel.open('dev');

    // --- developer ---
    case 'devtools.toggle':
    case 'devtools.console': return invoke('devtools.toggle', {});
    case 'responsive.toggle': return toggleResponsive();
    case 'colorpicker.open': return startColorPicker();
    case 'source.view': return invoke('tabs.create', { url: `view-source:${tab?.url}` });

    // --- capture & data ---
    case 'capture.region': return startCapture('region');
    case 'capture.fullPage': {
      const shot = await invoke('capture.fullPage', {});
      return openAnnotator(shot);
    }
    case 'notes.generate': {
      await invoke('notes.generate', {});
      panel.open('notes');
      return toast('Notes created', 'success');
    }
    case 'bookmark.add':
      await invoke('bookmarks.add', {});
      return toast('Bookmarked', 'success');
    case 'history.open': return invoke('tabs.create', { url: 'shaurya://settings/#history' });
    case 'downloads.open': return invoke('tabs.create', { url: 'shaurya://settings/#downloads' });
    case 'settings.open': return invoke('tabs.create', { url: 'shaurya://settings' });
    case 'session.save': {
      const name = prompt('Name this session');
      if (!name) return null;
      await invoke('sessions.save', { name });
      return toast(`Saved session “${name}”`, 'success');
    }
    case 'vault.lock':
      await invoke('vault.lock', {});
      return toast('Vault locked');

    default:
      return null;
  }
}

function cycleTab(delta) {
  const { tabs, activeId } = state.tabs;
  if (!tabs.length) return null;
  const index = tabs.findIndex((t) => t.id === activeId);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  return invoke('tabs.activate', { id: next.id });
}

function zoom(delta) {
  const tab = selectors.activeTab();
  if (!tab) return null;
  return invoke('tabs.zoom', { id: tab.id, level: (tab.zoom || 0) + delta });
}

function toggleSidebar() {
  const collapsed = shell.dataset.sidebar === 'collapsed';
  return invoke('layout.setSidebarWidth', {
    collapsed: !collapsed,
    width: collapsed ? (state.settings.appearance?.sidebarWidth || 248) : undefined,
  });
}

function toggleOrientation() {
  const next = state.layout?.tabOrientation === 'vertical' ? 'horizontal' : 'vertical';
  return invoke('layout.setTabOrientation', { orientation: next });
}

async function toggleSplit() {
  if (state.layout?.split) return invoke('layout.unsplit', {});

  // Split with the next tab along, which is what the user almost always
  // means; the tab context menu offers an explicit pick.
  const { tabs, activeId } = state.tabs;
  const index = tabs.findIndex((t) => t.id === activeId);
  const partner = tabs[index + 1] || tabs[index - 1];
  if (!partner) return toast('Open a second tab to split the view');
  return invoke('layout.splitWith', { tabId: partner.id });
}

async function toggleResponsive() {
  if (state.layout?.responsive) {
    return invoke('layout.setResponsiveMode', { deviceId: null });
  }
  return invoke('layout.setResponsiveMode', { deviceId: 'iphone-15' });
}

async function startColorPicker() {
  toast('Click anywhere on the page to sample a colour');
  window.dispatchEvent(new CustomEvent('shaurya:colorpicker'));
}

function startCapture(mode) {
  window.dispatchEvent(new CustomEvent('shaurya:capture-start', { detail: { mode } }));
}

function openAnnotator(shot) {
  window.dispatchEvent(new CustomEvent('shaurya:annotate', { detail: shot }));
}

function openPalette() {
  // The palette lives in the overlay view so it can cover page content.
  send('ui.contextMenu', { kind: 'palette' });
  window.dispatchEvent(new CustomEvent('shaurya:open-palette'));
}

// ---------------------------------------------------------------------------
// Event bridges
// ---------------------------------------------------------------------------

function wireEventBridges() {
  window.addEventListener('shaurya:panel', (event) => panel.open(event.detail.kind));

  window.addEventListener('shaurya:popover', (event) => {
    renderPopover(event.detail.kind, event.detail.anchor);
  });

  window.addEventListener('shaurya:tabmenu', (event) => {
    renderTabMenu(event.detail);
  });

  on('permissions:prompt', () => renderPermissionPrompt());
  on('reader:state', () => toolbar.render());
}

// ---------------------------------------------------------------------------
// Popovers
// ---------------------------------------------------------------------------

function closePopovers() {
  for (const el of document.querySelectorAll('.popover')) el.remove();
}

function popoverAt(anchor, children) {
  closePopovers();
  const rect = anchor.getBoundingClientRect();
  const popover = h('div.popover', {
    style: { top: `${rect.bottom + 6}px`, right: `${window.innerWidth - rect.right}px` },
  }, ...children);
  document.body.appendChild(popover);

  // Close on the next click anywhere else.
  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);

  return popover;
}

async function renderPopover(kind, anchor) {
  if (kind === 'shield') return renderShieldPopover(anchor);
  if (kind === 'site') return renderSitePopover(anchor);
  if (kind === 'vpn') return renderVpnPopover(anchor);
  if (kind === 'downloads') return renderDownloadsPopover(anchor);
  if (kind === 'menu') return renderMainMenu(anchor);
  return null;
}

async function renderShieldPopover(anchor) {
  const stats = await invoke('adblock.stats', {}, { quiet: true }).catch(() => null);
  const tab = selectors.activeTab();
  const host = hostOf(tab?.url);
  const setting = await invoke('adblock.siteSetting', { host }, { quiet: true }).catch(() => 'on');

  popoverAt(anchor, [
    h('div.popover-head', { text: 'Tracker blocking' }),
    h('div.stat-row', {}, h('span', { text: 'Blocked on this page' }),
      h('span.value', { text: String(stats?.count ?? 0) })),
    h('div.stat-row', {}, h('span', { text: 'Blocked all time' }),
      h('span.value', { text: (stats?.lifetime ?? 0).toLocaleString() })),
    h('div.divider'),
    h('button.menu-item', {
      onclick: async () => {
        await invoke('adblock.setSiteSetting', { host, enabled: setting !== 'on' });
        closePopovers();
      },
    }, icon('shield'),
       h('span', { text: setting === 'on' ? `Turn off for ${host}` : `Turn on for ${host}` })),
    stats?.topHosts?.length && h('div.divider'),
    ...(stats?.topHosts || []).slice(0, 6).map((entry) =>
      h('div.stat-row', {}, h('span.truncate', { text: entry.host }),
        h('span.value', { text: String(entry.count) }))),
  ].filter(Boolean));
}

async function renderSitePopover(anchor) {
  const info = await invoke('privacy.siteInfo', {}, { quiet: true }).catch(() => null);
  if (!info) return;

  popoverAt(anchor, [
    h('div.popover-head', { text: info.host || 'This page' }),
    h('div.stat-row', {}, h('span', { text: 'Connection' }),
      h('span.value', { text: info.secure ? 'Encrypted' : 'Not encrypted' })),
    h('div.stat-row', {}, h('span', { text: 'Fingerprint resistance' }),
      h('span.value', { text: info.fingerprintResistance ? 'On' : 'Off' })),
    h('div.stat-row', {}, h('span', { text: 'Global Privacy Control' }),
      h('span.value', { text: info.gpc ? 'Sent' : 'Off' })),
    h('div.divider'),
    h('div.popover-head', { text: 'Permissions' }),
    ...(info.permissions?.permissions || []).filter((p) => p.state !== 'ask').map((p) =>
      h('div.stat-row', {}, h('span', { text: p.label }),
        h('span.value', { text: p.state }))),
    h('div.divider'),
    h('button.menu-item.is-danger', {
      onclick: async () => { await invoke('privacy.clearSiteData', {}); closePopovers(); },
    }, icon('trash'), h('span', { text: 'Clear data for this site' })),
  ]);
}

async function renderVpnPopover(anchor) {
  const status = state.vpn || await invoke('vpn.status', {}, { quiet: true });
  const regions = await invoke('vpn.regions', {}, { quiet: true }).catch(() => []);

  popoverAt(anchor, [
    h('div.popover-head', { text: 'Shaurya VPN' }),
    h('div.stat-row', {}, h('span', { text: 'Status' }),
      h('span.value', { text: status?.status || 'disconnected' })),
    status?.scope && h('div.stat-row', {}, h('span', { text: 'Protects' }),
      h('span.value', { text: status.scope })),
    status?.usage && h('div.stat-row', {}, h('span', { text: 'Used this month' }),
      h('span.value', {
        text: status.usage.limit
          ? `${fmtGb(status.usage.used)} / ${fmtGb(status.usage.limit)}`
          : fmtGb(status.usage.used),
      })),
    h('div.divider'),
    h('button.menu-item', {
      onclick: async () => {
        closePopovers();
        if (status?.status === 'connected') await invoke('vpn.disconnect', {});
        else await invoke('vpn.connect', {});
      },
    }, icon('vpn'),
       h('span', { text: status?.status === 'connected' ? 'Disconnect' : 'Connect' })),
    h('div.divider'),
    h('div.popover-head', { text: 'Region' }),
    ...regions.slice(0, 8).map((region) =>
      h('button.menu-item', {
        disabled: region.locked,
        onclick: async () => { closePopovers(); await invoke('vpn.connect', { region: region.id }); },
      }, icon('globe'), h('span', { text: region.name }),
         region.locked && h('span.accel', { text: 'Pro' }))),
  ].filter(Boolean));
}

async function renderDownloadsPopover(anchor) {
  const downloads = await invoke('downloads.list', {}, { quiet: true }).catch(() => []);
  popoverAt(anchor, [
    h('div.popover-head', { text: 'Downloads' }),
    downloads.length
      ? h('div', {}, ...downloads.slice(0, 8).map((item) =>
        h('button.menu-item', {
          onclick: () => invoke('downloads.reveal', { id: item.id }),
        }, icon('download'),
           h('div', { style: { minWidth: 0, flex: 1 } },
             h('div.truncate', { text: item.filename }),
             h('div.dimmer', {
               text: item.state === 'progressing'
                 ? `${Math.round((item.receivedBytes / (item.totalBytes || 1)) * 100)}%`
                 : item.state,
             })))))
      : h('div.empty', {}, 'No downloads yet'),
  ]);
}

function renderMainMenu(anchor) {
  const items = [
    ['New tab', 'plus', 'tab.new'],
    ['New window', 'globe', 'window.new'],
    ['New private window', 'eyeOff', 'window.incognito'],
    null,
    ['Command palette', 'command', 'palette.open'],
    ['Find in page', 'search', 'find.open'],
    ['Capture full page', 'camera', 'capture.fullPage'],
    ['Reader mode', 'book', 'reader.toggle'],
    ['Picture-in-picture', 'pip', 'pip.toggle'],
    null,
    ['Split screen', 'split', 'split.toggle'],
    ['Vertical / horizontal tabs', 'sidebar', 'tabs.orientation'],
    ['Save session', 'layers', 'session.save'],
    null,
    ['Developer tools', 'code', 'devtools.toggle'],
    ['Responsive mode', 'device', 'responsive.toggle'],
    ['Colour picker', 'palette', 'colorpicker.open'],
    null,
    ['History', 'clock', 'history.open'],
    ['Downloads', 'download', 'downloads.open'],
    ['Settings', 'sliders', 'settings.open'],
  ];

  popoverAt(anchor, items.map((item) => {
    if (!item) return h('div.divider');
    const [label, iconName, command] = item;
    const accelerator = selectors.shortcutFor(command);
    return h('button.menu-item', {
      onclick: () => { closePopovers(); runCommand(command); },
    }, icon(iconName), h('span', { text: label }),
       accelerator && h('span.accel', { text: prettyAccelerator(accelerator) }));
  }));
}

function renderTabMenu({ tabId, x, y }) {
  closePopovers();
  const tab = state.tabs.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const popover = h('div.popover', { style: { top: `${y}px`, left: `${x}px`, right: 'auto' } },
    menuItem('Duplicate', 'copy', () => invoke('tabs.duplicate', { id: tabId })),
    menuItem(tab.pinned ? 'Unpin' : 'Pin', 'pin',
      () => invoke('tabs.pin', { id: tabId, pinned: !tab.pinned })),
    menuItem(tab.muted ? 'Unmute' : 'Mute', tab.muted ? 'volume' : 'mute',
      () => invoke('tabs.mute', { id: tabId, muted: !tab.muted })),
    menuItem('Suspend', 'sleep', () => invoke('tabs.hibernate', { id: tabId })),
    h('div.divider'),
    menuItem('Split with this tab', 'split', () => invoke('layout.splitWith', { tabId })),
    menuItem('Add to new group', 'layers',
      () => invoke('groups.create', { name: 'New Group', tabIds: [tabId] })),
    h('div.divider'),
    menuItem('Close', 'close', () => invoke('tabs.close', { id: tabId }), true));

  document.body.appendChild(popover);
  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

function menuItem(label, iconName, onclick, danger = false) {
  return h('button.menu-item', {
    class: { 'is-danger': danger },
    onclick: () => { closePopovers(); onclick(); },
  }, icon(iconName), h('span', { text: label }));
}

async function openWorkspaceMenu(anchor) {
  const workspaces = await invoke('workspaces.list', {}, { quiet: true }).catch(() => []);
  popoverAt(anchor, [
    h('div.popover-head', { text: 'Workspaces' }),
    h('button.menu-item', {
      onclick: () => { closePopovers(); invoke('workspaces.switch', { id: null }); },
    }, icon('layers'), h('span', { text: 'All tabs' })),
    ...workspaces.map((workspace) =>
      h('button.menu-item', {
        onclick: () => { closePopovers(); invoke('workspaces.switch', { id: workspace.id }); },
      }, icon('layers'), h('span', { text: workspace.name }),
         h('span.accel', { text: String(workspace.tabCount) }))),
    h('div.divider'),
    h('button.menu-item', {
      onclick: async () => {
        closePopovers();
        const name = prompt('Workspace name');
        if (name) await invoke('workspaces.create', { name });
      },
    }, icon('plus'), h('span', { text: 'New workspace' })),
  ]);
}

/** A permission request, surfaced in the address bar (spec §3). */
async function renderPermissionPrompt() {
  const pending = state.permissions.pending;
  const request = pending[pending.length - 1];
  if (!request) return;

  closePopovers();
  const anchor = $('.omnibox');
  const popover = popoverAt(anchor, [
    h('div.popover-head', { text: 'Permission request' }),
    h('div', { style: { padding: '4px 10px 10px' } },
      h('strong', { text: request.origin }),
      h('p', { style: { margin: '6px 0 0' },
        text: `wants to use ${request.label.toLowerCase()}` }),
      request.highRisk && h('p.dimmer', { style: { marginTop: '6px' },
        text: 'This grants access to your device. Only allow sites you trust.' })),
    h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 6px' } },
      h('button.btn', {
        style: { flex: 1 },
        onclick: () => respond('deny'),
      }, 'Block'),
      h('button.btn.btn-primary', {
        style: { flex: 1 },
        onclick: () => respond('allow'),
      }, 'Allow')),
  ]);

  async function respond(decision) {
    popover.remove();
    state.permissions.pending = pending.filter((p) => p.id !== request.id);
    await invoke('permissions.respond', { id: request.id, decision, remember: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function fmtGb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
