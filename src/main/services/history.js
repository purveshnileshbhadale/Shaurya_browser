'use strict';
/**
 * Browsing history.
 *
 * Stored locally, never uploaded except through the end-to-end encrypted
 * sync path where the server sees only ciphertext. Incognito tabs are
 * excluded at the call site — nothing private ever reaches this store.
 */
const EventEmitter = require('node:events');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { createLogger } = require('../util/logger');

const log = createLogger('history');

/** Entries older than this are pruned on startup. */
const RETENTION_DAYS = 180;
const MAX_ENTRIES = 50000;

class HistoryService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.store = new JsonStore(paths.historyFile(), { entries: [] }, 2000);
    /** url -> entry, for O(1) visit-count updates. */
    this._byUrl = new Map();
    this._reindex();
    this._prune();
  }

  _reindex() {
    this._byUrl.clear();
    for (const e of this.store.data.entries) this._byUrl.set(e.url, e);
  }

  _prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    const before = this.store.data.entries.length;
    let entries = this.store.data.entries.filter((e) => e.lastVisit >= cutoff);
    if (entries.length > MAX_ENTRIES) {
      // Keep the most recently visited; frecency ranking uses recency anyway.
      entries.sort((a, b) => b.lastVisit - a.lastVisit);
      entries = entries.slice(0, MAX_ENTRIES);
    }
    if (entries.length !== before) {
      this.store.data.entries = entries;
      this.store.save();
      this._reindex();
      log.info(`pruned ${before - entries.length} history entries`);
    }
  }

  /**
   * Record a visit.
   * @param {{url:string,title?:string,incognito?:boolean,transition?:string}} visit
   */
  record({ url, title, incognito = false, transition = 'link' }) {
    if (incognito) return null;
    if (!this.features.enabled('history')) return null;
    if (!url || !/^https?:/.test(url)) return null; // internal pages are not history

    const existing = this._byUrl.get(url);
    if (existing) {
      existing.visits += 1;
      existing.lastVisit = Date.now();
      if (title) existing.title = title;
    } else {
      const entry = {
        url,
        title: title || url,
        visits: 1,
        firstVisit: Date.now(),
        lastVisit: Date.now(),
        transition,
      };
      this.store.data.entries.push(entry);
      this._byUrl.set(url, entry);
    }
    this.store.save();
    return this._byUrl.get(url);
  }

  /** Update the title once the page reports one. */
  setTitle(url, title) {
    const entry = this._byUrl.get(url);
    if (entry && title) {
      entry.title = title;
      this.store.save();
    }
  }

  /**
   * Search history, ranked by "frecency" — Firefox's term for combining how
   * often and how recently a page was visited. A site visited 40 times last
   * month should not outrank one visited twice this morning.
   *
   * @param {{query?:string, limit?:number, since?:number}} opts
   */
  query({ query = '', limit = 100, since = 0 } = {}) {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const results = [];

    for (const e of this.store.data.entries) {
      if (e.lastVisit < since) continue;
      let score = 0;
      if (q) {
        const url = e.url.toLowerCase();
        const title = (e.title || '').toLowerCase();
        if (url.includes(q)) score += 40;
        if (title.includes(q)) score += 60;
        // Prefix matches on the hostname are what people usually mean.
        try {
          if (new URL(e.url).hostname.toLowerCase().startsWith(q)) score += 80;
        } catch { /* malformed stored URL */ }
        if (score === 0) continue;
      }
      const ageDays = (now - e.lastVisit) / 86400_000;
      const recency = 100 / (1 + ageDays);          // decays smoothly
      const frequency = Math.log2(1 + e.visits) * 20;
      results.push({ ...e, score: score + recency + frequency });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Most-visited sites, used to seed the start page's speed dial. */
  topSites(limit = 10) {
    const byHost = new Map();
    for (const e of this.store.data.entries) {
      let host;
      try { host = new URL(e.url).hostname; } catch { continue; }
      const current = byHost.get(host);
      if (!current || e.visits > current.visits) byHost.set(host, e);
    }
    return [...byHost.values()]
      .sort((a, b) => b.visits - a.visits)
      .slice(0, limit)
      .map((e) => ({ url: e.url, title: e.title, visits: e.visits }));
  }

  remove(urls) {
    const set = new Set(Array.isArray(urls) ? urls : [urls]);
    this.store.data.entries = this.store.data.entries.filter((e) => !set.has(e.url));
    this._reindex();
    this.store.save();
    this.emit('changed');
    return true;
  }

  /** @param {{since?:number}} opts  omit `since` to clear everything */
  clear({ since } = {}) {
    if (since) {
      this.store.data.entries = this.store.data.entries.filter((e) => e.lastVisit < since);
    } else {
      this.store.data.entries = [];
    }
    this._reindex();
    this.store.save();
    this.emit('changed');
    log.info(since ? `cleared history since ${new Date(since).toISOString()}` : 'cleared all history');
    return true;
  }

  /** Everything the sync engine needs to serialise. */
  exportAll() {
    return this.store.data.entries;
  }

  importAll(entries) {
    for (const e of entries) {
      const existing = this._byUrl.get(e.url);
      if (!existing) {
        this.store.data.entries.push(e);
        this._byUrl.set(e.url, e);
      } else if (e.lastVisit > existing.lastVisit) {
        // Last-write-wins per entry, with visit counts merged rather than
        // overwritten so two devices' counts add up instead of racing.
        existing.lastVisit = e.lastVisit;
        existing.visits = Math.max(existing.visits, e.visits);
        existing.title = e.title || existing.title;
      }
    }
    this.store.save();
    this.emit('changed');
  }

  flush() {
    this.store.flush();
  }
}

module.exports = { HistoryService };
