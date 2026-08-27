'use strict';
/**
 * Per-window tab collection: ordering, groups, workspaces and the
 * hibernation scheduler.
 *
 * Ordering lives here rather than in the renderer so that the tab strip is a
 * pure projection of main-process state. Drag-to-reorder sends an index and
 * gets the authoritative order back, which avoids the class of bug where an
 * optimistic UI and the real tab list disagree after a fast drag.
 */
const EventEmitter = require('node:events');
const { Tab } = require('./tab');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('tabs');

/** Group colours, matched to the accent palette in the UI tokens. */
const GROUP_COLORS = ['#6C8CFF', '#4CC9A7', '#F7A072', '#C77DFF', '#FF6B8A', '#5BC0EB', '#F5D547', '#9AA5B1'];

class TabManager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../services/profiles').ProfileService} deps.profiles
   * @param {import('../services/settings').SettingsService} deps.settings
   * @param {import('../services/feature-store').FeatureStore} deps.features
   */
  constructor({ profiles, settings, features }) {
    super();
    this.profiles = profiles;
    this.settings = settings;
    this.features = features;

    /**
     * Optional predicate: "is this tab protected from suspension?".
     *
     * Set by the window layer from the media service. Left as a stub so the
     * tab manager works standalone in tests, and so hibernation has one
     * question to ask rather than a growing list of special cases.
     * @type {(tabId: string) => boolean}
     */
    this.isProtected = () => false;

    /** @type {Map<string, Tab>} */
    this.tabs = new Map();
    /** Authoritative display order (tab ids). */
    this.order = [];
    this.activeId = null;

    /** @type {Map<string, {id:string,name:string,color:string,collapsed:boolean,workspaceId:string|null}>} */
    this.groups = new Map();
    /** @type {Map<string, {id:string,name:string,color:string,icon:string}>} */
    this.workspaces = new Map();
    this.activeWorkspaceId = null;

    this._hibernateTimer = null;
    this._startHibernationLoop();
  }

  // ---- creation & destruction -----------------------------------------

  /**
   * @param {object} opts
   * @param {string} [opts.url]
   * @param {boolean} [opts.background] open without activating
   * @param {number} [opts.index] insertion point; defaults to after active
   */
  create({ url, background = false, index, profileId, groupId = null, pinned = false, id } = {}) {
    const targetProfile = profileId || this.profiles.activeId;
    const session = this.profiles.sessionFor(targetProfile);
    const tab = new Tab({
      session,
      profileId: targetProfile,
      url: url || 'aether://start',
      groupId: groupId ?? (this.activeId ? this.tabs.get(this.activeId)?.groupId ?? null : null),
      pinned,
      id,
    });

    this._wireTab(tab);
    this.tabs.set(tab.id, tab);

    // Pinned tabs always sort ahead of unpinned ones.
    const insertAt = this._resolveInsertIndex(index, tab);
    this.order.splice(insertAt, 0, tab.id);

    this.emit('created', tab);
    this.emit('changed', this.snapshot());

    if (!background) this.activate(tab.id);
    if (url) tab.navigate(url);
    else tab.navigate('aether://start');

    return tab;
  }

  _resolveInsertIndex(index, tab) {
    const pinnedCount = this.order.filter((id) => this.tabs.get(id)?.pinned).length;
    if (tab.pinned) return Math.min(index ?? pinnedCount, pinnedCount);
    if (typeof index === 'number') return Math.max(pinnedCount, Math.min(index, this.order.length));
    // Default: immediately after the active tab, like Chrome's "open in new
    // tab" behaviour, so related tabs stay adjacent.
    const activeIdx = this.activeId ? this.order.indexOf(this.activeId) : -1;
    return activeIdx >= 0 ? activeIdx + 1 : this.order.length;
  }

  _wireTab(tab) {
    tab.on('updated', (json, extra) => this.emit('tab-updated', json, extra));
    tab.on('navigation', (info) => this.emit('navigation', info));
    tab.on('load-failed', (info) => this.emit('load-failed', info));
    tab.on('crashed', (info) => this.emit('crashed', info));
    tab.on('find-result', (info) => this.emit('find-result', info));
    tab.on('context-menu', (info) => this.emit('context-menu', info));
    tab.on('attach-view', (t) => this.emit('attach-view', t));
    tab.on('detach-view', (t) => this.emit('detach-view', t));
    tab.on('open-window', ({ details }) => {
      // Popups requested with explicit window features stay separate; plain
      // `target=_blank` links become tabs.
      const wantsPopup = details.disposition === 'new-window'
        && /width=|height=/.test(details.features || '');
      if (wantsPopup) {
        this.emit('popup-requested', details);
      } else {
        this.create({
          url: details.url,
          background: details.disposition === 'background-tab',
        });
      }
    });
  }

  get(id) {
    return this.tabs.get(id) || null;
  }

  get active() {
    return this.activeId ? this.tabs.get(this.activeId) : null;
  }

  /** Tabs in display order, honouring collapsed groups for the strip. */
  list() {
    return this.order.map((id) => this.tabs.get(id)).filter(Boolean);
  }

  close(id, { force = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    const idx = this.order.indexOf(id);

    tab.destroy();
    this.tabs.delete(id);
    this.order.splice(idx, 1);

    if (this.activeId === id) {
      // Prefer the tab to the right, matching every mainstream browser.
      const next = this.order[idx] || this.order[idx - 1] || null;
      this.activeId = null;
      if (next) this.activate(next);
      else if (!force) this.create({ url: 'aether://start' });
    }

    this.emit('closed', { id });
    this.emit('changed', this.snapshot());
    return true;
  }

  closeAll() {
    for (const tab of this.tabs.values()) tab.destroy();
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }

  duplicate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return this.create({
      url: tab.url,
      index: this.order.indexOf(id) + 1,
      profileId: tab.profileId,
      groupId: tab.groupId,
    });
  }

  // ---- activation ------------------------------------------------------

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (this.activeId === id) return true;

    const previous = this.activeId;
    this.activeId = id;
    tab.lastActive = Date.now();

    // Waking is fire-and-forget: the view attaches as soon as it exists, and
    // the strip already shows the tab as selected.
    if (tab.hibernated) {
      tab.wake().catch((err) => log.warn(`wake failed: ${err.message}`));
    }

    this.emit('activated', { id, previous });
    this.emit('changed', this.snapshot());
    return true;
  }

  /** Cycle by offset, wrapping. Used by Ctrl+Tab and Ctrl+PgUp/PgDn. */
  cycle(offset) {
    if (!this.order.length) return null;
    const visible = this.order.filter((tid) => !this._isInCollapsedGroup(tid));
    const pool = visible.length ? visible : this.order;
    const idx = pool.indexOf(this.activeId);
    const next = pool[((idx + offset) % pool.length + pool.length) % pool.length];
    this.activate(next);
    return next;
  }

  _isInCollapsedGroup(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab?.groupId) return false;
    return this.groups.get(tab.groupId)?.collapsed === true;
  }

  // ---- ordering --------------------------------------------------------

  /**
   * Move a tab to an absolute index in the display order.
   * Pinned tabs cannot be dragged past unpinned ones and vice versa.
   */
  move(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return false;
    const tab = this.tabs.get(id);
    const pinnedCount = this.order.filter((tid) => this.tabs.get(tid)?.pinned).length;

    let target = Math.max(0, Math.min(toIndex, this.order.length - 1));
    if (tab.pinned) target = Math.min(target, Math.max(0, pinnedCount - 1));
    else target = Math.max(target, pinnedCount);

    this.order.splice(from, 1);
    this.order.splice(target, 0, id);

    // Dropping a tab between two members of the same group joins it.
    const before = this.tabs.get(this.order[target - 1]);
    const after = this.tabs.get(this.order[target + 1]);
    if (before && after && before.groupId && before.groupId === after.groupId) {
      tab.groupId = before.groupId;
    }

    this.emit('changed', this.snapshot());
    return true;
  }

  /** Apply a full ordering, e.g. after a multi-select drag. */
  reorder(ids) {
    const known = ids.filter((id) => this.tabs.has(id));
    const missing = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...missing];
    // Re-assert the pinned-first invariant in case the client got it wrong.
    this.order.sort((a, b) => {
      const pa = this.tabs.get(a)?.pinned ? 0 : 1;
      const pb = this.tabs.get(b)?.pinned ? 0 : 1;
      return pa - pb;
    });
    this.emit('changed', this.snapshot());
    return this.order.slice();
  }

  setPinned(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.pinned = pinned;
    // Re-home the tab into the correct half of the strip.
    this.order.splice(this.order.indexOf(id), 1);
    const pinnedCount = this.order.filter((tid) => this.tabs.get(tid)?.pinned).length;
    this.order.splice(pinned ? pinnedCount : this.order.length, 0, id);
    this.emit('tab-updated', tab.toJSON(), { reason: 'pinned' });
    this.emit('changed', this.snapshot());
    return true;
  }

  // ---- groups ----------------------------------------------------------

  createGroup({ name, color, tabIds = [], workspaceId = null } = {}) {
    const group = {
      id: uid('g_'),
      name: name || 'New Group',
      color: color || GROUP_COLORS[this.groups.size % GROUP_COLORS.length],
      collapsed: false,
      workspaceId: workspaceId ?? this.activeWorkspaceId,
      created: Date.now(),
    };
    this.groups.set(group.id, group);
    for (const id of tabIds) this.assignToGroup(id, group.id, { silent: true });
    this._contiguify(group.id);
    this.emit('groups-changed', this.groupList());
    this.emit('changed', this.snapshot());
    return group;
  }

  updateGroup(id, patch) {
    const group = this.groups.get(id);
    if (!group) throw new Error(`unknown group ${id}`);
    Object.assign(group, patch, { id: group.id });
    this.emit('groups-changed', this.groupList());
    return group;
  }

  removeGroup(id, { closeTabs = false } = {}) {
    const group = this.groups.get(id);
    if (!group) return false;
    for (const tab of this.tabs.values()) {
      if (tab.groupId !== id) continue;
      if (closeTabs) this.close(tab.id, { force: true });
      else tab.groupId = null;
    }
    this.groups.delete(id);
    this.emit('groups-changed', this.groupList());
    this.emit('changed', this.snapshot());
    return true;
  }

  assignToGroup(tabId, groupId, { silent = false } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.groupId = groupId;
    if (groupId) this._contiguify(groupId);
    if (!silent) {
      this.emit('tab-updated', tab.toJSON(), { reason: 'group' });
      this.emit('changed', this.snapshot());
    }
    return true;
  }

  /** Pull a group's tabs together so the strip can draw one contiguous band. */
  _contiguify(groupId) {
    const members = this.order.filter((id) => this.tabs.get(id)?.groupId === groupId);
    if (members.length < 2) return;
    const anchor = this.order.indexOf(members[0]);
    const rest = this.order.filter((id) => !members.includes(id));
    const insertAt = Math.min(anchor, rest.length);
    this.order = [...rest.slice(0, insertAt), ...members, ...rest.slice(insertAt)];
  }

  toggleGroupCollapse(id) {
    const group = this.groups.get(id);
    if (!group) return false;
    group.collapsed = !group.collapsed;
    // Collapsing the group that owns the active tab moves focus out of it,
    // otherwise the user is looking at a page with no visible tab.
    if (group.collapsed && this.active?.groupId === id) {
      const outside = this.order.find((tid) => this.tabs.get(tid)?.groupId !== id);
      if (outside) this.activate(outside);
    }
    this.emit('groups-changed', this.groupList());
    this.emit('changed', this.snapshot());
    return group.collapsed;
  }

  groupList() {
    return [...this.groups.values()].map((g) => ({
      ...g,
      tabIds: this.order.filter((id) => this.tabs.get(id)?.groupId === g.id),
    }));
  }

  // ---- workspaces ------------------------------------------------------

  createWorkspace({ name, color, icon } = {}) {
    const ws = {
      id: uid('w_'),
      name: name || 'Workspace',
      color: color || GROUP_COLORS[this.workspaces.size % GROUP_COLORS.length],
      icon: icon || 'layers',
      created: Date.now(),
    };
    this.workspaces.set(ws.id, ws);
    this.emit('workspaces-changed', this.workspaceList());
    return ws;
  }

  /**
   * Switch workspaces. Tabs outside the target workspace are hidden rather
   * than closed — switching back must restore exactly what was there.
   */
  switchWorkspace(id) {
    if (id !== null && !this.workspaces.has(id)) return false;
    this.activeWorkspaceId = id;
    const visible = this.order.filter((tid) => this._inWorkspace(tid, id));
    if (visible.length === 0) {
      this.create({ url: 'aether://start' });
    } else if (!visible.includes(this.activeId)) {
      this.activate(visible[0]);
    }
    this.emit('workspaces-changed', this.workspaceList());
    this.emit('changed', this.snapshot());
    return true;
  }

  _inWorkspace(tabId, workspaceId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (workspaceId === null) return true; // "All tabs"
    if (!tab.groupId) return false;
    return this.groups.get(tab.groupId)?.workspaceId === workspaceId;
  }

  removeWorkspace(id) {
    if (!this.workspaces.delete(id)) return false;
    for (const g of this.groups.values()) {
      if (g.workspaceId === id) g.workspaceId = null;
    }
    if (this.activeWorkspaceId === id) this.switchWorkspace(null);
    this.emit('workspaces-changed', this.workspaceList());
    return true;
  }

  workspaceList() {
    return [...this.workspaces.values()].map((w) => ({
      ...w,
      active: w.id === this.activeWorkspaceId,
      tabCount: this.order.filter((tid) => this._inWorkspace(tid, w.id)).length,
    }));
  }

  // ---- hibernation -----------------------------------------------------

  _startHibernationLoop() {
    // One minute is frequent enough to feel responsive and infrequent enough
    // to be invisible in a CPU profile.
    this._hibernateTimer = setInterval(() => this.runHibernationPass(), 60_000);
    if (this._hibernateTimer.unref) this._hibernateTimer.unref();
  }

  /** @returns {Promise<string[]>} ids of tabs suspended this pass */
  async runHibernationPass() {
    if (!this.features.enabled('hibernation')) return [];
    if (!this.settings.get('tabs.hibernateEnabled')) return [];

    const policy = {
      idleMs: (this.settings.get('tabs.hibernateAfterMinutes') || 30) * 60_000,
      excludeAudible: this.settings.get('tabs.hibernateExcludeAudible') !== false,
      excludePinned: this.settings.get('tabs.hibernateExcludePinned') !== false,
      // Injected rather than imported: the tab manager should not know that
      // a media service exists, and this keeps it testable without one.
      isProtected: this.isProtected,
    };

    const suspended = [];
    for (const tab of this.tabs.values()) {
      // Never suspend what the user is currently looking at.
      if (tab.id === this.activeId) continue;
      if (this._visibleTabIds().includes(tab.id)) continue;
      if (!tab.canHibernate(policy)) continue;
      if (await tab.hibernate()) suspended.push(tab.id);
    }
    if (suspended.length) {
      log.info(`hibernated ${suspended.length} idle tab(s)`);
      this.emit('changed', this.snapshot());
    }
    return suspended;
  }

  /** Tabs currently on screen — the active one, plus split partners. */
  _visibleTabIds() {
    return this._visible || (this.activeId ? [this.activeId] : []);
  }

  /** The window tells us which tabs are on screen (split view shows two). */
  setVisibleTabs(ids) {
    this._visible = ids.filter(Boolean);
  }

  async hibernateNow(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    const ok = await tab.hibernate();
    if (ok) this.emit('changed', this.snapshot());
    return ok;
  }

  // ---- serialisation ---------------------------------------------------

  snapshot() {
    return {
      tabs: this.list().map((t) => t.toJSON()),
      order: this.order.slice(),
      activeId: this.activeId,
      groups: this.groupList(),
      workspaces: this.workspaceList(),
      activeWorkspaceId: this.activeWorkspaceId,
    };
  }

  toSessionJSON() {
    return {
      tabs: this.list().map((t) => t.toSessionJSON()),
      activeId: this.activeId,
      groups: [...this.groups.values()],
      workspaces: [...this.workspaces.values()],
      activeWorkspaceId: this.activeWorkspaceId,
    };
  }

  /** Rebuild from a saved session. Tabs start hibernated-on-demand. */
  restore(data, { activate = true } = {}) {
    if (!data) return;
    for (const g of data.groups || []) this.groups.set(g.id, { ...g });
    for (const w of data.workspaces || []) this.workspaces.set(w.id, { ...w });
    this.activeWorkspaceId = data.activeWorkspaceId ?? null;

    for (const t of data.tabs || []) {
      this.create({
        id: t.id,
        url: t.url,
        background: true,
        pinned: t.pinned,
        groupId: t.groupId,
        profileId: t.profileId,
      });
    }
    if (activate && data.activeId && this.tabs.has(data.activeId)) {
      this.activate(data.activeId);
    } else if (activate && this.order.length) {
      this.activate(this.order[0]);
    }
    this.emit('changed', this.snapshot());
  }

  dispose() {
    if (this._hibernateTimer) clearInterval(this._hibernateTimer);
    this.closeAll();
    this.removeAllListeners();
  }
}

module.exports = { TabManager, GROUP_COLORS };
