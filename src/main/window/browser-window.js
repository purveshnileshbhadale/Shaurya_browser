'use strict';
/**
 * AetherWindow — one browser window.
 *
 * Built on `BaseWindow` rather than `BrowserWindow` so that the chrome and
 * every page are siblings in one view tree. The z-order is deliberate:
 *
 *   index 0  shellView    the browser chrome (sidebar, toolbar) — full window
 *   index 1+ page views   the live tabs, positioned in the content rect
 *   top      overlayView  transparent, attached only while a palette,
 *                         menu or dialog is open
 *
 * Keeping the overlay detached when idle matters: an always-present
 * full-window view on top would swallow every click meant for the page.
 */
const path = require('node:path');
const EventEmitter = require('node:events');
const { BaseWindow, WebContentsView, nativeTheme, screen } = require('electron');
const { TabManager } = require('./tab-manager');
const layoutEngine = require('./layout');
const paths = require('../util/paths');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('window');

/** Native window-control strategy per platform (spec §2). */
function titleBarOptions(accentBg, symbolColor) {
  if (process.platform === 'darwin') {
    // Real traffic lights, inset to line up with the sidebar's first row.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } };
  }
  if (process.platform === 'win32') {
    // Native minimise/maximise/close drawn by the OS over our chrome, so
    // Snap Layouts and the system context menu keep working.
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: accentBg, symbolColor, height: 44 },
    };
  }
  // Linux: no overlay API, so the chrome draws its own controls.
  return { frame: false };
}

class AetherWindow extends EventEmitter {
  /**
   * @param {object} deps  the service container from bootstrap.js
   * @param {object} opts
   */
  constructor(deps, opts = {}) {
    super();
    this.id = uid('win_');
    this.deps = deps;
    this.incognito = Boolean(opts.incognito);
    this.incognitoProfileId = opts.incognitoProfileId || null;
    this.appMode = opts.appMode || null; // set for installed PWA windows

    const { settings } = deps;
    this.layout = layoutEngine.createLayoutState({
      tabOrientation: settings.get('appearance.tabOrientation'),
      sidebarWidth: settings.get('appearance.sidebarWidth'),
      density: settings.get('appearance.density'),
    });

    this._createWindow(opts);
    this._createShell();
    this._createTabs(opts);
    this._wireWindowEvents();
  }

  // ---- construction ----------------------------------------------------

  _createWindow(opts) {
    const isDark = nativeTheme.shouldUseDarkColors;
    const bg = this.incognito ? '#1B1230' : isDark ? '#14161A' : '#F6F7F9';
    const symbol = isDark || this.incognito ? '#E8EAED' : '#202124';

    const bounds = opts.bounds || this._defaultBounds();

    this.win = new BaseWindow({
      ...bounds,
      minWidth: 480,
      minHeight: 360,
      backgroundColor: bg,
      show: false,
      title: this.incognito ? 'Aether — Private' : 'Aether',
      ...titleBarOptions(bg, symbol),
      ...(this.appMode ? { frame: true, titleBarStyle: 'default' } : {}),
    });
  }

  _defaultBounds() {
    // Cascade new windows so they do not land exactly on top of each other.
    const display = screen.getPrimaryDisplay().workArea;
    const n = this.deps.windowManager ? this.deps.windowManager.count() : 0;
    const offset = (n % 6) * 28;
    const width = Math.min(1440, display.width - 80);
    const height = Math.min(920, display.height - 80);
    return {
      x: display.x + 40 + offset,
      y: display.y + 40 + offset,
      width,
      height,
    };
  }

