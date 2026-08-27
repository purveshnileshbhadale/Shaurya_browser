'use strict';
/**
 * Performance, Turbo and per-tab resource caps (spec §4).
 *
 * Two honest constraints shape everything here.
 *
 * First, **there is no cross-platform GPU utilisation API** in Chromium or
 * Node. Electron exposes `app.getGPUInfo()` (static capability data) and the
 * GPU *process*'s own CPU and memory through `getAppMetrics()`, and nothing
 * else. So this service reports GPU-process load and labels it as exactly
 * that. An invented "GPU 47%" number would look better and mean nothing.
 *
 * Second, **a browser cannot hard-cap a renderer's CPU.** There is no cgroup,
 * no job object, no scheduler hook available from here. What a cap can
 * honestly be is a *watchdog*: sample real usage, and when a tab sits over
 * its limit for several consecutive samples, act — throttle it, then sleep
 * it. That is what the UI promises and what this implements. The distinction
 * is in the tab's tooltip, not buried in a doc.
 *
 * FPS is measured by the page itself (`internal.frameStats` from the content
 * preload) because the main process genuinely cannot observe a renderer's
 * vsync. A tab that reports nothing shows no FPS rather than a guess.
 */
const EventEmitter = require('node:events');
const { app, webContents: allWebContents } = require('electron');
const { createLogger } = require('../../util/logger');

const log = createLogger('perf');

/** How often to sample process metrics while anything is watching. */
const SAMPLE_MS = 1000;
/** Consecutive over-limit samples before a cap acts. Debounces load spikes. */
const CAP_STRIKES = 5;

