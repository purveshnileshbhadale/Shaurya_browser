'use strict';
/**
 * Omnibox: turning what the user typed into either a navigation or a search,
 * plus the ranked suggestion list.
 *
 * The URL-vs-search decision is the part people notice when it is wrong.
 * Typing `localhost:3000` must navigate; typing `how to center a div` must
 * search; `example.com` must navigate; `what is 2+2` must search even though
 * it contains no space after the last dot.
 */
const EventEmitter = require('node:events');
const { request } = require('../util/net');
const { createLogger } = require('../util/logger');

const log = createLogger('omnibox');

/** Schemes we will navigate to directly. */
const KNOWN_SCHEMES = /^(https?|ftp|file|shaurya|chrome-extension|data|blob|mailto|view-source):/i;

/** A conservative list; anything else needs a dot-plus-known-TLD shape. */
const COMMON_TLDS = new Set([
  'com', 'org', 'net', 'io', 'dev', 'app', 'co', 'ai', 'sh', 'me', 'gg',
  'edu', 'gov', 'mil', 'int', 'info', 'biz', 'xyz', 'tech', 'cloud', 'page',
  'uk', 'de', 'fr', 'nl', 'jp', 'cn', 'in', 'au', 'ca', 'br', 'ru', 'se',
  'no', 'fi', 'dk', 'es', 'it', 'pl', 'ch', 'at', 'be', 'nz', 'za', 'ie',
]);

class SearchService extends EventEmitter {
  constructor(settings, history, bookmarks) {
    super();
    this.settings = settings;
    this.history = history;
    this.bookmarks = bookmarks;
  }

  // ---- resolution ------------------------------------------------------

  /**
   * Decide what the address bar input means.
   * @param {string} input
   * @returns {{kind:'url'|'search', url:string, display:string}}
   */
  resolve(input) {
    const raw = String(input || '').trim();
    if (!raw) return { kind: 'url', url: 'shaurya://start', display: '' };

    // An explicit scheme is decisive.
    if (KNOWN_SCHEMES.test(raw)) {
      return { kind: 'url', url: raw, display: raw };
    }

    // Anything with whitespace is a query — `example.com and stuff` is not
    // a hostname anyone means to visit.
    if (/\s/.test(raw)) return this._asSearch(raw);

    // `localhost`, `localhost:3000`, `127.0.0.1:8080`, `[::1]:80`
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(raw)) {
      return { kind: 'url', url: `http://${raw}`, display: raw };
    }

