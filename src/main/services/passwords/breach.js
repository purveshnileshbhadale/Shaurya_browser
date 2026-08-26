'use strict';
/**
 * Breach checking via Have I Been Pwned's k-anonymity range API.
 *
 * The protocol matters more than the feature here. We compute SHA-1 of the
 * password, send only the **first five hex characters** of that hash, and
 * receive every suffix sharing that prefix (typically 300–800 of them). The
 * comparison happens locally.
 *
 * Consequences worth being explicit about:
 *   - The service never receives the password, nor its full hash.
 *   - It cannot tell which of the returned suffixes was the one we wanted,
 *     so a match is not observable server-side.
 *   - SHA-1 is used because that is the corpus's format; it is a lookup key
 *     here, not a security primitive, so its collision weakness is
 *     irrelevant to this use.
 */
const crypto = require('node:crypto');
const { request } = require('../../util/net');
const { createLogger } = require('../../util/logger');

const log = createLogger('breach');

const API = 'https://api.pwnedpasswords.com/range/';
/** Range responses are stable; cache them for the session. */
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * How many times has this password appeared in a known breach?
 * @param {string} password
 * @returns {Promise<number>} 0 when not found, -1 when the check could not run
 */
async function checkPassword(password) {
  if (!password) return 0;

  const hash = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  let body = readCache(prefix);
  if (body === null) {
    try {
      const res = await request(API + prefix, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Aether-Browser',
          // Pads every response to a uniform size, so a network observer
          // cannot infer the prefix from the response length.
          'Add-Padding': 'true',
        },
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      body = res.body.toString('utf8');
      cache.set(prefix, { body, at: Date.now() });
    } catch (err) {
      log.warn(`breach lookup failed: ${err.message}`);
      return -1;
    }
  }

  for (const line of body.split('\n')) {
    const [candidate, count] = line.trim().split(':');
    if (candidate === suffix) return Number(count) || 0;
  }
  return 0;
}

function readCache(prefix) {
  const hit = cache.get(prefix);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  if (hit) cache.delete(prefix);
  return null;
}

/**
 * Check many passwords with bounded concurrency.
 *
 * Sequential checking of a 300-entry vault would take minutes; unbounded
 * parallelism would trip the API's rate limiter and return -1 for most of
 * them. Six at a time is comfortably within the published limits.
 *
 * @param {string[]} passwords
 * @returns {Promise<number[]>} counts, index-aligned with the input
 */
async function checkMany(passwords, { concurrency = 6 } = {}) {
  const results = new Array(passwords.length).fill(0);
  let cursor = 0;

  async function worker() {
    while (cursor < passwords.length) {
      const i = cursor++;
      results[i] = await checkPassword(passwords[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, passwords.length) }, worker)
  );
  return results;
}

module.exports = { checkPassword, checkMany };
