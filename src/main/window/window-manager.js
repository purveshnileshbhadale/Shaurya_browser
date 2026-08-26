'use strict';
/**
 * Owns the set of open windows and routes "the current window" for IPC.
 *
 * Every privileged IPC call arrives with a sender WebContents; we map that
 * back to the window it belongs to rather than tracking a global "active
 * window", which goes wrong the moment a background window fires a timer.
 */
const EventEmitter = require('node:events');
const { AetherWindow } = require('./browser-window');
const { createLogger } = require('../util/logger');

const log = createLogger('windows');

class WindowManager extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    /** @type {Map<string, AetherWindow>} */
    this.windows = new Map();
    this.lastFocusedId = null;
  }

  count() {
    return this.windows.size;
  }

  list() {
    return [...this.windows.values()];
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.incognito]
   * @param {string} [opts.url]
   * @param {object} [opts.session]  restore payload
   */
  create(opts = {}) {
    let incognitoProfileId = null;
    if (opts.incognito) {
      // Each private window gets its own isolated context, so two of them
      // never share cookies or storage (spec §3).
      incognitoProfileId = this.deps.profiles.createIncognito().id;
    }

    const win = new AetherWindow(this.deps, { ...opts, incognitoProfileId });
    this.windows.set(win.id, win);

    win.on('focus', () => { this.lastFocusedId = win.id; });
    win.on('closed', async () => {
      this.windows.delete(win.id);
      if (incognitoProfileId) {
        await this.deps.profiles.destroyIncognito(incognitoProfileId);
      }
      this.emit('closed', win.id);
      if (this.windows.size === 0) this.emit('all-closed');
    });
    win.on('popup-requested', (details) => {
      const popup = this.create({ url: details.url, incognito: opts.incognito });
      popup.show();
    });
    win.on('navigation', (info) => this.emit('navigation', { ...info, window: win }));
    win.on('load-failed', (info) => this.emit('load-failed', { ...info, window: win }));
    win.on('context-menu', (info) => this.emit('context-menu', info));

    win.once('shell-ready', () => win.show());
    this.lastFocusedId = win.id;
    log.info(`window ${win.id} created${opts.incognito ? ' (private)' : ''}`);
    this.emit('created', win);
    return win;
  }

  get(id) {
    return this.windows.get(id) || null;
  }

  /** Which window does this IPC sender belong to? */
  fromWebContents(webContents) {
    if (!webContents) return this.focused();
    for (const win of this.windows.values()) {
      if (win.shellView?.webContents.id === webContents.id) return win;
      if (win.overlayView?.webContents.id === webContents.id) return win;
      for (const tab of win.tabs.tabs.values()) {
        if (tab.webContents?.id === webContents.id) return win;
      }
    }
    return this.focused();
  }

  focused() {
    const last = this.lastFocusedId ? this.windows.get(this.lastFocusedId) : null;
    if (last) return last;
    return this.windows.values().next().value || null;
  }

  /** Find the window and tab that own a WebContents id. */
  locateTab(webContentsId) {
    for (const win of this.windows.values()) {
      for (const tab of win.tabs.tabs.values()) {
        if (tab.webContents?.id === webContentsId) return { window: win, tab };
      }
    }
    return null;
  }

  /**
   * Find the window and tab that own a *tab* id.
   *
   * Distinct from `locateTab`, which takes a WebContents id: a hibernated tab
   * has no WebContents at all but still has an id, and the performance and
   * cap services need to find it.
   */
  locateTabById(tabId) {
    for (const win of this.windows.values()) {
      const tab = win.tabs.get(tabId);
      if (tab) return { window: win, tab };
    }
    return null;
  }

  /** Broadcast an event to every window's chrome. */
  broadcast(channel, payload) {
    for (const win of this.windows.values()) win.send(channel, payload);
  }

  closeAll() {
    for (const win of [...this.windows.values()]) win.close();
  }

  toSessionJSON() {
    return this.list()
      .filter((w) => !w.incognito) // private windows are never persisted
      .map((w) => w.toSessionJSON());
  }
}

module.exports = { WindowManager };
