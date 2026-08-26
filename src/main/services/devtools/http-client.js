'use strict';
/**
 * Built-in REST/HTTP client (spec §5).
 *
 * The point of building this into the browser rather than reaching for
 * Postman is that it shares the browser's state: a request can be sent with
 * the cookies of the profile you are browsing in, which makes debugging an
 * authenticated API a two-click job instead of copying a session token by
 * hand.
 *
 * Requests run in the main process, so they are not subject to page CORS —
 * the same reason a dedicated API client exists at all.
 */
const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { uid } = require('../../util/id');
const { createLogger } = require('../../util/logger');

const log = createLogger('http-client');

/** Cap a response body so a stray `/dev/random` endpoint cannot exhaust RAM. */
const MAX_BODY = 64 * 1024 * 1024;

class HttpClientService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.store = new JsonStore(paths.collectionsFile(), {
      collections: [
        { id: 'default', name: 'Scratch', requests: [] },
      ],
      environments: [
        { id: 'local', name: 'Local', variables: { baseUrl: 'http://localhost:3000' } },
      ],
      activeEnvironment: 'local',
      history: [],
    });
    /** requestId -> ClientRequest, so an in-flight request can be cancelled. */
    this._inflight = new Map();
  }

  _check() {
    if (!this.features.enabled('httpClient')) {
      throw new Error('The REST client is turned off in the Feature Store');
    }
  }

  // ---- sending ---------------------------------------------------------

  /**
   * Send a request.
   *
   * @param {object} spec
   * @param {string} spec.method
   * @param {string} spec.url
   * @param {Record<string,string>} [spec.headers]
   * @param {string} [spec.body]
   * @param {object} [spec.auth]        { type:'bearer'|'basic'|'none', ... }
   * @param {boolean} [spec.useBrowserCookies]
   * @param {Electron.Session} [spec.session]
   * @returns {Promise<object>} response record
   */
  async send(spec) {
    this._check();

    const requestId = spec.requestId || uid('http_');
    const resolved = this._resolveVariables(spec);

    let url;
    try {
      url = new URL(resolved.url);
    } catch {
      throw new Error(`"${resolved.url}" is not a valid URL`);
    }

    const headers = { ...(resolved.headers || {}) };
    applyAuth(headers, resolved.auth);

    // Reuse the browsing profile's cookies when asked, which is what makes
    // this useful against an API you are already logged into.
    if (spec.useBrowserCookies && spec.session) {
      const cookies = await spec.session.cookies.get({ url: url.origin });
      if (cookies.length) {
        headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      }
    }

    const body = resolved.body ? Buffer.from(resolved.body, 'utf8') : null;
    if (body && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = looksLikeJson(resolved.body)
        ? 'application/json'
        : 'text/plain;charset=UTF-8';
    }
    if (body) headers['Content-Length'] = String(body.length);
    if (!hasHeader(headers, 'accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br';
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = 'Aether-REST/1.0';

    const record = await this._perform({
      requestId,
      method: (resolved.method || 'GET').toUpperCase(),
      url,
      headers,
      body,
      timeout: spec.timeout || 60000,
      followRedirects: spec.followRedirects !== false,
    });

    this._pushHistory({ ...record, name: spec.name || `${record.method} ${url.pathname}` });
    return record;
  }

  _perform({ requestId, method, url, headers, body, timeout, followRedirects, redirectCount = 0 }) {
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'http:' ? http : https;
      const timings = { start: process.hrtime.bigint() };
      let dnsAt = null;
      let connectAt = null;
      let tlsAt = null;
      let firstByteAt = null;

      const req = mod.request(
        {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers,
          timeout,
        },
        (res) => {
          const chunks = [];
          let size = 0;

          res.on('data', (chunk) => {
            if (firstByteAt === null) firstByteAt = process.hrtime.bigint();
            size += chunk.length;
            if (size > MAX_BODY) {
              req.destroy(new Error(`response exceeded ${MAX_BODY} bytes`));
              return;
            }
            chunks.push(chunk);
            this.emit('progress', { requestId, received: size });
          });

          res.on('end', async () => {
            this._inflight.delete(requestId);
            const endAt = process.hrtime.bigint();
            const raw = Buffer.concat(chunks);

            // Follow redirects manually so each hop shows up in the UI.
            if (
              followRedirects
              && [301, 302, 303, 307, 308].includes(res.statusCode)
              && res.headers.location
              && redirectCount < 10
            ) {
              const next = new URL(res.headers.location, url);
              // 303, and 301/302 on POST, become GET per the spec.
              const nextMethod = res.statusCode === 303
                || ([301, 302].includes(res.statusCode) && method === 'POST')
                ? 'GET' : method;
              const nextHeaders = { ...headers };
              if (nextMethod === 'GET') {
                delete nextHeaders['Content-Length'];
                delete nextHeaders['Content-Type'];
              }
              // Never carry credentials across an origin change.
              if (next.origin !== url.origin) {
                delete nextHeaders.Authorization;
                delete nextHeaders.Cookie;
              }
              const hop = await this._perform({
                requestId, method: nextMethod, url: next, headers: nextHeaders,
                body: nextMethod === 'GET' ? null : body,
                timeout, followRedirects, redirectCount: redirectCount + 1,
              }).catch(reject);
              if (!hop) return;
              hop.redirects = [
                { status: res.statusCode, from: url.toString(), to: next.toString() },
                ...(hop.redirects || []),
              ];
              return resolve(hop);
            }

            let decoded;
            try {
              decoded = decompress(raw, res.headers['content-encoding']);
            } catch (err) {
              log.warn(`decompression failed: ${err.message}`);
              decoded = raw;
            }

            const ms = (a, b) => (a === null || b === null ? null : Number(b - a) / 1e6);
            resolve({
              requestId,
              method,
              url: url.toString(),
              status: res.statusCode,
              statusText: res.statusMessage || '',
              headers: res.headers,
              // Both forms: text for display, base64 for binary payloads.
              body: isProbablyText(res.headers['content-type'])
                ? decoded.toString('utf8')
                : null,
              bodyBase64: isProbablyText(res.headers['content-type'])
                ? null
                : decoded.toString('base64'),
              size: { raw: raw.length, decoded: decoded.length },
              contentType: res.headers['content-type'] || null,
              timing: {
                total: ms(timings.start, endAt),
                dns: ms(timings.start, dnsAt),
                connect: ms(dnsAt || timings.start, connectAt),
                tls: ms(connectAt, tlsAt),
                ttfb: ms(timings.start, firstByteAt),
                download: ms(firstByteAt, endAt),
              },
              at: Date.now(),
              redirects: [],
            });
          });
          res.on('error', reject);
        }
      );

      // Per-phase timings are what make this useful for debugging latency.
      req.on('socket', (socket) => {
        socket.on('lookup', () => { dnsAt = process.hrtime.bigint(); });
        socket.on('connect', () => { connectAt = process.hrtime.bigint(); });
        socket.on('secureConnect', () => { tlsAt = process.hrtime.bigint(); });
      });
      req.on('timeout', () => req.destroy(new Error(`timed out after ${timeout}ms`)));
      req.on('error', (err) => {
        this._inflight.delete(requestId);
        reject(err);
      });

      this._inflight.set(requestId, req);
      if (body) req.write(body);
      req.end();
    });
  }

  cancel(requestId) {
    const req = this._inflight.get(requestId);
    if (!req) return false;
    req.destroy(new Error('cancelled'));
    this._inflight.delete(requestId);
    return true;
  }

  // ---- variables -------------------------------------------------------

  /**
   * Substitute `{{variable}}` from the active environment, in the URL,
   * headers and body.
   */
  _resolveVariables(spec) {
    const env = this.store.data.environments
      .find((e) => e.id === this.store.data.activeEnvironment);
    const vars = env?.variables || {};

    const substitute = (value) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        (name in vars ? vars[name] : match));
    };

    return {
      ...spec,
      url: substitute(spec.url),
      body: substitute(spec.body),
      headers: Object.fromEntries(
        Object.entries(spec.headers || {}).map(([k, v]) => [k, substitute(v)])
      ),
      auth: spec.auth
        ? Object.fromEntries(Object.entries(spec.auth).map(([k, v]) => [k, substitute(v)]))
        : undefined,
    };
  }

  // ---- collections -----------------------------------------------------

  collections() {
    return {
      collections: this.store.data.collections,
      environments: this.store.data.environments,
      activeEnvironment: this.store.data.activeEnvironment,
      history: this.store.data.history.slice(0, 50),
    };
  }

  saveRequest({ collectionId = 'default', request }) {
    this._check();
    let collection = this.store.data.collections.find((c) => c.id === collectionId);
    if (!collection) {
      collection = { id: uid('col_'), name: 'New Collection', requests: [] };
      this.store.data.collections.push(collection);
    }
    const existing = request.id && collection.requests.find((r) => r.id === request.id);
    if (existing) {
      Object.assign(existing, request, { id: existing.id, updated: Date.now() });
    } else {
      collection.requests.push({ ...request, id: uid('req_'), created: Date.now() });
    }
    this.store.save();
    return this.collections();
  }

  deleteRequest({ collectionId, requestId }) {
    const collection = this.store.data.collections.find((c) => c.id === collectionId);
    if (!collection) return false;
    const idx = collection.requests.findIndex((r) => r.id === requestId);
    if (idx < 0) return false;
    collection.requests.splice(idx, 1);
    this.store.save();
    return this.collections();
  }

  setEnvironment(id) {
    this.store.data.activeEnvironment = id;
    this.store.save();
    return this.collections();
  }

  _pushHistory(record) {
    // Store the shape of the exchange, not the payloads — a history file
    // full of bearer tokens and response bodies is a liability.
    this.store.data.history.unshift({
      id: record.requestId,
      name: record.name,
      method: record.method,
      url: record.url,
      status: record.status,
      ms: record.timing?.total ?? null,
      size: record.size?.decoded ?? null,
      at: record.at,
    });
    this.store.data.history = this.store.data.history.slice(0, 200);
    this.store.save();
  }

  exportAll() {
    return {
      collections: this.store.data.collections,
      environments: this.store.data.environments,
    };
  }

  importAll({ collections = [], environments = [] }) {
    const byId = new Map(this.store.data.collections.map((c) => [c.id, c]));
    for (const c of collections) {
      if (!byId.has(c.id)) this.store.data.collections.push(c);
    }
    const envById = new Map(this.store.data.environments.map((e) => [e.id, e]));
    for (const e of environments) {
      if (!envById.has(e.id)) this.store.data.environments.push(e);
    }
    this.store.save();
  }

  flush() {
    this.store.flush();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyAuth(headers, auth) {
  if (!auth || auth.type === 'none') return;
  if (auth.type === 'bearer' && auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth.type === 'basic' && auth.username != null) {
    const raw = `${auth.username}:${auth.password || ''}`;
    headers.Authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  } else if (auth.type === 'header' && auth.name) {
    headers[auth.name] = auth.value || '';
  }
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function looksLikeJson(text) {
  const t = String(text).trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/** Text types get a decoded string; everything else stays base64. */
function isProbablyText(contentType) {
  if (!contentType) return true;
  return /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql)|.*\+json|.*\+xml)/i
    .test(contentType);
}

function decompress(buffer, encoding) {
  if (!encoding || !buffer.length) return buffer;
  switch (encoding.toLowerCase()) {
    case 'gzip': return zlib.gunzipSync(buffer);
    case 'deflate': return zlib.inflateSync(buffer);
    case 'br': return zlib.brotliDecompressSync(buffer);
    default: return buffer;
  }
}

module.exports = { HttpClientService };
