'use strict';
/**
 * Named window sessions (spec §5).
 *
 * "Client A debug setup" should reopen the exact tab layout it was saved
 * with — including which two tabs were split and at what ratio, which side
 * panel was open, and which profile each tab belonged to. That last part is
 * what makes this useful for contract work: restoring a session restores the
 * cookie jars too.
 */
const EventEmitter = require('node:events');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('sessions');

class SessionService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../window/window-manager').WindowManager} deps.windowManager
   */
  constructor({ settings, features, windowManager }) {
    super();
    this.settings = settings;
    this.features = features;
    this.windowManager = windowManager;
    this.store = new JsonStore(paths.sessionsFile(), {
      named: [],       // user-saved sessions
      last: null,      // auto-saved on quit, for crash/restart recovery
    });
    this._autoSaveTimer = null;
  }

  /** Periodically snapshot open windows so a crash loses at most 30s. */
  startAutoSave() {
    this._autoSaveTimer = setInterval(() => this.snapshotLast(), 30_000);
    if (this._autoSaveTimer.unref) this._autoSaveTimer.unref();
  }

  stopAutoSave() {
    if (this._autoSaveTimer) clearInterval(this._autoSaveTimer);
  }

  snapshotLast() {
    const windows = this.windowManager.toSessionJSON();
    if (!windows.length) return null;
    this.store.data.last = { savedAt: Date.now(), windows };
    this.store.save();
    return this.store.data.last;
  }

  // ---- named sessions --------------------------------------------------

  list() {
    return this.store.data.named.map((s) => ({
      id: s.id,
      name: s.name,
      savedAt: s.savedAt,
      windowCount: s.windows.length,
      tabCount: s.windows.reduce((n, w) => n + (w.tabs?.tabs?.length || 0), 0),
      hasSplit: s.windows.some((w) => Boolean(w.layout?.split)),
      profiles: [...new Set(s.windows.flatMap((w) =>
        (w.tabs?.tabs || []).map((t) => t.profileId)))],
    }));
  }

  /**
   * Save the current window layout under a name.
   * @param {{name:string, windowId?:string}} opts  omit windowId to save all
   */
  save({ name, windowId } = {}) {
    if (!this.features.enabled('sessions')) {
      throw new Error('Named sessions are turned off in the Feature Store');
    }
    if (!name) throw new Error('a session needs a name');

    const windows = windowId
      ? [this.windowManager.get(windowId)].filter(Boolean).map((w) => w.toSessionJSON())
      : this.windowManager.toSessionJSON();
    if (!windows.length) throw new Error('nothing to save');

    // Saving over an existing name replaces it, which is what "save" means
    // to a user who just pressed it twice.
    const existing = this.store.data.named.find((s) => s.name === name);
    const record = { id: existing?.id || uid('s_'), name, savedAt: Date.now(), windows };
    if (existing) Object.assign(existing, record);
    else this.store.data.named.push(record);

    this.store.save();
    this.emit('changed', this.list());
    log.info(`saved session "${name}" (${windows.length} window(s))`);
    return record;
  }

  /**
   * Reopen a saved session.
   * @param {{id:string, mode?:'new'|'replace'}} opts
   */
  restore({ id, mode = 'new' } = {}) {
    const record = this.store.data.named.find((s) => s.id === id || s.name === id);
    if (!record) throw new Error(`unknown session "${id}"`);

    if (mode === 'replace') this.windowManager.closeAll();

    const opened = [];
    for (const w of record.windows) {
      const win = this.windowManager.create({
        bounds: w.bounds,
        session: w.tabs,
      });
      this._applyLayout(win, w);
      opened.push(win.id);
    }
    log.info(`restored session "${record.name}"`);
    return { id: record.id, windows: opened };
  }

  /**
   * Re-apply saved chrome layout once the window's tabs exist.
   * Split state references tab ids, so it must run after restore().
   */
  _applyLayout(win, saved) {
    const l = saved.layout || {};
    if (l.tabOrientation) win.setTabOrientation(l.tabOrientation);
    if (typeof l.sidebarWidth === 'number') {
      win.setSidebarWidth(l.sidebarWidth, { collapsed: l.sidebarCollapsed });
    }
    if (l.panel) win.setPanel(l.panel.kind, { width: l.panel.width });
    if (l.split?.tabIds?.length === 2) {
      const [a, b] = l.split.tabIds;
      // Only restore the split if both tabs actually came back.
      if (win.tabs.get(a) && win.tabs.get(b)) {
        win.tabs.activate(a);
        try {
          win.splitWith(b, { ratio: l.split.ratio });
        } catch (err) {
          log.warn(`could not restore split: ${err.message}`);
        }
      }
    }
    if (saved.maximized) win.win.maximize();
  }

  remove(id) {
    const idx = this.store.data.named.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.store.data.named.splice(idx, 1);
    this.store.save();
    this.emit('changed', this.list());
    return true;
  }

  // ---- startup restore -------------------------------------------------

  /**
   * Reopen the last session if the user asked for that behaviour.
   * @returns {Promise<boolean>} whether any window was opened
   */
  async restoreLastSession() {
    const mode = this.settings.get('startPage.mode');
    const last = this.store.data.last;
    if (mode !== 'restore' || !last?.windows?.length) return false;

    for (const w of last.windows) {
      const win = this.windowManager.create({ bounds: w.bounds, session: w.tabs });
      this._applyLayout(win, w);
    }
    log.info(`reopened ${last.windows.length} window(s) from the previous session`);
    return true;
  }

  exportAll() {
    return this.store.data.named;
  }

  importAll(named) {
    const byName = new Map(this.store.data.named.map((s) => [s.name, s]));
    for (const s of named) {
      const existing = byName.get(s.name);
      // Newer wins; sessions are small and conflicts are rare.
      if (!existing) this.store.data.named.push(s);
      else if (s.savedAt > existing.savedAt) Object.assign(existing, s);
    }
    this.store.save();
    this.emit('changed', this.list());
  }

  flush() {
    this.store.flush();
  }
}

module.exports = { SessionService };
