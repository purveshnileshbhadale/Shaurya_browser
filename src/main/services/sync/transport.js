'use strict';
/**
 * Sync transport.
 *
 * Speaks a deliberately small REST protocol so that self-hosting is
 * realistic — the server is a key-value store with a change cursor and
 * nothing else. It never sees a key, so it needs no crypto of its own:
 *
 *   GET  /v1/records?since=<cursor>   -> { records:[{id,collection,ciphertext,updatedAt,deleted}], cursor }
 *   POST /v1/records                  <- { records:[...] }             -> { cursor }
 *   GET  /v1/account                  -> { salt, createdAt, devices }
 *   POST /v1/account                  <- { salt }                      -> { created:true }
 *
 * Authentication is an HMAC proof over the request, so no bearer token is
 * stored anywhere and a captured request cannot be replayed.
 */
const { request } = require('../../util/net');
const { authProof } = require('./crypto');
const { createLogger } = require('../../util/logger');

const log = createLogger('sync:transport');

/** Requests older than this are rejected by a well-behaved server. */
const PROOF_WINDOW_MS = 5 * 60 * 1000;

class SyncTransport {
  /**
   * @param {string} endpoint
   * @param {object} keys  from crypto.deriveKeys()
   */
  constructor(endpoint, keys) {
    this.endpoint = String(endpoint || '').replace(/\/$/, '');
    this.keys = keys;
  }

  async _call(method, path, body) {
    if (!this.endpoint) throw new Error('no sync endpoint configured');

    const payload = body ? JSON.stringify(body) : '';
    const proof = authProof(this.keys, { method, path, body: payload });

    const res = await request(this.endpoint + path, {
      method,
      timeout: 30000,
      headers: {
        'content-type': 'application/json',
        'x-shaurya-account': proof.account,
        'x-shaurya-timestamp': String(proof.timestamp),
        'x-shaurya-signature': proof.signature,
        'x-shaurya-proof-window': String(PROOF_WINDOW_MS),
      },
      body: payload || undefined,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('the sync server rejected this device\'s credentials');
    }
    if (res.status === 404 && path.startsWith('/v1/account')) {
      return null; // no account yet; the caller creates one
    }
    if (res.status === 409) {
      throw new Error('another device changed these records first — retrying');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`sync server returned HTTP ${res.status}`);
    }

    const text = res.body.toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  /** Look up the account, returning null when it does not exist yet. */
  account() {
    return this._call('GET', '/v1/account');
  }

  createAccount(salt) {
    return this._call('POST', '/v1/account', { salt: salt.toString('base64') });
  }

  /**
   * Fetch everything changed since a cursor.
   * @returns {Promise<{records:Array, cursor:string}>}
   */
  pull(cursor) {
    const query = cursor ? `?since=${encodeURIComponent(cursor)}` : '';
    return this._call('GET', `/v1/records${query}`);
  }

  /**
   * Push sealed records. Batched by the caller.
   * @returns {Promise<{cursor:string}>}
   */
  push(records) {
    return this._call('POST', '/v1/records', { records });
  }

  /** Liveness check used by the settings screen. */
  async probe() {
    try {
      const res = await request(`${this.endpoint}/v1/health`, { timeout: 5000 });
      return { reachable: res.status < 500, status: res.status };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }
}

module.exports = { SyncTransport, PROOF_WINDOW_MS };