  /** The chrome renderer: privileged, but loads only our own local files. */
  _createShell() {
    this.shellView = new WebContentsView({
      webPreferences: {
        preload: paths.appPath('src', 'preload', 'chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // the preload needs to reach ipcRenderer
        webviewTag: false,
      },
    });
    this.shellView.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.shellView);
    this.deps.ipc.trust(this.shellView.webContents);

    this.shellView.webContents.loadFile(paths.appPath('src', 'ui', 'index.html'), {
      query: {
        windowId: this.id,
        incognito: String(this.incognito),
        platform: process.platform,
        appMode: this.appMode || '',
      },
    });

    this.shellView.webContents.on('did-finish-load', () => {
      this.applyLayout();
      this.emit('shell-ready');
    });

    // Links clicked in the chrome (help articles, etc.) become tabs.
    this.shellView.webContents.setWindowOpenHandler(({ url }) => {
      this.tabs.create({ url });
      return { action: 'deny' };
    });
  }

  _createTabs(opts) {
    this.tabs = new TabManager({
      profiles: this.deps.profiles,
      settings: this.deps.settings,
      features: this.deps.features,
    });

    // Page views attach and detach as tabs are created, hibernated and woken.
    this.tabs.on('attach-view', (tab) => this._attachTabView(tab));
    this.tabs.on('detach-view', (tab) => this._detachTabView(tab));
    // Page views are attached but never IPC-trusted: a compromised web
    // renderer must not be able to reach privileged channels (ipc/router.js).
    this.tabs.on('created', (tab) => this._attachTabView(tab));
    this.tabs.on('activated', () => this.applyLayout());
    this.tabs.on('changed', (snap) => {
      this.send('tabs:changed', snap);
      this.applyLayout();
    });
    this.tabs.on('tab-updated', (json, extra) => this.send('tabs:title', { tab: json, ...extra }));
    this.tabs.on('groups-changed', (groups) => this.send('groups:changed', groups));
    this.tabs.on('workspaces-changed', (ws) => this.send('workspaces:changed', ws));
    this.tabs.on('navigation', (info) => {
      if (info.phase === 'commit') this._syncTabTrust(info.tabId, info.url);
      this.send('tabs:navigation', info);
      this.emit('navigation', info);
    });
    this.tabs.on('find-result', (r) => this.send('tabs:find', r));
    this.tabs.on('load-failed', (info) => this.emit('load-failed', info));
    this.tabs.on('crashed', (info) => this.emit('tab-crashed', info));
    this.tabs.on('popup-requested', (details) => this.emit('popup-requested', details));
    this.tabs.on('context-menu', (info) => this.emit('context-menu', { ...info, window: this }));

    const profileId = this.incognito ? this.incognitoProfileId : undefined;
    if (opts.session) {
      this.tabs.restore(opts.session);
    } else {
      this.tabs.create({ url: opts.url || 'aether://start', profileId });
    }
  }

  /**
   * Internal `aether://` pages need the privileged IPC surface; web pages
   * must never have it. Trust is re-evaluated on every main-frame commit, so
   * a tab that navigates from `aether://settings` to a website loses it in
   * the same instant the new document commits.
   */
  _syncTabTrust(tabId, url) {
    const tab = this.tabs.get(tabId);
    if (!tab?.webContents) return;
    this.deps.ipc.setTrusted(tab.webContents, String(url).startsWith('aether://'));
  }

  _wireWindowEvents() {
    this.win.on('resize', () => this.applyLayout());
    this.win.on('enter-full-screen', () => this.applyLayout());
    this.win.on('leave-full-screen', () => this.applyLayout());
    this.win.on('maximize', () => { this.applyLayout(); this.send('window:state', this.state()); });
    this.win.on('unmaximize', () => { this.applyLayout(); this.send('window:state', this.state()); });
    this.win.on('focus', () => this.emit('focus', this));
    this.win.on('closed', () => {
      this.tabs.dispose();
      this.emit('closed', this);
      this.removeAllListeners();
    });
  }

  // ---- view plumbing ---------------------------------------------------

  _attachTabView(tab) {
    if (!tab.view) return;
    const children = this.win.contentView.children;
    if (children.includes(tab.view)) return;
    // Insert above the shell but below any overlay.
    const overlayIdx = this.overlayView ? children.indexOf(this.overlayView) : -1;
    if (overlayIdx >= 0) this.win.contentView.addChildView(tab.view, overlayIdx);
    else this.win.contentView.addChildView(tab.view);
    // Off-screen until applyLayout() decides whether it is visible.
    tab.view.setVisible(false);
  }

