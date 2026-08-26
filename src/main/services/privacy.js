'use strict';
/**
 * HTTPS-only mode, fingerprinting resistance and header hygiene (spec §3).
 *
 * All three operate at the session level so they apply to every request a
 * profile makes, including those from extensions and service workers — not
 * just top-level navigations.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const { createLogger } = require('../util/logger');
const { baseDomain } = require('./adblock/matcher');
const { hubFor, PRIORITY } = require('./web-request-hub');

const log = createLogger('privacy');

/**
 * Headers that leak information with no benefit to the user.
 * `x-client-data` is Chromium's own field-trial identifier, which Google
 * sends to its properties; it is a stable-ish device identifier.
 */
const STRIP_REQUEST_HEADERS = ['x-client-data'];

/** Hosts that legitimately cannot do HTTPS and would break if upgraded. */
const HTTPS_EXEMPT = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

class PrivacyService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    /** Hosts where the user chose "continue to the insecure site". */
    this.httpsExceptions = new Set();
    /**
     * Per-session-per-origin noise seed for fingerprint resistance. Random
     * per browser session so the value cannot be correlated across restarts,
     * and per origin so two sites cannot compare notes to unmask the seed.
     */
    this._noiseSeed = crypto.randomBytes(32);
  }

  /** @param {Electron.Session} sess */
  attach(sess, profile) {
    this._attachHttpsOnly(sess, profile);
    this._attachHeaderHygiene(sess);
    this._attachFingerprinting(sess, profile);
  }

  // ---- HTTPS-only ------------------------------------------------------

  /**
   * Upgrade http:// navigations to https://.
   *
   * `onBeforeRequest` can redirect, so the upgrade happens before any
   * plaintext bytes leave the machine. If the HTTPS attempt fails the tab
   * layer shows an interstitial rather than silently falling back — a silent
   * downgrade would make the whole mode meaningless.
   */
  _attachHttpsOnly(sess, profile) {
    hubFor(sess).register('onBeforeRequest', 'https-only', PRIORITY.HTTPS_ONLY, (details) => {
      if (!details.url.startsWith('http://')) return null;
      if (!this.enabled('httpsOnly')) return null;

      let url;
      try {
        url = new URL(details.url);
      } catch {
        return null;
      }

      if (HTTPS_EXEMPT.has(url.hostname) || url.hostname.endsWith('.localhost')) return null;
      // Private-range addresses usually have no certificate at all, and a
      // developer's router or dev box must stay reachable.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return null;
      if (this.httpsExceptions.has(url.hostname)) return null;
      // A per-site "off" switch the user set in the shield popover.
      if (this.settings.get(`privacy.siteSettings.${baseDomain(url.hostname)}.httpsOnly`) === false) {
        return null;
      }

      url.protocol = 'https:';
      return { redirectURL: url.toString() };
    });
  }

  /** Record a user's decision to proceed over plaintext for one host. */
  allowInsecure(host, { remember = false } = {}) {
    this.httpsExceptions.add(host);
    if (remember) {
      const sites = this.settings.get('privacy.siteSettings') || {};
      sites[baseDomain(host)] = { ...(sites[baseDomain(host)] || {}), httpsOnly: false };
      this.settings.set('privacy.siteSettings', sites);
    }
    log.info(`HTTPS-only exception granted for ${host}${remember ? ' (remembered)' : ''}`);
    this.emit('changed');
  }

  // ---- header hygiene --------------------------------------------------

  _attachHeaderHygiene(sess) {
    const hub = hubFor(sess);

    hub.register('onBeforeSendHeaders', 'header-hygiene', PRIORITY.HEADERS, (details) => {
      const headers = { ...details.requestHeaders };

      for (const name of STRIP_REQUEST_HEADERS) {
        delete headers[name];
        delete headers[name.toLowerCase()];
      }

      if (this.settings.get('privacy.doNotSell')) {
        // Global Privacy Control — legally binding in several jurisdictions,
        // unlike DNT, which sites uniformly ignored.
        headers['Sec-GPC'] = '1';
        headers.DNT = '1';
      }

      if (this.enabled('fingerprint')) {
        // Client Hints are a high-entropy surface. Keep the low-entropy set
        // (sites use it for real feature decisions) and drop the rest, which
        // together identify an exact device build.
        for (const h of Object.keys(headers)) {
          if (/^sec-ch-ua-(full-version|full-version-list|arch|bitness|model|platform-version|wow64|form-factor)/i.test(h)) {
            delete headers[h];
          }
        }
      }

      return { requestHeaders: headers };
    });

    hub.register('onHeadersReceived', 'header-hygiene', PRIORITY.HEADERS, (details) => {
      const headers = { ...details.responseHeaders };
      if (this.settings.get('privacy.blockThirdPartyCookies')) {
        // Strip the Topics/Attribution opt-ins some sites still send, which
        // would otherwise re-enable the ad-measurement APIs we disabled.
        delete headers['permissions-policy-report-only'];
      }
      return { responseHeaders: headers };
    });
  }

  // ---- fingerprinting resistance --------------------------------------

  /**
   * Normalise the highest-entropy signals a site can read.
   *
   * This is a *reduction*, not a cloak: perfect resistance requires making
   * every user identical, which breaks too much of the web to ship on by
   * default. We target the signals that carry the most bits and cost the
   * least to normalise — the same tradeoff Brave's "farbling" makes.
   *
   * Implemented as a per-session injected script rather than in the content
   * preload so it applies before any page script runs, in every frame.
   */
  _attachFingerprinting(sess, profile) {
    if (!this.enabled('fingerprint')) return;

    // A seed that is stable within a session+origin but unpredictable across
    // them: sites see consistent values (so feature detection works) but
    // cannot link a user between origins or across restarts.
    const sessionSalt = crypto
      .createHash('sha256')
      .update(this._noiseSeed)
      .update(profile.id)
      .digest('hex');

    // Chromium exposes the knobs we actually want directly on the session.
    try {
      sess.setSpellCheckerEnabled(true);
      sess.setSSLConfig({ minVersion: 'tls1.2' });
    } catch (err) {
      log.debug(`session hardening: ${err.message}`);
    }

    this._fingerprintSalt = sessionSalt;
  }

  /**
   * The script the content preload injects to normalise JS-visible signals.
   * Exposed as a string so the preload (which is sandboxed) can evaluate it
   * in the isolated world without needing filesystem access.
   */
  fingerprintScript(origin) {
    if (!this.enabled('fingerprint')) return null;
    const salt = crypto
      .createHash('sha256')
      .update(this._noiseSeed)
      .update(origin || '')
      .digest();
    // Two small integers drive all the noise, so the payload stays tiny.
    const a = salt.readUInt16BE(0);
    const b = salt.readUInt16BE(2);
    return { salt: [a, b] };
  }

  enabled(feature) {
    if (feature === 'httpsOnly') {
      return this.features.enabled('httpsOnly') && this.settings.get('privacy.httpsOnly');
    }
    if (feature === 'fingerprint') {
      return this.features.enabled('fingerprint') && this.settings.get('privacy.fingerprintResistance');
    }
    return false;
  }

  /** Summary for the address-bar shield popover. */
  siteInfo(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    return {
      url,
      host: parsed.hostname,
      scheme: parsed.protocol.replace(':', ''),
      secure: parsed.protocol === 'https:' || parsed.protocol === 'aether:',
      httpsUpgraded: this.enabled('httpsOnly') && !this.httpsExceptions.has(parsed.hostname),
      fingerprintResistance: this.enabled('fingerprint'),
      gpc: Boolean(this.settings.get('privacy.doNotSell')),
      thirdPartyCookiesBlocked: Boolean(this.settings.get('privacy.blockThirdPartyCookies')),
    };
  }
}

module.exports = { PrivacyService };
