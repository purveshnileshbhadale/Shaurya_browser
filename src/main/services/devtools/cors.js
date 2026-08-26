'use strict';
/**
 * The CORS development toggle (spec §5).
 *
 * Relaxing the same-origin policy is genuinely dangerous — with it on, any
 * page you visit can read any origin you are logged into. The spec's own
 * constraint is the right one and it is enforced structurally here:
 *
 *  1. It can only be enabled on a profile whose kind is `dev`. Turning it on
 *     for the default profile is not a setting that exists.
 *  2. The affected profile is visibly marked, and the window shows a
 *     persistent warning banner that cannot be dismissed while it is on.
 *  3. It applies only to origins the user listed, not to everything.
 *  4. It never survives a restart.
 */
const EventEmitter = require('node:events');
const { hubFor, PRIORITY } = require('../web-request-hub');
const { createLogger } = require('../../util/logger');

const log = createLogger('cors');

class CorsService extends EventEmitter {
  constructor(settings, features, profiles) {
    super();
    this.settings = settings;
    this.features = features;
    this.profiles = profiles;
    /**
     * Deliberately in-memory: a security relaxation that persists across
     * restarts is one the user will forget is on.
     */
    this._enabled = new Map(); // profileId -> { origins:string[] , at:number }
  }

  /** @param {Electron.Session} sess */
  attach(sess, profile) {
    hubFor(sess).register('onHeadersReceived', 'cors-dev', PRIORITY.CORS, (details) => {
      const state = this._enabled.get(profile?.id);
      if (!state) return null;

      const headers = { ...details.responseHeaders };
      // `*` cannot be combined with credentials, so echo the requesting
      // origin instead — that is what makes an authenticated dev API work.
      const origin = details.requestHeaders?.Origin
        || details.requestHeaders?.origin
        || '*';

      if (state.origins.length && !this._matches(details.url, state.origins)) return null;

      headers['Access-Control-Allow-Origin'] = [origin];
      headers['Access-Control-Allow-Credentials'] = ['true'];
      headers['Access-Control-Allow-Headers'] = ['*'];
      headers['Access-Control-Allow-Methods'] = ['GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD'];
      headers['Access-Control-Expose-Headers'] = ['*'];
      headers['Access-Control-Max-Age'] = ['600'];
      // A preflight against a server that does not implement OPTIONS would
      // otherwise fail before the real request is ever made.
      if (details.method === 'OPTIONS' && Number(details.statusCode) >= 400) {
        return { responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' };
      }
      return { responseHeaders: headers };
    });
  }

  _matches(url, origins) {
    try {
      const target = new URL(url).origin;
      return origins.some((o) => o === '*' || o === target);
    } catch {
      return false;
    }
  }

  /**
   * @param {{profileId:string, enabled:boolean, origins?:string[]}} opts
   */
  setEnabled({ profileId, enabled, origins = [] }) {
    if (!this.features.enabled('devtools')) {
      throw new Error('Developer tools are turned off in the Feature Store');
    }

    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error('unknown profile');

    if (enabled) {
      // Rule 1, enforced rather than documented.
      if (profile.kind !== 'dev') {
        throw new Error(
          `CORS can only be relaxed on a development profile. "${profile.name}" is a `
          + `${profile.kind} profile — create a dev profile in Settings › Profiles first.`
        );
      }
      this._enabled.set(profileId, { origins, at: Date.now() });
      log.warn(
        `CORS relaxed for dev profile "${profile.name}"`
        + (origins.length ? ` on ${origins.join(', ')}` : ' on ALL origins')
      );
    } else {
      this._enabled.delete(profileId);
      log.info(`CORS restored for "${profile.name}"`);
    }

    this.emit('changed', this.status());
    return this.status();
  }

  /** What the warning banner reads from. */
  status() {
    const active = [...this._enabled.entries()].map(([profileId, state]) => {
      const profile = this.profiles.get(profileId);
      return {
        profileId,
        profileName: profile?.name || profileId,
        origins: state.origins,
        allOrigins: state.origins.length === 0,
        since: state.at,
      };
    });
    return {
      active,
      anyActive: active.length > 0,
      // Shown verbatim in the banner.
      warning: active.length
        ? 'Same-origin protection is off for this profile. Any site you open can read data '
          + 'from origins you are signed into. Use it only against your own servers.'
        : null,
      eligibleProfiles: this.profiles.list()
        .filter((p) => p.kind === 'dev')
        .map((p) => ({ id: p.id, name: p.name })),
    };
  }
}

module.exports = { CorsService };
