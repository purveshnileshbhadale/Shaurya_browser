'use strict';
/**
 * Multiplexer for Electron's `session.webRequest`.
 *
 * Electron keeps exactly **one** listener per event per session: calling
 * `onBeforeRequest` twice silently replaces the first registration. Shaurya
 * has five subsystems that all need a say in the request path — ad blocking,
 * HTTPS-only, the CORS dev toggle, the JSON viewer and the VPN — so
 * registering them directly would mean whichever service booted last was the
 * only one that worked, with no error to show for it.
 *
 * This hub owns the single real listener per event and fans out to ordered
 * participants, combining their verdicts with explicit precedence rules.
 */
const { createLogger } = require('../util/logger');

const log = createLogger('webrequest');

/**
 * Lower runs first. Blocking decisions want to happen before anything
 * spends effort on a request that is about to be cancelled.
 */
const PRIORITY = {
  // A site the user has blocked for themselves outranks everything: they
  // asked not to be able to reach it, and a filter-list decision should not
  // be able to let it through by answering first.
  FOCUS_BLOCK: 5,
  ADBLOCK: 10,
  // Mocking sits directly after blocking so a stubbed endpoint still obeys
  // the blocker, but is decided before any upgrade or tunnel work.
  API_MOCK: 15,
  HTTPS_ONLY: 20,
  VPN: 30,
  CORS: 40,
  JSON_VIEWER: 50,
  HEADERS: 60,
};

/** The events we multiplex, and how their results combine. */
const EVENTS = {
  onBeforeRequest: 'decision',
  onBeforeSendHeaders: 'requestHeaders',
  onHeadersReceived: 'responseHeaders',
  onCompleted: 'observe',
  onErrorOccurred: 'observe',
};

class WebRequestHub {
  /** @param {Electron.Session} session */
  constructor(session) {
    this.session = session;
    /** event -> [{priority, name, fn}] */
    this._participants = new Map();
    for (const event of Object.keys(EVENTS)) this._participants.set(event, []);
    this._installed = new Set();
  }

  /**
   * Register a participant.
   *
   * @param {keyof EVENTS} event
   * @param {string} name        for diagnostics
   * @param {number} priority    lower runs first; use the PRIORITY table
   * @param {Function} fn        synchronous; see combine rules below
   */
  register(event, name, priority, fn) {
    const list = this._participants.get(event);
    if (!list) throw new Error(`webRequestHub: unsupported event "${event}"`);
    list.push({ name, priority, fn });
    list.sort((a, b) => a.priority - b.priority);
    this._install(event);
  }

  _install(event) {
    if (this._installed.has(event)) return;
    this._installed.add(event);

    const kind = EVENTS[event];
    const filter = { urls: ['<all_urls>'] };

    if (kind === 'observe') {
      this.session.webRequest[event](filter, (details) => {
        for (const p of this._participants.get(event)) {
          try {
            p.fn(details);
          } catch (err) {
            log.error(`${p.name} threw in ${event}: ${err.message}`);
          }
        }
      });
      return;
    }

    this.session.webRequest[event](filter, (details, callback) => {
      try {
        callback(this._combine(event, kind, details));
      } catch (err) {
        // Fail open: a filter bug must never make the browser unusable.
        log.error(`${event} pipeline failed for ${details.url}: ${err.message}`);
        callback({});
      }
    });
  }

  /**
   * Run the chain and merge results.
   *
   *  - `decision` (onBeforeRequest): the first participant that returns
   *    `{cancel:true}` wins outright and short-circuits. A `{redirectURL}`
   *    also short-circuits, because Chromium restarts the request and the
   *    whole chain will run again against the new URL.
   *  - `requestHeaders` / `responseHeaders`: every participant sees the
   *    headers as mutated by the ones before it, so an "upgrade" and a
   *    "strip" can coexist.
   */
  _combine(event, kind, details) {
    if (kind === 'decision') {
      for (const p of this._participants.get(event)) {
        let result;
        try {
          result = p.fn(details);
        } catch (err) {
          log.error(`${p.name} threw in ${event}: ${err.message}`);
          continue;
        }
        if (!result) continue;
        if (result.cancel) {
          return { cancel: true };
        }
        if (result.redirectURL && result.redirectURL !== details.url) {
          return { redirectURL: result.redirectURL };
        }
      }
      return {};
    }

    const key = kind; // 'requestHeaders' | 'responseHeaders'
    let headers = { ...(details[key] || {}) };
    let statusLine;

    for (const p of this._participants.get(event)) {
      let result;
      try {
        result = p.fn({ ...details, [key]: headers });
      } catch (err) {
        log.error(`${p.name} threw in ${event}: ${err.message}`);
        continue;
      }
      if (!result) continue;
      if (result.cancel) return { cancel: true };
      if (result[key]) headers = result[key];
      if (result.statusLine) statusLine = result.statusLine;
    }

    const out = { [key]: headers };
    if (statusLine) out.statusLine = statusLine;
    return out;
  }

  /** Diagnostics for the about page. */
  describe() {
    const out = {};
    for (const [event, list] of this._participants) {
      if (list.length) out[event] = list.map((p) => `${p.priority}:${p.name}`);
    }
    return out;
  }
}

/**
 * One hub per session. Services call `hubFor(session)` rather than touching
 * `session.webRequest` directly.
 * @type {WeakMap<Electron.Session, WebRequestHub>}
 */
const hubs = new WeakMap();

function hubFor(session) {
  let hub = hubs.get(session);
  if (!hub) {
    hub = new WebRequestHub(session);
    hubs.set(session, hub);
  }
  return hub;
}

module.exports = { WebRequestHub, hubFor, PRIORITY };