  _detachTabView(tab) {
    if (!tab.view) return;
    try {
      this.win.contentView.removeChildView(tab.view);
    } catch (err) {
      log.debug(`removeChildView failed: ${err.message}`);
    }
  }

  /**
   * Position and show exactly the views the layout calls for, hiding the
   * rest. `setVisible(false)` keeps the renderer alive but off the compositor
   * — cheaper than moving views off-screen, which still costs paint work.
   */
  applyLayout() {
    if (!this.win || this.win.isDestroyed()) return;

    const { width, height } = this.win.getContentBounds();
    this.layout.width = width;
    this.layout.height = height;

    this.shellView.setBounds({ x: 0, y: 0, width, height });

    const panes = layoutEngine.paneRects(this.layout, this.tabs.activeId);
    const visibleIds = new Set();

    for (const pane of panes) {
      const tab = this.tabs.get(pane.tabId);
      if (!tab) continue;
      if (tab.hibernated) {
        // Waking is async; the pane stays empty for a frame and the chrome
        // shows the tab's thumbnail underneath in the meantime.
        tab.wake().catch((err) => log.warn(`wake failed: ${err.message}`));
        continue;
      }
      if (!tab.view) continue;
      this._attachTabView(tab);
      tab.view.setBounds(pane.bounds);
      tab.view.setVisible(true);
      visibleIds.add(tab.id);
    }

    for (const tab of this.tabs.tabs.values()) {
      if (tab.view && !visibleIds.has(tab.id)) tab.view.setVisible(false);
    }

    if (this.overlayView) {
      this.overlayView.setBounds({ x: 0, y: 0, width, height });
    }

    this.tabs.setVisibleTabs([...visibleIds]);
    this.send('layout:changed', layoutEngine.chromeMetrics(this.layout));
  }

  // ---- overlay (command palette, menus, dialogs) ----------------------

