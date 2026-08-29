'use strict';
/**
 * Ad & tracker blocking service (spec §3).
 *
 * Blocking happens in `session.webRequest.onBeforeRequest`, which is
 * Chromium's network stack — the request is cancelled before a socket is
 * opened. That is materially different from a content script that hides
 * elements after they load: nothing is fetched, so no bytes, no cookies and
 * no timing signal ever reach the tracker.
 *
 * Cosmetic rules are a *second*, complementary layer that removes the empty
 * frames left behind. They are delivered to the content preload, never used
 * as the primary mechanism.
 */
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { FilterEngine, baseDomain } = require('./matcher');
const { parseList } = require('./filter-parser');
const { request } = require('../../util/net');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');
const { JsonStore } = require('../../util/json-store');
const { hubFor, PRIORITY } = require('../web-request-hub');

const log = createLogger('adblock');

/**
 * Default subscriptions. EasyList and EasyPrivacy are the de-facto standard
 * lists every major blocker builds on; the others cover annoyances and the
 * cookie-banner plague.
 */
const DEFAULT_LISTS = [
  { id: 'easylist', name: 'EasyList', group: 'Ads', enabled: true,
    url: 'https://easylist.to/easylist/easylist.txt',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/easylist.txt',
      'https://cdn.jsdelivr.net/gh/easylist/easylist@master/easylist.txt',
    ] },
  { id: 'easyprivacy', name: 'EasyPrivacy', group: 'Tracking', enabled: true,
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/easyprivacy.txt',
      'https://cdn.jsdelivr.net/gh/easylist/easylist@master/easyprivacy.txt',
    ] },
  { id: 'ublock-filters', name: 'uBlock filters', group: 'Ads', enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/filters.txt',
    ] },
  { id: 'ublock-privacy', name: 'uBlock privacy', group: 'Tracking', enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/privacy.txt',
    ] },
  { id: 'easylist-cookie', name: 'EasyList Cookie', group: 'Annoyances', enabled: true,
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/easylist-cookies.txt',
    ] },
  { id: 'peter-lowe', name: 'Peter Lowe\u2019s List', group: 'Ads', enabled: false,
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    mirrors: [
      'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/plowe-0.txt',
    ] },
];

/** Refresh cadence for subscriptions. */
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice daily, like uBlock

/** First retry after a wholly failed update, then doubling up to the cap. */
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;

/** Requests Shaurya itself makes must never be filtered. */
const INTERNAL_SCHEMES = new Set(['shaurya:', 'devtools:', 'chrome-extension:', 'blob:', 'data:', 'file:']);

class AdblockService extends EventEmitter {
  /**
   * @param {import('../settings').SettingsService} settings
   * @param {import('../feature-store').FeatureStore} features
   */
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.engine = new FilterEngine();
    this.ready = false;

    this.listStore = new JsonStore(paths.userData('filter-lists.json'), {
      lists: DEFAULT_LISTS,
      lastUpdate: 0,
    });
    // Merge in lists added by a newer build without losing user choices.
    this._mergeDefaults();

    /** tabId -> { count, byHost:Map, session } */
    this.tabCounts = new Map();
    /** Lifetime totals, shown on the shield and the privacy dashboard. */
    this.totals = { blocked: 0, since: Date.now() };
    this._totalsStore = new JsonStore(paths.userData('adblock-stats.json'), this.totals);
    this.totals = this._totalsStore.data;

