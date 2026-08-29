'use strict';
/**
 * A browser tab.
 *
 * Each tab owns a `WebContentsView` — a real Chromium renderer in its own
 * process, sandboxed, with `contextIsolation` on. The chrome UI never gets a
 * handle to page contents directly; everything crosses through the main
 * process, which is what keeps a compromised renderer from reaching the
 * password vault or the AI panel's credentials.
 *
 * A hibernated tab keeps this object and its metadata but destroys the
 * WebContentsView, releasing the renderer process entirely (spec §2).
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const { WebContentsView } = require('electron');
const { uid } = require('../util/id');
const paths = require('../util/paths');
const { createLogger } = require('../util/logger');

const log = createLogger('tab');

/** Pages we render ourselves, served from `shaurya://`. */
const INTERNAL_PREFIX = 'shaurya://';

class Tab extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Electron.Session} opts.session  the profile session to load in
   * @param {string} opts.profileId
   * @param {string} [opts.url]
   * @param {string} [opts.id]               reused when restoring a session
   */
  constructor({ session, profileId, url = 'shaurya://start', id, groupId = null, pinned = false }) {
    super();
    this.id = id || uid('t_');
    this.session = session;
    this.profileId = profileId;

    // Metadata survives hibernation; `view` does not.
    this.url = url;
    this.pendingUrl = url;
    this.title = 'New Tab';
    this.favicon = null;
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.audible = false;
    this.muted = false;
    this.pinned = pinned;
    this.groupId = groupId;
    this.zoom = 0;
    this.hibernated = false;
    this.thumbnail = null;
    this.lastActive = Date.now();
    this.createdAt = Date.now();
    this.readerMode = false;
    this.error = null;
    /** Navigation history kept for a hibernated tab's back/forward. */
    this.historyEntries = [];
    this.historyIndex = -1;

    this.view = null;
    this._createView();
  }

  // ---- renderer lifecycle ---------------------------------------------

  _createView() {
    this.view = new WebContentsView({
      webPreferences: {
        session: this.session,
        // Hard isolation. None of these are relaxed for any feature in the
        // spec — the AI layer and dev tools all work through IPC instead.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: true,
        // The content preload provides reader extraction, cosmetic
        // filtering, gestures, autofill and the colour picker. It runs in an
        // isolated world and talks only to the main process.
        preload: paths.appPath('src', 'preload', 'content.js'),
      },
    });
    this.view.setBackgroundColor('#ffffff');
    this._wireEvents();
  }

  get webContents() {
    return this.view ? this.view.webContents : null;
  }

  _wireEvents() {
    const wc = this.webContents;
    if (!wc) return;

    const push = (extra = {}) => this.emit('updated', this.toJSON(), extra);

    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      push({ reason: 'title' });
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons && favicons.length ? favicons[0] : null;
      push({ reason: 'favicon' });
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.error = null;
      push({ reason: 'loading' });
    });

    wc.on('did-stop-loading', () => {
      this.loading = false;
      this._syncNavState();
      push({ reason: 'loading' });
    });

    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return;
      this.pendingUrl = event.url;
      this.emit('navigation', { tabId: this.id, url: event.url, phase: 'start' });
    });

    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.readerMode = false;
      this._syncNavState();
      this.emit('navigation', { tabId: this.id, url, phase: 'commit' });
      push({ reason: 'navigate' });
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this._syncNavState();
      push({ reason: 'navigate' });
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires for ordinary user-cancelled loads.
      if (!isMainFrame || errorCode === -3) return;
      this.loading = false;
      this.error = { code: errorCode, description: errorDescription, url: validatedURL };
      this.emit('load-failed', { tabId: this.id, ...this.error });
      push({ reason: 'error' });
    });

    wc.on('audio-state-changed', (event) => {
      this.audible = event.audible;
      push({ reason: 'audio' });
    });

    wc.on('render-process-gone', (_e, details) => {
      log.warn(`renderer for ${this.id} gone: ${details.reason}`);
      this.loading = false;
      this.error = { code: -1, description: `Renderer ${details.reason}`, url: this.url };
      this.emit('crashed', { tabId: this.id, reason: details.reason });
      push({ reason: 'crashed' });
    });

    wc.on('found-in-page', (_e, result) => {
      this.emit('find-result', { tabId: this.id, ...result });
    });

    wc.on('media-started-playing', () => {
      this.audible = wc.isCurrentlyAudible();
      push({ reason: 'audio' });
    });

    wc.on('context-menu', (_e, params) => {
      this.emit('context-menu', { tabId: this.id, params });
    });

    // A page asking to open a window becomes a tab, which is what users
    // expect; genuine popups (small, named, feature-string) stay popups.
    wc.setWindowOpenHandler((details) => {
      this.emit('open-window', { tabId: this.id, details });
      return { action: 'deny' };
    });
  }

  _syncNavState() {
    const wc = this.webContents;
    if (!wc) return;
    this.canGoBack = wc.navigationHistory.canGoBack();
    this.canGoForward = wc.navigationHistory.canGoForward();
    // Snapshot history so a hibernated tab can still show back/forward.
    try {
      this.historyEntries = wc.navigationHistory.getAllEntries().map((e) => ({
        url: e.url, title: e.title,
      }));
      this.historyIndex = wc.navigationHistory.getActiveIndex();
    } catch { /* history API unavailable during teardown */ }
  }

  // ---- navigation ------------------------------------------------------

  async navigate(url) {
    if (this.hibernated) await this.wake({ load: false });
    this.pendingUrl = url;
    this.error = null;
    try {
      await this.webContents.loadURL(url);
    } catch (err) {
      // loadURL rejects on aborted/failed navigations; did-fail-load has
      // already recorded the useful detail, so this is not re-thrown.
      log.debug(`navigate(${url}) rejected: ${err.message}`);
    }
  }

  goBack() {
    if (this.webContents?.navigationHistory.canGoBack()) this.webContents.navigationHistory.goBack();
  }

  goForward() {
    if (this.webContents?.navigationHistory.canGoForward()) this.webContents.navigationHistory.goForward();
  }

  reload({ ignoreCache = false } = {}) {
    if (this.hibernated) return this.wake();
    if (ignoreCache) this.webContents?.reloadIgnoringCache();
    else this.webContents?.reload();
  }

  stop() {
    this.webContents?.stop();
  }

  setZoom(level) {
    this.zoom = level;
    if (this.webContents) this.webContents.setZoomLevel(level);
  }

  setMuted(muted) {
    this.muted = muted;
    this.webContents?.setAudioMuted(muted);
    this.emit('updated', this.toJSON(), { reason: 'audio' });
  }

  // ---- hibernation -----------------------------------------------------

  /**
   * Is this tab eligible to be suspended right now?
   * @param {{excludeAudible:boolean, excludePinned:boolean, idleMs:number}} policy
   */
  canHibernate(policy) {
    if (this.hibernated || !this.view) return false;
    if (policy.excludePinned && this.pinned) return false;
    if (policy.excludeAudible && this.audible) return false;
    if (this.loading) return false;
    if (this.url.startsWith(INTERNAL_PREFIX)) return false;
    // A page holding a live capture or download should not be torn down.
    if (this.webContents?.isCurrentlyAudible()) return false;
    // Background play protects more than `audible` does: a paused podcast is
    // silent right now, but suspending it loses the playback position, which
    // is the one thing the listener cared about.
    if (policy.isProtected?.(this.id)) return false;
    return Date.now() - this.lastActive > policy.idleMs;
  }

  /**
   * Suspend: capture a thumbnail for the tab strip, snapshot navigation
   * state, then destroy the renderer. Memory returns to the OS because the
   * whole child process exits.
   */
  async hibernate() {
    if (this.hibernated || !this.view) return false;
    try {
      const image = await this.webContents.capturePage();
      if (!image.isEmpty()) {
        this.thumbnail = image.resize({ width: 320 }).toDataURL();
      }
    } catch (err) {
      log.debug(`thumbnail capture failed for ${this.id}: ${err.message}`);
    }
    this._syncNavState();
    this.url = this.webContents.getURL() || this.url;
    this.title = this.webContents.getTitle() || this.title;

    this.emit('detach-view', this);
    this.view.webContents.close();
    this.view = null;
    this.hibernated = true;
    this.emit('updated', this.toJSON(), { reason: 'hibernated' });
    log.info(`hibernated ${this.id} (${this.title})`);
    return true;
  }

  /** Recreate the renderer and restore the page. */
  async wake({ load = true } = {}) {
    if (!this.hibernated) return false;
    this._createView();
    this.hibernated = false;
    this.lastActive = Date.now();
    this.emit('attach-view', this);
    if (load) await this.navigate(this.url);
    this.emit('updated', this.toJSON(), { reason: 'woken' });
    log.info(`woke ${this.id} (${this.title})`);
    return true;
  }

  // ---- teardown --------------------------------------------------------

  destroy() {
    if (this.view) {
      this.emit('detach-view', this);
      try {
        this.view.webContents.close();
      } catch (err) {
        log.debug(`close failed for ${this.id}: ${err.message}`);
      }
      this.view = null;
    }
    this.removeAllListeners();
  }

  // ---- serialisation ---------------------------------------------------

  /** The shape the chrome renderer consumes. Must stay JSON-cloneable. */
  toJSON() {
    return {
      id: this.id,
      url: this.url,
      pendingUrl: this.pendingUrl,
      title: this.title,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      audible: this.audible,
      muted: this.muted,
      pinned: this.pinned,
      groupId: this.groupId,
      zoom: this.zoom,
      hibernated: this.hibernated,
      thumbnail: this.thumbnail,
      readerMode: this.readerMode,
      profileId: this.profileId,
      lastActive: this.lastActive,
      error: this.error,
    };
  }

  /** The subset persisted in a saved session. */
  toSessionJSON() {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      pinned: this.pinned,
      groupId: this.groupId,
      zoom: this.zoom,
      profileId: this.profileId,
    };
  }
}

module.exports = { Tab, INTERNAL_PREFIX };