  /**
   * Show a transparent full-window overlay above the pages. Used for the
   * command palette, context menus, the screenshot region selector and the
   * colour picker, all of which must draw over page content.
   *
   * @param {string} route  an `aether://overlay/...` route for the UI
   */
  showOverlay(route, payload = {}) {
    if (!this.overlayView) {
      this.overlayView = new WebContentsView({
        webPreferences: {
          preload: paths.appPath('src', 'preload', 'chrome.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          transparent: true,
        },
      });
      this.overlayView.setBackgroundColor('#00000000');
      this.deps.ipc.trust(this.overlayView.webContents);
      this.overlayView.webContents.loadFile(
        paths.appPath('src', 'ui', 'overlay.html'),
        { query: { windowId: this.id } }
      );
    }
    const children = this.win.contentView.children;
    if (!children.includes(this.overlayView)) {
      this.win.contentView.addChildView(this.overlayView); // topmost
    }
    const { width, height } = this.win.getContentBounds();
    this.overlayView.setBounds({ x: 0, y: 0, width, height });
    this.overlayView.setVisible(true);
    this.overlayView.webContents.focus();

    const send = () => this.overlayView.webContents.send('aether:event', 'overlay:show', { route, payload });
    if (this.overlayView.webContents.isLoading()) {
      this.overlayView.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    this._overlayOpen = true;
  }

  hideOverlay() {
    if (!this.overlayView) return;
    this.overlayView.setVisible(false);
    try {
      this.win.contentView.removeChildView(this.overlayView);
    } catch { /* already detached */ }
    this._overlayOpen = false;
    // Return focus to the page so typing continues where the user expects.
    this.tabs.active?.webContents?.focus();
  }

  get overlayOpen() {
    return Boolean(this._overlayOpen);
  }

  // ---- layout mutations ------------------------------------------------

  setTabOrientation(orientation) {
    this.layout.tabOrientation = orientation === 'horizontal' ? 'horizontal' : 'vertical';
    this.deps.settings.set('appearance.tabOrientation', this.layout.tabOrientation);
    this.applyLayout();
    return this.layout.tabOrientation;
  }

  setSidebarWidth(width, { collapsed } = {}) {
    if (typeof collapsed === 'boolean') this.layout.sidebarCollapsed = collapsed;
    if (typeof width === 'number') {
      this.layout.sidebarWidth = layoutEngine.clamp(
        width, layoutEngine.METRICS.sidebarMin, layoutEngine.METRICS.sidebarMax);
      this.deps.settings.set('appearance.sidebarWidth', this.layout.sidebarWidth);
    }
    this.applyLayout();
    return { width: this.layout.sidebarWidth, collapsed: this.layout.sidebarCollapsed };
  }

  /** Put `otherTabId` beside the active tab (spec §2 split-screen). */
  splitWith(otherTabId, { ratio = 0.5 } = {}) {
    if (!this.deps.features.enabled('splitView')) {
      throw new Error('Split screen is turned off in the Feature Store');
    }
    const a = this.tabs.activeId;
    const b = otherTabId;
    if (!a || !this.tabs.get(b) || a === b) throw new Error('need two distinct tabs to split');
    this.layout.split = { tabIds: [a, b], ratio };
    this.layout.responsive = null; // the two modes are mutually exclusive
    this.applyLayout();
    return this.layout.split;
  }

  unsplit() {
    this.layout.split = null;
    this.applyLayout();
    return null;
  }

  setSplitRatio(ratio) {
    if (!this.layout.split) return null;
    this.layout.split.ratio = layoutEngine.clamp(ratio, 0.05, 0.95);
    this.applyLayout();
    return this.layout.split;
  }

  /** Open/close a side panel (AI, REST client, notes, …). */
  setPanel(kind, { width } = {}) {
    if (!kind) {
      this.layout.panel = null;
    } else {
      this.layout.panel = {
        kind,
        width: width || this.layout.panel?.width || 380,
      };
    }
    this.applyLayout();
    return this.layout.panel;
  }

  setPanelWidth(width) {
    if (!this.layout.panel) return null;
    this.layout.panel.width = layoutEngine.clamp(
      width, layoutEngine.METRICS.panelMin, layoutEngine.METRICS.panelMax);
    this.applyLayout();
    return this.layout.panel;
  }

  setResponsive(device) {
    this.layout.responsive = device || null;
    if (device) this.layout.split = null;
    this.applyLayout();
    return this.layout.responsive;
  }

  // ---- window controls -------------------------------------------------

  state() {
    return {
      id: this.id,
      maximized: this.win.isMaximized(),
      fullScreen: this.win.isFullScreen(),
      focused: this.win.isFocused(),
      incognito: this.incognito,
      appMode: this.appMode,
      platform: process.platform,
    };
  }

  show() {
    this.win.show();
    this.applyLayout();
  }

  focus() {
    this.win.focus();
  }

  close() {
    this.win.close();
  }

  /** Push an event to this window's chrome renderer (and overlay). */
  send(channel, payload) {
    if (this.shellView && !this.shellView.webContents.isDestroyed()) {
      this.shellView.webContents.send('aether:event', channel, payload);
    }
    if (this.overlayView && !this.overlayView.webContents.isDestroyed()) {
      this.overlayView.webContents.send('aether:event', channel, payload);
    }
  }

  toSessionJSON() {
    const b = this.win.getBounds();
    return {
      id: this.id,
      bounds: b,
      maximized: this.win.isMaximized(),
      incognito: this.incognito,
      layout: {
        tabOrientation: this.layout.tabOrientation,
        sidebarWidth: this.layout.sidebarWidth,
        sidebarCollapsed: this.layout.sidebarCollapsed,
        split: this.layout.split,
        panel: this.layout.panel,
      },
      tabs: this.tabs.toSessionJSON(),
    };
  }
}

module.exports = { AetherWindow };