class PerformanceService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../settings').SettingsService} deps.settings
   * @param {import('../feature-store').FeatureStore} deps.features
   * @param {import('../modes').ModeService} deps.modes
   */
  constructor({ settings, features, modes }) {
    super();
    this.settings = settings;
    this.features = features;
    this.modes = modes;

    /** Set by bootstrap; avoids a construction-order cycle with windows. */
    this.windowManager = null;

    this.turboOn = false;
    this.lowLatencyOn = false;

    /** tabId -> { fps, sampledAt } reported by the page. */
    this._frameStats = new Map();
    /** tabId -> consecutive samples over cap. */
    this._strikes = new Map();
    /** Tabs Turbo suspended, so disabling Turbo can wake exactly those. */
    this._turboSuspended = new Set();
    /** Extensions Turbo disabled, for the same reason. */
    this._turboExtensions = [];

    this._timer = null;
    this._last = { system: null, tabs: [], sampledAt: 0 };

    // Leaving Gamer Mode must not strand the browser in a suspended state:
    // a user who switches back to Default and finds every tab asleep and
    // sync off would reasonably call that broken.
    this.modes?.on('changed', () => this._onModeChanged());
  }

  attach(windowManager) {
    this.windowManager = windowManager;
  }

  // -- sampling ----------------------------------------------------------

  /**
   * Start sampling. Idempotent, and refcount-free on purpose: the timer is
   * cheap, and the alternative (tracking who asked) is a leak waiting to
   * happen when a panel closes without saying so.
   */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sample(), SAMPLE_MS);
    this._timer.unref?.();
    this._setPageSampling(true);
    this._sample();
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
    this._setPageSampling(false);
    this._frameStats.clear();
  }

  /**
   * Turn the pages' own frame counters on or off.
   *
   * Measuring FPS costs a `requestAnimationFrame` loop in every page, which
   * is small but not free — and it would be running in a hundred tabs of a
   * user who never opens the overlay. So it is armed only while something is
   * watching, and disarmed the moment nothing is.
   */
  _setPageSampling(enabled) {
    for (const win of this.windowManager?.list() || []) {
      for (const tab of win.tabs.list()) {
        try {
          tab.webContents?.send('aether:frame-stats', enabled);
        } catch { /* a view mid-teardown */ }
      }
    }
  }

  /** A page reported its own frame timing. */
  recordFrameStats(tabId, { fps } = {}) {
    if (!Number.isFinite(fps)) return;
    this._frameStats.set(tabId, { fps: Math.round(fps), sampledAt: Date.now() });
  }

  _sample() {
    let metrics = [];
    try {
      metrics = app.getAppMetrics();
    } catch (err) {
      log.debug(`getAppMetrics failed: ${err.message}`);
      return;
    }

    const byPid = new Map(metrics.map((m) => [m.pid, m]));
    const gpu = metrics.find((m) => m.type === 'GPU');
    const browser = metrics.find((m) => m.type === 'Browser');

    const totalCpu = metrics.reduce((n, m) => n + (m.cpu?.percentCPUUsage || 0), 0);
    const totalMem = metrics.reduce((n, m) => n + (m.memory?.workingSetSize || 0), 0);

    let systemMemory = null;
    try {
      systemMemory = process.getSystemMemoryInfo();
    } catch { /* not available on every platform */ }

    const tabs = this._sampleTabs(byPid);

    this._last = {
      sampledAt: Date.now(),
      system: {
        // percentCPUUsage is per-core-normalised by Chromium already, but it
        // can still exceed 100 across processes on a multicore machine, so
        // report it as "browser CPU" rather than implying a system figure we
        // are not entitled to.
        cpu: round(totalCpu, 1),
        cpuCores: require('node:os').cpus().length,
        memoryBytes: totalMem * 1024,
        processCount: metrics.length,
        browserCpu: round(browser?.cpu?.percentCPUUsage || 0, 1),
        // Explicitly the GPU *process*, not the adapter. See the file header.
        gpuProcessCpu: round(gpu?.cpu?.percentCPUUsage || 0, 1),
        gpuProcessMemoryBytes: (gpu?.memory?.workingSetSize || 0) * 1024,
        systemMemory: systemMemory ? {
          totalBytes: systemMemory.total * 1024,
          freeBytes: systemMemory.free * 1024,
        } : null,
      },
      tabs,
    };

    this.emit('metrics', this._last);
    if (tabs.length) this.emit('tabUsage', tabs);
    this._enforceCaps(tabs);
    return this._last;
  }

  /** Join Chromium process metrics onto the tab that owns each process. */
  _sampleTabs(byPid) {
    if (!this.windowManager) return [];
    const rows = [];

    for (const win of this.windowManager.list()) {
      for (const tab of win.tabs.list()) {
        if (tab.hibernated) {
          rows.push({
            tabId: tab.id, windowId: win.id, title: tab.title, url: tab.url,
            hibernated: true, cpu: 0, memoryBytes: 0, fps: null,
            audible: false, capped: this._capFor(tab) !== null,
          });
          continue;
        }

        const wc = tab.webContents;
        if (!wc || wc.isDestroyed()) continue;

        let pid = null;
        try { pid = wc.getOSProcessId(); } catch { /* racing a close */ }
        const m = pid != null ? byPid.get(pid) : null;

        const frame = this._frameStats.get(tab.id);
        // A stale FPS reading is worse than none: it would suggest a paused
        // page is still rendering.
        const fresh = frame && Date.now() - frame.sampledAt < 3000;

        rows.push({
          tabId: tab.id,
          windowId: win.id,
          title: tab.title,
          url: tab.url,
          hibernated: false,
          pid,
          cpu: round(m?.cpu?.percentCPUUsage || 0, 1),
          memoryBytes: (m?.memory?.workingSetSize || 0) * 1024,
          fps: fresh ? frame.fps : null,
          audible: tab.audible === true,
          muted: tab.muted === true,
          cap: this._capFor(tab),
          capped: this._capFor(tab) !== null,
        });
      }
    }
    return rows;
  }

  metrics() {
    if (!this._timer) this._sample();
    return this._last;
  }

  tabUsage() {
    return this._last.tabs;
  }

  // -- Turbo -------------------------------------------------------------

  /**
   * Turbo: hand the machine to the foreground.
   *
   * Suspends background tabs, disables extensions and pauses sync — and
   * records exactly what it touched, so turning Turbo off restores that set
   * and nothing else. A Turbo that woke *every* tab would resurrect ones the
   * user had deliberately hibernated an hour ago.
   */
  async setTurbo(on, { deps } = {}) {
    const want = on === true;
    if (want === this.turboOn) return this.turboState();

    this.turboOn = want;
    const policy = this.settings.get('gaming.turbo') || {};

    if (want) {
      this._turboSuspended.clear();
      this._turboExtensions = [];

      if (policy.suspendBackgroundTabs !== false) {
        for (const win of this.windowManager?.list() || []) {
          const visible = new Set([win.tabs.activeId, ...(win.tabs._visible || [])]);
          for (const tab of win.tabs.list()) {
            if (visible.has(tab.id) || tab.hibernated) continue;
            // Never silence something the user is listening to. `audible` is
            // the narrow test; the media registry also protects a paused
            // track whose position would be lost.
            if (policy.keepAudible !== false && tab.audible) continue;
            if (policy.keepAudible !== false && win.tabs.isProtected?.(tab.id)) continue;
            if (tab.pinned && this.settings.get('tabs.hibernateExcludePinned') !== false) continue;
            if (await tab.hibernate()) this._turboSuspended.add(tab.id);
          }
          win.tabs.emit('changed', win.tabs.snapshot());
        }
      }

      if (policy.suspendExtensions !== false && deps?.extensions) {
        try {
          this._turboExtensions = await deps.extensions.suspendAll();
        } catch (err) { log.debug(`turbo extensions: ${err.message}`); }
      }

      if (policy.pauseSync !== false && deps?.sync) {
        try { deps.sync.pause(); } catch (err) { log.debug(`turbo sync: ${err.message}`); }
      }

      this._applyBackgroundThrottling(true);
      log.info(`turbo on: suspended ${this._turboSuspended.size} tab(s)`);
    } else {
      // Restore only what Turbo itself took.
      if (this._turboExtensions.length && deps?.extensions) {
        try { await deps.extensions.resume(this._turboExtensions); } catch { /* best effort */ }
        this._turboExtensions = [];
      }
      if (deps?.sync) {
        try { deps.sync.resume(); } catch { /* best effort */ }
      }
      this._applyBackgroundThrottling(this.lowLatencyOn);
      this._turboSuspended.clear();
      log.info('turbo off');
    }

    this.emit('turbo', this.turboState());
    return this.turboState();
  }

  turboState() {
    return {
      on: this.turboOn,
      suspendedTabs: this._turboSuspended.size,
      suspendedExtensions: this._turboExtensions.length,
      policy: this.settings.get('gaming.turbo'),
    };
  }

  /**
   * Low-latency mode: stop doing work that competes with the foreground.
   *
   * The renderer half of this (dropping animations) rides on the same
   * appearance channel the modes use, so there is one mechanism for "the
   * chrome should be still" rather than two that can disagree.
   */
  setLowLatency(on) {
    this.lowLatencyOn = on === true;
    this._applyBackgroundThrottling(this.lowLatencyOn || this.turboOn);
    this.emit('turbo', this.turboState());
    return { lowLatency: this.lowLatencyOn };
  }

  /**
   * Chromium already throttles background renderers; this makes sure the
   * setting is actually on for every live tab, including ones created while
   * the mode was inactive.
   */
  _applyBackgroundThrottling(enabled) {
    for (const wc of allWebContents.getAllWebContents()) {
      try {
        if (wc.isDestroyed()) continue;
        wc.setBackgroundThrottling(enabled !== false);
      } catch { /* a view mid-teardown */ }
    }
  }

  // -- per-tab caps ------------------------------------------------------

  /**
   * Caps are keyed by host, not tab id, so a cap survives a reload, a
   * restart, and the tab being closed and reopened — which is what a user
   * who capped a known-greedy site actually meant.
   */
  setTabCap(tabIdOrHost, { cpuPercent = null, memoryMb = null } = {}) {
    const host = this._hostFor(tabIdOrHost);
    if (!host) throw new Error('cannot cap a tab with no host');

    const caps = { ...(this.settings.get('gaming.tabCaps') || {}) };
    if (cpuPercent == null && memoryMb == null) delete caps[host];
    else caps[host] = { cpuPercent, memoryMb };

    this.settings.set('gaming.tabCaps', caps);
    this._strikes.delete(tabIdOrHost);
    this.emit('tabUsage', this._last.tabs);
    return caps[host] || null;
  }

  clearTabCap(tabIdOrHost) {
    return this.setTabCap(tabIdOrHost, {});
  }

  _hostFor(tabIdOrHost) {
    if (typeof tabIdOrHost === 'string' && !tabIdOrHost.startsWith('tab-')) {
      return tabIdOrHost;
    }
    const found = this.windowManager?.locateTabById?.(tabIdOrHost);
    const url = found?.tab?.url;
    try { return url ? new URL(url).hostname : null; } catch { return null; }
  }

  _capFor(tab) {
    const caps = this.settings.get('gaming.tabCaps') || {};
    try {
      return caps[new URL(tab.url).hostname] || null;
    } catch {
      return null;
    }
  }

  /**
   * The watchdog. Over the limit for CAP_STRIKES consecutive seconds gets a
   * tab throttled and then slept — a spike while a page loads does not.
   */
  _enforceCaps(rows) {
    if (!this.features.enabled('tabLimits')) return;

    for (const row of rows) {
      if (row.hibernated || !row.cap) { this._strikes.delete(row.tabId); continue; }

      const overCpu = row.cap.cpuPercent != null && row.cpu > row.cap.cpuPercent;
      const overMem = row.cap.memoryMb != null
        && row.memoryBytes > row.cap.memoryMb * 1024 * 1024;

      if (!overCpu && !overMem) { this._strikes.delete(row.tabId); continue; }

      const strikes = (this._strikes.get(row.tabId) || 0) + 1;
      this._strikes.set(row.tabId, strikes);
      if (strikes < CAP_STRIKES) continue;

      this._strikes.delete(row.tabId);
      const found = this.windowManager?.locateTabById?.(row.tabId);
      if (!found?.tab) continue;
      // Never sleep the tab the user is looking at: capping the foreground
      // would make the browser appear to crash the page they are using.
      if (found.window?.tabs.activeId === row.tabId) continue;

      log.info(`cap exceeded on ${row.title}: sleeping (${overCpu ? 'cpu' : 'memory'})`);
      found.tab.hibernate().then(() => {
        found.window?.tabs.emit('changed', found.window.tabs.snapshot());
        this.emit('capEnforced', {
          tabId: row.tabId, reason: overCpu ? 'cpu' : 'memory', cap: row.cap,
        });
      }).catch(() => {});
    }
  }

  // -- mode integration --------------------------------------------------

  _onModeChanged() {
    const wantOverlayWork = this.features.enabled('tabLimits')
      || this.features.enabled('hardwareOverlay');

    if (wantOverlayWork) this.start(); else this.stop();

    // Turbo and low latency are Gamer Mode behaviours. Leaving the mode
    // releases them, so the browser cannot be left throttled invisibly.
    if (this.turboOn && !this.features.enabled('turbo')) {
      this.setTurbo(false).catch(() => {});
    }
    if (this.lowLatencyOn && !this.features.enabled('lowLatency')) {
      this.setLowLatency(false);
    }
  }

  dispose() {
    this.stop();
    this._frameStats.clear();
    this._strikes.clear();
  }
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

module.exports = { PerformanceService, SAMPLE_MS, CAP_STRIKES };