    this._updateTimer = null;
    this._retryTimer = null;
    this._retryDelay = 0;
    /** True while the only rules loaded are the bundled seed. */
    this.usingSeed = false;
  }

  /**
   * Reconcile the stored subscriptions with the shipped defaults.
   *
   * URLs and mirrors are *code*, not user data: when a host goes away or a
   * mirror is added, an upgraded build must pick that up. A user's `enabled`
   * choice is the only field that survives, along with any list they added
   * themselves.
   */
  _mergeDefaults() {
    const existing = new Map(this.listStore.data.lists.map((l) => [l.id, l]));
    for (const def of DEFAULT_LISTS) {
      const current = existing.get(def.id);
      if (!current) {
        this.listStore.data.lists.push({ ...def });
        continue;
      }
      current.name = def.name;
      current.group = def.group;
      current.url = def.url;
      current.mirrors = def.mirrors;
    }
    this.listStore.save();
  }

  // ---- lifecycle -------------------------------------------------------

  /** Load cached lists from disk, then refresh in the background. */
  async init() {
    await this.rebuild();
    this.ready = true;

    // Refresh if the lists are stale *or* if we are running on the seed,
    // which means no subscription has ever downloaded. The second condition
    // is the one that matters: without it, a build whose stored timestamp
    // looks recent will never try to acquire the lists it does not have.
    const age = Date.now() - (this.listStore.data.lastUpdate || 0);
    if (age > UPDATE_INTERVAL_MS || this.usingSeed) {
      // Don't block startup on the network.
      this.updateLists().catch((err) => log.warn(`initial update failed: ${err.message}`));
    }
    this._updateTimer = setInterval(
      () => this.updateLists().catch((err) => log.warn(`update failed: ${err.message}`)),
      UPDATE_INTERVAL_MS
    );
    if (this._updateTimer.unref) this._updateTimer.unref();
  }

  dispose() {
    if (this._updateTimer) clearInterval(this._updateTimer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._totalsStore.flush();
  }

  /**
   * Rebuild the index from whatever is cached on disk.
   *
   * The new index is built in a *separate* engine and swapped in at the end.
   * Building in place would mean calling `clear()` and then spending a second
   * or two parsing 110,000 rules, and every request arriving in that window
   * would sail through an empty index — on every start, and again on every
   * scheduled update. A blocker that stops blocking while it refreshes is
   * worse than one that is merely stale.
   */
  async rebuild() {
    const t0 = Date.now();
    const next = new FilterEngine();
    let loaded = 0;

    for (const list of this.listStore.data.lists) {
      if (!list.enabled) continue;
      const text = this._readList(list.id);
      if (text == null) continue; // Not downloaded yet; updateLists() will fetch it.

      const parsed = parseList(text);
      next.addParsedList(parsed);
      list.rules = parsed.network.length + parsed.exceptions.length;
      list.cosmetic = parsed.cosmetic.length;
      loaded++;
    }

    // Nothing cached yet — a fresh install, or a first run with no network.
    // The bundled seed keeps the largest trackers blocked until the real
    // lists arrive, rather than leaving the browser wide open.
    this.usingSeed = loaded === 0;
    if (this.usingSeed) {
      const seed = this._readSeed();
      if (seed) {
        next.addParsedList(parseList(seed));
        log.warn(
          `no subscription is cached; running on the bundled seed list `
          + `(${next.stats.network} rules). Real protection needs a download.`
        );
      }
    }

    this.engine = next;
    this.listStore.save();
    log.info(
      `index built from ${loaded} lists in ${Date.now() - t0}ms — ` +
      `${this.engine.stats.network} block, ${this.engine.stats.exceptions} allow, ` +
      `${this.engine.stats.cosmetic} cosmetic rules`
    );
    this.emit('lists', this.lists());
  }

  /** A cached subscription's text, or null if it is not on disk. */
  _readList(id) {
    try {
      return fs.readFileSync(path.join(paths.filtersDir(), `${id}.txt`), 'utf8');
    } catch {
      return null;
    }
  }

  /** The list bundled with the app, for before anything has downloaded. */
  _readSeed() {
    try {
      return fs.readFileSync(paths.appPath('assets', 'filters', 'seed.txt'), 'utf8');
    } catch (err) {
      log.error(`the bundled seed list is missing: ${err.message}`);
      return null;
    }
  }

  /**
   * Download every enabled subscription, then rebuild.
   *
   * Each list carries mirrors and we fall through them in order. Filter-list
   * hosts go down, get rate-limited and are blocked on corporate networks
   * often enough that a single-URL fetcher degrades a user's protection
   * silently — the mirrors keep blocking current when the canonical host is
   * unreachable.
   */
  async updateLists({ force = false } = {}) {
    const results = [];
    for (const list of this.listStore.data.lists) {
      if (!list.enabled && !force) continue;
      const file = path.join(paths.filtersDir(), `${list.id}.txt`);
      const candidates = [list.url, ...(list.mirrors || [])];
      const attempts = [];
      let saved = false;

      for (const url of candidates) {
        try {
          const res = await request(url, {
            timeout: 30000,
            headers: { 'User-Agent': 'Shaurya/1.0 (filter-list-updater)' },
          });
          if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
          const text = res.body.toString('utf8');
          // Guard against a captive portal or error page replacing a list.
          if (!this._looksLikeFilterList(text)) {
            throw new Error('response does not look like a filter list');
          }
          fs.writeFileSync(file, text, 'utf8');
          list.lastFetched = Date.now();
          list.bytes = res.body.length;
          list.source = url;
          list.error = null;
          saved = true;
          results.push({ id: list.id, ok: true, bytes: res.body.length, source: url });
          log.info(`fetched ${list.id} (${(res.body.length / 1024).toFixed(0)} KiB) from ${new URL(url).host}`);
          break;
        } catch (err) {
          attempts.push(`${new URL(url).host}: ${err.message}`);
        }
      }

      if (!saved) {
        list.error = attempts.join('; ');
        results.push({ id: list.id, ok: false, error: list.error });
        log.warn(`could not fetch ${list.id} — ${list.error}`);
      }
    }

    // Only a run that actually fetched something counts as an update.
    //
    // Stamping the clock unconditionally is the bug that turns a momentary
    // network problem into a permanently inert blocker: `init()` skips the
    // refresh while the stamp looks recent, so one failed first launch —
    // offline, captive portal, a host the network blocks — buys twelve hours
    // of a browser that silently blocks nothing and says it is fine.
    const succeeded = results.filter((r) => r.ok).length;
    if (succeeded > 0) {
      this.listStore.data.lastUpdate = Date.now();
      this._retryDelay = 0;
    }
    this.listStore.save();
    await this.rebuild();

    if (succeeded === 0 && results.length > 0) this._scheduleRetry();
    return results;
  }

  /**
   * Try again soon after a wholly failed update, backing off as it keeps
   * failing.
   *
   * The twelve-hour cadence is right for keeping current lists fresh and
   * badly wrong for acquiring lists we do not have: the common case is a
   * laptop opened before the wifi has associated, where the right answer is
   * to retry in a minute, not tomorrow.
   */
  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryDelay = Math.min(
      this._retryDelay ? this._retryDelay * 2 : RETRY_BASE_MS,
      RETRY_MAX_MS
    );
    log.info(`retrying filter list download in ${Math.round(this._retryDelay / 1000)}s`);

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.updateLists().catch((err) => log.warn(`retry failed: ${err.message}`));
    }, this._retryDelay);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  /** Structural sniff: does this body plausibly contain filter rules? */
  _looksLikeFilterList(text) {
    if (text.length < 256) return false;
    if (/^\s*<(!doctype|html)/i.test(text)) return false; // an error page
    let rules = 0;
    for (const line of text.split('\n', 400)) {
      if (/^\s*(\|\||@@|##|#@#|\/.+\/|[a-z0-9.*-]+[#^$/])/i.test(line)) rules++;
    }
    return rules >= 20;
  }

  lists() {
    return this.listStore.data.lists.map((l) => ({ ...l }));
  }

  setListEnabled(id, enabled) {
    const list = this.listStore.data.lists.find((l) => l.id === id);
    if (!list) throw new Error(`unknown list ${id}`);
    list.enabled = enabled;
    this.listStore.save();
    return this.rebuild().then(() => this.lists());
  }

  // ---- per-site policy -------------------------------------------------

  /** 'on' | 'off' — per-site override of the global setting. */
  siteSetting(host) {
    const key = baseDomain((host || '').toLowerCase());
    const site = this.settings.get(`privacy.siteSettings.${key}`);
    if (site && typeof site.adblock === 'boolean') return site.adblock ? 'on' : 'off';
    return this.settings.get('privacy.adblock') ? 'on' : 'off';
  }

  setSiteSetting(host, enabled) {
    const key = baseDomain((host || '').toLowerCase());
    if (!key) return;
    const all = this.settings.get('privacy.siteSettings') || {};
    all[key] = { ...(all[key] || {}), adblock: enabled };
    this.settings.set('privacy.siteSettings', all);
    this.engine._cache.clear(); // Site policy is not part of the cache key.
    return this.siteSetting(host);
  }

  /** Is blocking active for a given top-level page? */
  activeForPage(pageUrl) {
    if (!this.features.enabled('adblock')) return false;
    if (!pageUrl) return this.settings.get('privacy.adblock');
    let host;
    try {
      host = new URL(pageUrl).hostname;
    } catch {
      return this.settings.get('privacy.adblock');
    }
    return this.siteSetting(host) === 'on';
  }

  // ---- request filtering ----------------------------------------------

  /**
   * Attach the blocker to an Electron session, through the shared
   * `webRequest` hub. Registered as a profile configurator so every profile
   * — including incognito contexts created later — is covered.
   *
   * Blocking runs at the lowest priority number, i.e. first: there is no
   * point upgrading, tunnelling or rewriting a request that is about to be
   * cancelled.
   *
   * @param {Electron.Session} sess
   * @param {(tabId:number) => string|undefined} resolvePageUrl
   */
  attach(sess, resolvePageUrl = () => undefined) {
    hubFor(sess).register('onBeforeRequest', 'adblock', PRIORITY.ADBLOCK, (details) => {
      // Fail open: a blocker bug must never make the browser unusable.
      try {
        if (this._shouldBlock(details, resolvePageUrl)) {
          this._record(details);
          return { cancel: true };
        }
      } catch (err) {
        log.error(`filter error on ${details.url}: ${err.message}`);
      }
      return null;
    });
  }

  _shouldBlock(details, resolvePageUrl) {
    if (!this.ready || !this.features.enabled('adblock')) return false;

    let url;
    try {
      url = new URL(details.url);
    } catch {
      return false;
    }
    if (INTERNAL_SCHEMES.has(url.protocol)) return false;

    // The page the request belongs to decides the per-site policy. Prefer
    // Chromium's own frame URL, falling back to the tab's committed URL.
    const pageUrl = details.frame?.url || resolvePageUrl(details.webContentsId) || details.referrer || '';

    // Never filter a top-level navigation: blocking the document itself
    // would strand the user on a blank page rather than a blocked ad.
    if (details.resourceType === 'mainFrame') return false;

    if (!this.activeForPage(pageUrl)) return false;

    const verdict = this.engine.match({
      url: details.url,
      sourceUrl: pageUrl,
      type: details.resourceType || 'other',
    });

    if (!verdict.block && this.settings.get('privacy.adblockAggressive')) {
      // Aggressive mode additionally drops known first-party analytics
      // beacons that the standard lists scope to third-party only.
      if (details.resourceType === 'ping' || details.resourceType === 'cspReport') return true;
    }
    return verdict.block;
  }

  _record(details) {
    this.totals.blocked++;
    this._totalsStore.save();

    const tabId = details.webContentsId;
    if (tabId == null) return;
    let entry = this.tabCounts.get(tabId);
    if (!entry) {
      entry = { count: 0, byHost: new Map() };
      this.tabCounts.set(tabId, entry);
    }
    entry.count++;
    try {
      const host = new URL(details.url).hostname;
      entry.byHost.set(host, (entry.byHost.get(host) || 0) + 1);
    } catch { /* ignore unparseable */ }

    // Coalesce badge updates: a page load can block hundreds of requests and
    // we do not want hundreds of IPC messages competing with rendering.
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.emit('count', this.statsForTab(tabId));
      }, 120);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  /** Reset a tab's counter when it navigates to a new document. */
  resetTab(tabId) {
    this.tabCounts.delete(tabId);
    this.emit('count', this.statsForTab(tabId));
  }

  statsForTab(tabId) {
    const entry = this.tabCounts.get(tabId);
    return {
      tabId,
      count: entry ? entry.count : 0,
      topHosts: entry
        ? [...entry.byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
            .map(([host, n]) => ({ host, count: n }))
        : [],
      lifetime: this.totals.blocked,
      since: this.totals.since,
      // Surfaced so the shield can say protection is limited rather than
      // showing a confident zero. "Nothing blocked" and "nothing loaded to
      // block with" look identical to a user, and only one of them is fine.
      seedOnly: this.usingSeed,
    };
  }

  /** Cosmetic selectors for a page, handed to the content preload. */
  cosmeticFor(pageUrl) {
    if (!this.activeForPage(pageUrl)) return [];
    try {
      return this.engine.cosmeticFor(new URL(pageUrl).hostname.toLowerCase());
    } catch {
      return [];
    }
  }
}

module.exports = { AdblockService, DEFAULT_LISTS };
