'use strict';
/**
 * Background playback and the now-playing registry.
 *
 * The problem this solves: Chromium aggressively throttles background
 * renderers, hibernation reclaims idle tabs, and Turbo suspends anything not
 * in the foreground. All three are correct defaults — and all three will
 * silently kill the album you were listening to the moment you switch tabs.
 *
 * So "background play" is not one feature but a *carve-out* that has to be
 * honoured in four places at once:
 *
 *   1. `setBackgroundThrottling(false)` on the playing renderer, or Chromium
 *      throttles its timers and playback stutters then stalls.
 *   2. `setAudioMuted(false)` is never forced — but the tab must survive the
 *      hibernation sweep, which already spares audible tabs.
 *   3. Turbo must not suspend it, for the same reason.
 *   4. A power-save blocker, or the OS suspends the whole app on idle and
 *      playback stops mid-track with the screen off.
 *
 * Miss any one and the feature appears to work until the exact moment
 * someone relies on it.
 *
 * What counts as "playing" comes from the page itself via the Media Session
 * API — the same metadata Chrome shows in its own media hub. Falling back to
 * `webContents.isCurrentlyAudible()` alone would miss a paused-but-loaded
 * track and would call a video ad "now playing".
 */
const EventEmitter = require('node:events');
const { powerSaveBlocker, globalShortcut } = require('electron');

const { createLogger } = require('../util/logger');

const log = createLogger('media');

/**
 * Media keys. Registered globally so they work while the browser is behind
 * a game or an editor — which is the entire point of background playback.
 *
 * `MediaPlayPause` and friends are the accelerators Electron maps to the
 * hardware keys on all three platforms.
 */
const MEDIA_KEYS = {
  MediaPlayPause: 'playpause',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'previous',
  MediaStop: 'stop',
};

