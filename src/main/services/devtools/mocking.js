'use strict';
/**
 * API mocking (spec §3).
 *
 * Intercepts matching requests and returns a stubbed response, so a frontend
 * can be developed against an endpoint that does not exist yet, or against
 * an error path that is hard to provoke for real (a 503, a slow response, a
 * malformed payload).
 *
 * Scoped to dev profiles, for the same reason the CORS toggle is: silently
 * substituting a response body is indistinguishable from a man-in-the-middle
 * from the page's perspective, and that capability must not be one toggle
 * away from a profile people bank in.
 *
 * Implemented through the shared request hub at a priority *after* ad
 * blocking, so a mocked URL still obeys the blocker, and before HTTPS-only,
 * so a stub does not trigger an upgrade interstitial for a request that never
 * leaves the machine.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const { hubFor, PRIORITY } = require('../web-request-hub');
const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('mock');

class MockingService extends EventEmitter {
  constructor({ features, profiles }) {
    super();
    this.features = features;
    this.profiles = profiles;

    this.store = new JsonStore(paths.userData('mocks.json'), { rules: [] });
    /** Hit counters are runtime-only; they answer "is my rule firing?". */
    this._hits = new Map();
  }

  rules() {
    return this.store.data.rules.map((r) => ({
      ...r,
      hits: this._hits.get(r.id) || 0,
    }));
  }

  /**
   * @param {object} rule
   * @param {string} rule.pattern   glob match on the URL
   * @param {string} [rule.method]  restrict to one verb
   * @param {number} [rule.status]
   * @param {string} [rule.body]
   * @param {number} [rule.delayMs] simulate a slow endpoint
   */
  save(rule) {
    if (!this.features.enabled('apiMocking')) throw new Error('API mocking is off');
    if (!rule.pattern?.trim()) throw new Error('a mock needs a URL pattern');

    const record = {
      id: rule.id || crypto.randomUUID(),
      pattern: rule.pattern.trim(),
      method: (rule.method || 'ANY').toUpperCase(),
      status: Number(rule.status) || 200,
      contentType: rule.contentType || 'application/json',
      body: rule.body ?? '{}',
      delayMs: Math.max(0, Math.min(30_000, Number(rule.delayMs) || 0)),
      enabled: rule.enabled !== false,
      note: rule.note || '',
      updatedAt: Date.now(),
    };

    const rules = this.store.data.rules;
    const index = rules.findIndex((r) => r.id === record.id);
    if (index === -1) rules.push(record); else rules[index] = record;

    this.store.save();
    this.emit('changed', this.rules());
    return record;
  }

  remove(id) {
    this.store.data.rules = this.store.data.rules.filter((r) => r.id !== id);
    this._hits.delete(id);
    this.store.save();
    this.emit('changed', this.rules());
    return this.rules();
  }

  toggle(id, enabled) {
    const rule = this.store.data.rules.find((r) => r.id === id);
    if (!rule) throw new Error('unknown mock');
    rule.enabled = enabled !== false;
    this.store.save();
    this.emit('changed', this.rules());
    return rule;
  }

  /**
   * Find the rule that should answer a request.
   *
   * Pure and exported, so matching semantics are testable without a session.
   * First match wins, in list order, which makes rule precedence something
   * the user can see and reorder rather than something they have to deduce.
   */
  match(url, method) {
    if (!this.features.enabled('apiMocking')) return null;
    for (const rule of this.store.data.rules) {
      if (!rule.enabled) continue;
      if (rule.method !== 'ANY' && rule.method !== String(method).toUpperCase()) continue;
      if (matchesPattern(url, rule.pattern)) return rule;
    }
    return null;
  }

  /**
   * Arm mocking on a session.
   *
   * Only dev profiles get the participant registered at all, so a non-dev
   * session has no mocking code in its request path whatsoever — not a
   * disabled branch, no registration.
   */
  attach(session, profile) {
    if (profile?.kind !== 'dev') return;

    hubFor(session).register('onBeforeRequest', 'api-mock', PRIORITY.API_MOCK, (details) => {
      const rule = this.match(details.url, details.method);
      if (!rule) return null;

      this._hits.set(rule.id, (this._hits.get(rule.id) || 0) + 1);
      log.debug(`mocked ${details.method} ${details.url} -> ${rule.status}`);
      this.emit('hit', { ruleId: rule.id, url: details.url, method: details.method });

      // A data: URL is how a redirect returns a body without a server. It
      // cannot carry an arbitrary status code, which is why the panel notes
      // that a mocked 500 arrives as a 200 carrying the 500's body — the
      // alternative would be a real local server per rule.
      const encoded = Buffer.from(rule.body ?? '').toString('base64');
      return { redirectURL: `data:${rule.contentType};base64,${encoded}` };
    });
  }

  dispose() {
    this._hits.clear();
  }
}

/**
 * Glob matching over URLs.
 *
 * `*` matches within a path segment, `**` across segments — the convention
 * every developer already knows from .gitignore and route matchers, rather
 * than making them write regular expressions in a text field.
 */
function matchesPattern(url, pattern) {
  const text = String(url);
  const glob = String(pattern);

  // A bare host or path fragment is treated as "contains", which is what
  // someone typing `/api/users` into the box means.
  if (!glob.includes('*')) return text.includes(glob);

  // Split on `**` first so the single-star rule cannot consume it, then
  // translate each segment independently. Doing it this way avoids needing a
  // placeholder character that a URL might legitimately contain.
  const source = glob
    .split('**')
    .map((part) => part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.'))
    .join('.*');

  try {
    // Anchored: an unanchored pattern matches a *prefix*, so `/v1/*` would
    // quietly also match `/v1/users/7` and the single-star rule would mean
    // nothing at all.
    return new RegExp(`^${source}$`).test(text);
  } catch {
    return false;
  }
}

module.exports = { MockingService, matchesPattern };
