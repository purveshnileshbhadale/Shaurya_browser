'use strict';
/**
 * Promise wrapper over node:https with the two things Shaurya always needs:
 * a hard timeout and a byte cap. Filter lists, breach checks and AI calls
 * all go through here so no single fetch can wedge or balloon the main
 * process.
 */
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_LIMIT = 32 * 1024 * 1024; // 32 MiB — big enough for filter lists

/**
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|Buffer,
 *          timeout?:number, limit?:number, agent?:any}} [opts]
 * @returns {Promise<{status:number, headers:object, body:Buffer, timing:object}>}
 */
function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 20000,
    limit = DEFAULT_LIMIT,
    agent,
  } = opts;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`invalid URL: ${url}`));
    }
    const mod = parsed.protocol === 'http:' ? http : https;
    const t0 = process.hrtime.bigint();
    let tConnect = null;
    let tFirstByte = null;

    const req = mod.request(
      parsed,
      { method, headers, agent, timeout },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (tFirstByte === null) tFirstByte = process.hrtime.bigint();
          size += chunk.length;
          if (size > limit) {
            req.destroy(new Error(`response exceeded ${limit} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const t1 = process.hrtime.bigint();
          const ms = (a, b) => (a === null || b === null ? null : Number(b - a) / 1e6);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: res.headers,
            body: Buffer.concat(chunks),
            timing: {
              total: ms(t0, t1),
              connect: ms(t0, tConnect),
              ttfb: ms(t0, tFirstByte),
              download: ms(tFirstByte, t1),
            },
          });
        });
      }
    );

    req.on('socket', (sock) => {
      sock.on('connect', () => { tConnect = process.hrtime.bigint(); });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Convenience: request() + JSON parse, throwing on non-2xx. */
async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return JSON.parse(res.body.toString('utf8'));
}

module.exports = { request, getJson };