    // Bare IPv4, optionally with port/path.
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) {
      return { kind: 'url', url: `http://${raw}`, display: raw };
    }

    // host:port with a plausible hostname.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+(\/|$)/i.test(raw)) {
      return { kind: 'url', url: `http://${raw}`, display: raw };
    }

    // A dotted name whose last label is a known TLD.
    const hostPart = raw.split(/[/?#]/)[0];
    const labels = hostPart.split('.');
    if (labels.length >= 2 && !hostPart.endsWith('.')) {
      const tld = labels[labels.length - 1].toLowerCase();
      const looksLikeHost = labels.every((l) => /^[a-z0-9-]+$/i.test(l) && l.length > 0);
      if (looksLikeHost && (COMMON_TLDS.has(tld) || /^[a-z]{2}$/.test(tld))) {
        return { kind: 'url', url: `https://${raw}`, display: raw };
      }
    }

    return this._asSearch(raw);
  }

  _asSearch(query) {
    const engineId = this.settings.get('search.engine');
    const engine = this.settings.get(`search.engines.${engineId}`)
      || this.settings.get('search.engines.duckduckgo');
    return {
      kind: 'search',
      url: engine.url.replace('%s', encodeURIComponent(query)),
      display: query,
      engine: engine.name,
    };
  }

  // ---- suggestions -----------------------------------------------------

  /**
   * Ranked suggestions for the dropdown: what the input resolves to, plus
   * matching history, bookmarks and open tabs.
   *
   * @param {{query:string, openTabs?:Array}} opts
   */
  async suggest({ query, openTabs = [] } = {}) {
    const raw = String(query || '').trim();
    if (!raw) return [];

    const out = [];
    const resolved = this.resolve(raw);

    out.push({
      kind: resolved.kind === 'url' ? 'navigate' : 'search',
      title: resolved.kind === 'url' ? raw : `Search for “${raw}”`,
      subtitle: resolved.kind === 'url' ? resolved.url : resolved.engine,
      url: resolved.url,
      score: 1000,
      icon: resolved.kind === 'url' ? 'globe' : 'search',
    });

    // Already-open tabs first: switching beats opening a duplicate.
    const lower = raw.toLowerCase();
    for (const tab of openTabs) {
      if (!tab.url || tab.url.startsWith('shaurya://start')) continue;
      const hay = `${tab.title} ${tab.url}`.toLowerCase();
      if (!hay.includes(lower)) continue;
      out.push({
        kind: 'tab',
        title: tab.title || tab.url,
        subtitle: 'Switch to open tab',
        url: tab.url,
        tabId: tab.id,
        score: 900,
        icon: 'tab',
      });
    }

    for (const b of this.bookmarks.list()) {
      const hay = `${b.title} ${b.url}`.toLowerCase();
      if (!hay.includes(lower)) continue;
      out.push({
        kind: 'bookmark',
        title: b.title,
        subtitle: b.url,
        url: b.url,
        score: 800,
        icon: 'star',
      });
      if (out.length > 30) break;
    }

    for (const h of this.history.query({ query: raw, limit: 12 })) {
      out.push({
        kind: 'history',
        title: h.title,
        subtitle: h.url,
        url: h.url,
        // History rows carry their own frecency; fold it in so a daily site
        // outranks a bookmark the user never opens.
        score: 400 + Math.min(300, h.score),
        icon: 'clock',
      });
    }

    // Optional network suggestions, off by default since they leak keystrokes.
    if (this.settings.get('search.suggestionsEnabled')) {
      for (const s of await this._remoteSuggestions(raw)) {
        out.push({
          kind: 'search',
          title: s,
          subtitle: 'Search suggestion',
          url: this._asSearch(s).url,
          score: 500,
          icon: 'search',
        });
      }
    }

    // De-duplicate strictly by destination URL, keeping the highest-scoring
    // entry. Keying open tabs separately would show the same page twice —
    // once as "switch to tab" and once as a history row — which is exactly
    // the omnibox clutter this list exists to avoid. Because the tab entry
    // scores highest, the surviving row is the one that switches rather than
    // opening a duplicate.
    const best = new Map();
    for (const item of out) {
      const key = normaliseForDedupe(item.url);
      const existing = best.get(key);
      if (!existing || item.score > existing.score) best.set(key, item);
    }

    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  }

  async _remoteSuggestions(query) {
    const engineId = this.settings.get('search.engine');
    const engine = this.settings.get(`search.engines.${engineId}`);
    if (!engine?.suggest) return [];
    try {
      const res = await request(engine.suggest.replace('%s', encodeURIComponent(query)), {
        timeout: 2500,
        limit: 256 * 1024,
      });
      if (res.status !== 200) return [];
      const parsed = JSON.parse(res.body.toString('utf8'));
      // OpenSearch format: [query, [suggestions...]]
      const list = Array.isArray(parsed) ? parsed[1] : [];
      return (Array.isArray(list) ? list : []).slice(0, 5);
    } catch (err) {
      log.debug(`suggestion fetch failed: ${err.message}`);
      return [];
    }
  }
}

/**
 * Collapse URLs that mean the same page for suggestion purposes: a trailing
 * slash and a `www.` prefix should not produce two rows.
 */
function normaliseForDedupe(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return url;
  }
}

module.exports = { SearchService, COMMON_TLDS, normaliseForDedupe };