class MediaService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./settings').SettingsService} deps.settings
   * @param {import('./feature-store').FeatureStore} deps.features
   * @param {import('./content-bridge').ContentBridge} deps.content
   */
  constructor({ settings, features, content }) {
    super();
    this.settings = settings;
    this.features = features;
    this.content = content;

    this.windowManager = null;

    /**
     * tabId -> session record. Only tabs that have *announced* media are in
     * here, so an ordinary page costs nothing.
     * @type {Map<string, object>}
     */
    this.sessions = new Map();

    /** The tab whose media the media keys control. */
    this._activeTabId = null;
    /** Non-zero while a power-save blocker is held. */
    this._blockerId = 0;
    this._keysRegistered = false;
  }

  attach(windowManager) {
    this.windowManager = windowManager;
  }

  config() {
    return this.settings.get('media') || {};
  }

  // == Registry ==========================================================

  /**
   * A page reported its playback state.
   *
   * Called on every meaningful transition — play, pause, track change,
   * metadata arrival — not on a timer, because media state is genuinely
   * event-driven and polling it would be both slower to react and more
   * expensive.
   */
  report(tabId, state) {
    if (!tabId) return;

    const previous = this.sessions.get(tabId);
    const record = {
      tabId,
      playing: state.playing === true,
      title: String(state.title || '').slice(0, 200),
      artist: String(state.artist || '').slice(0, 200),
      album: String(state.album || '').slice(0, 200),
      artwork: pickArtwork(state.artwork),
      duration: Number.isFinite(state.duration) ? state.duration : null,
      position: Number.isFinite(state.position) ? state.position : null,
      // Which transport controls the page actually implements. A next-track
      // button that does nothing is worse than no button.
      canSeek: state.canSeek === true,
      canNext: state.canNext === true,
      canPrevious: state.canPrevious === true,
      hasVideo: state.hasVideo === true,
      origin: state.origin || '',
      updatedAt: Date.now(),
    };

    this.sessions.set(tabId, record);

    // The most recently *started* session owns the media keys. That matches
    // what every OS media hub does, and it is what a user means when they
    // start a new track and reach for the play button.
    if (record.playing && (!previous?.playing || this._activeTabId == null)) {
      this._activeTabId = tabId;
    }

    this._applyCarveOut(tabId, record.playing);
    this._syncPowerBlocker();
    this._syncMediaKeys();

    this.emit('changed', this.snapshot());
  }

  /** A tab stopped reporting — navigated away, closed, or media removed. */
  clear(tabId) {
    if (!this.sessions.has(tabId)) return;
    this._applyCarveOut(tabId, false);
    this.sessions.delete(tabId);

    if (this._activeTabId === tabId) {
      // Hand the keys to whatever is still playing, if anything.
      const next = [...this.sessions.values()]
        .filter((s) => s.playing)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      this._activeTabId = next?.tabId || null;
    }

    this._syncPowerBlocker();
    this._syncMediaKeys();
    this.emit('changed', this.snapshot());
  }

  /**
   * Is this tab protected from being suspended?
   *
   * Consulted by hibernation and by Turbo. Deliberately broader than
   * "currently audible": a paused podcast that the user will resume in a
   * minute should not be torn down, because waking it loses their position.
   */
  isProtected(tabId) {
    if (!this.features.enabled('backgroundPlay')) return false;
    const session = this.sessions.get(tabId);
    if (!session) return false;
    if (session.playing) return true;

    // A recently-paused session keeps its reprieve for a grace period, then
    // becomes an ordinary tab again.
    const graceMs = (this.config().pausedGraceMinutes ?? 5) * 60_000;
    return Date.now() - session.updatedAt < graceMs;
  }

  // == The carve-out =====================================================

  /**
   * Exempt a playing renderer from background throttling.
   *
   * This is the piece people miss. Chromium throttles timers in background
   * renderers to once a minute; an audio element survives that, but the
   * *player* — the site's JavaScript that advances the queue, refreshes the
   * stream token, and handles buffering — does not. Playback stops at the
   * end of the current track, or when the token expires, and it looks like
   * the site broke rather than the browser.
   */
  _applyCarveOut(tabId, playing) {
    const found = this.windowManager?.locateTabById?.(tabId);
    const wc = found?.tab?.webContents;
    if (!wc || wc.isDestroyed()) return;

    const exempt = playing && this.features.enabled('backgroundPlay');
    try {
      wc.setBackgroundThrottling(!exempt);
    } catch { /* a view mid-teardown */ }
  }

  /**
   * Hold a power-save blocker while anything is playing.
   *
   * `prevent-app-suspension` rather than `prevent-display-sleep`: the user
   * listening to music wants their screen to turn off. Blocking the display
   * would burn their battery to solve a problem they do not have.
   */
  _syncPowerBlocker() {
    const shouldHold = this.features.enabled('backgroundPlay')
      && this.config().preventSuspend !== false
      && [...this.sessions.values()].some((s) => s.playing);

    if (shouldHold && !this._blockerId) {
      this._blockerId = powerSaveBlocker.start('prevent-app-suspension');
      log.debug('power-save blocker started');
    } else if (!shouldHold && this._blockerId) {
      try { powerSaveBlocker.stop(this._blockerId); } catch { /* already gone */ }
      this._blockerId = 0;
      log.debug('power-save blocker released');
    }
  }

  // == Media keys ========================================================

  /**
   * Register the hardware media keys only while something is playing.
   *
   * Holding them permanently would steal play/pause from Spotify whenever
   * the browser happened to be open, which is the single most irritating
   * thing a browser can do to a desktop.
   */
  _syncMediaKeys() {
    const want = this.features.enabled('backgroundPlay')
      && this.config().mediaKeys !== false
      && this.sessions.size > 0;

    if (want === this._keysRegistered) return;

    if (want) {
      for (const [accelerator, action] of Object.entries(MEDIA_KEYS)) {
        try {
          globalShortcut.register(accelerator, () => this.control(action));
        } catch (err) {
          log.debug(`could not bind ${accelerator}: ${err.message}`);
        }
      }
      this._keysRegistered = true;
      log.debug('media keys bound');
    } else {
      for (const accelerator of Object.keys(MEDIA_KEYS)) {
        try { globalShortcut.unregister(accelerator); } catch { /* not bound */ }
      }
      this._keysRegistered = false;
      log.debug('media keys released');
    }
  }

  // == Transport =========================================================

  /**
   * Drive playback.
   *
   * Routed through the page's own Media Session action handlers rather than
   * by poking `<video>.play()` directly: a site with a queue needs its own
   * next-track logic to run, and calling play() on the element would resume
   * the wrong thing on a page with several players.
   *
   * @param {'play'|'pause'|'playpause'|'next'|'previous'|'stop'|'seek'} action
   */
  async control(action, { tabId, position } = {}) {
    const targetId = tabId || this._activeTabId;
    if (!targetId) return { ok: false, reason: 'nothing is playing' };

    const session = this.sessions.get(targetId);
    const found = this.windowManager?.locateTabById?.(targetId);
    if (!session || !found?.tab?.webContents) {
      this.clear(targetId);
      return { ok: false, reason: 'that tab is gone' };
    }

    const resolved = action === 'playpause'
      ? (session.playing ? 'pause' : 'play')
      : action;

    try {
      const result = await this.content.request(
        found.tab.webContents, 'media.control', { action: resolved, position },
      );
      return { ok: true, action: resolved, ...result };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /** Focus the tab that is playing — the "go to what I'm hearing" affordance. */
  reveal(tabId) {
    const targetId = tabId || this._activeTabId;
    const found = this.windowManager?.locateTabById?.(targetId);
    if (!found) return { ok: false };
    found.window.tabs.activate(targetId);
    found.window.focus?.();
    return { ok: true, tabId: targetId };
  }

  // == Projection ========================================================

  snapshot() {
    const sessions = [...this.sessions.values()]
      // Playing first, then most recent: the list is read top-down.
      .sort((a, b) => (b.playing ? 1 : 0) - (a.playing ? 1 : 0) || b.updatedAt - a.updatedAt);

    return {
      sessions,
      activeId: this._activeTabId,
      active: sessions.find((s) => s.tabId === this._activeTabId) || null,
      anyPlaying: sessions.some((s) => s.playing),
      backgroundPlay: this.features.enabled('backgroundPlay'),
      mediaKeysBound: this._keysRegistered,
      holdingWakeLock: this._blockerId !== 0,
    };
  }

  /** Re-apply everything after a feature toggle or a mode change. */
  refresh() {
    for (const [tabId, session] of this.sessions) {
      this._applyCarveOut(tabId, session.playing);
    }
    this._syncPowerBlocker();
    this._syncMediaKeys();
    this.emit('changed', this.snapshot());
  }

  dispose() {
    if (this._blockerId) {
      try { powerSaveBlocker.stop(this._blockerId); } catch { /* already gone */ }
      this._blockerId = 0;
    }
    if (this._keysRegistered) {
      for (const accelerator of Object.keys(MEDIA_KEYS)) {
        try { globalShortcut.unregister(accelerator); } catch { /* not bound */ }
      }
      this._keysRegistered = false;
    }
    this.sessions.clear();
  }
}

/**
 * Choose artwork.
 *
 * Media Session artwork arrives as a list of sizes. Picking the largest
 * would download a 1024px cover to render at 40px; picking the smallest
 * gives a blurry chip on a HiDPI screen. ~192px is the sweet spot for a
 * now-playing row at 2× and is a size almost every site provides.
 */
function pickArtwork(artwork) {
  if (!Array.isArray(artwork) || !artwork.length) return null;

  const scored = artwork
    .filter((a) => a && typeof a.src === 'string')
    .map((a) => {
      const size = Number(String(a.sizes || '').split('x')[0]) || 0;
      return { src: a.src, size, distance: Math.abs(size - 192) };
    })
    .sort((a, b) => a.distance - b.distance);

  return scored[0]?.src || null;
}

module.exports = { MediaService, MEDIA_KEYS, pickArtwork };
