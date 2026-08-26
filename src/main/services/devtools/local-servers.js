'use strict';
/**
 * Localhost manager (spec §5).
 *
 * Two jobs:
 *  - Serve a folder over HTTP in one click, for when you just need to look
 *    at a built site without `npx serve`.
 *  - Show which local ports are actually listening, so "which of my six dev
 *    servers is on 3000" stops being a `lsof` exercise.
 */
const EventEmitter = require('node:events');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { uid } = require('../../util/id');
const { createLogger } = require('../../util/logger');

const log = createLogger('localservers');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};

/** Ports commonly used by dev tooling, scanned first. */
const COMMON_PORTS = [
  3000, 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8088,
  8888, 9000, 1234, 1337, 4321, 7000, 3333, 5555, 6006, 9090,
];

class LocalServerService extends EventEmitter {
  constructor(features) {
    super();
    this.features = features;
    /** id -> { id, port, root, server, spa, started } */
    this.servers = new Map();
  }

  _check() {
    if (!this.features.enabled('localServers')) {
      throw new Error('The localhost manager is turned off in the Feature Store');
    }
  }

  // ---- static file server ---------------------------------------------

  /**
   * @param {{root:string, port?:number, spa?:boolean, cors?:boolean}} opts
   */
  async start({ root, port, spa = false, cors = true }) {
    this._check();

    const stat = await fsp.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`${root} is not a directory`);

    const chosen = port || await findFreePort(3000);
    const id = uid('srv_');

    const server = http.createServer((req, res) => {
      this._serve(req, res, { root, spa, cors }).catch((err) => {
        log.warn(`serve error: ${err.message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end('Internal error');
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`port ${chosen} is already in use`)
          : err);
      });
      // Bind to loopback only. A dev server reachable from the LAN is a
      // way to leak a work-in-progress build, and nobody asked for that.
      server.listen(chosen, '127.0.0.1', resolve);
    });

    const record = {
      id, port: chosen, root, spa, cors,
      url: `http://localhost:${chosen}`,
      started: Date.now(),
      requests: 0,
      server,
    };
    this.servers.set(id, record);
    this.emit('changed', this.list());
    log.info(`serving ${root} at http://localhost:${chosen}`);
    return this._public(record);
  }

  async _serve(req, res, { root, spa, cors }) {
    const record = [...this.servers.values()].find((s) => s.server.listening
      && s.root === root);
    if (record) record.requests++;

    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method not allowed');
    }

    const requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    // Resolve, then verify containment — the classic static-server escape is
    // `GET /../../etc/passwd`, and normalising alone does not stop a symlink.
    let target = path.resolve(root, '.' + requestPath);
    const boundary = path.resolve(root) + path.sep;
    if (target !== path.resolve(root) && !target.startsWith(boundary)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let stat = await fsp.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      const index = path.join(target, 'index.html');
      const indexStat = await fsp.stat(index).catch(() => null);
      if (indexStat) {
        target = index;
        stat = indexStat;
      } else {
        return this._listDirectory(res, target, root, requestPath);
      }
    }

    if (!stat) {
      // Single-page apps route client-side, so unknown paths get index.html.
      if (spa) {
        const index = path.join(root, 'index.html');
        if (await fsp.stat(index).catch(() => null)) {
          target = index;
          stat = await fsp.stat(index);
        }
      }
      if (!stat) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
    }

    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    // Range support, so video scrubbing works when previewing a build.
    const range = req.headers.range;
    if (range && /^bytes=/.test(range)) {
      const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
      const start = Number(startRaw) || 0;
      const end = endRaw ? Number(endRaw) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(target, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      // Dev servers must never cache; a stale asset costs an hour of
      // "why isn't my change showing".
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(target).pipe(res);
  }

  async _listDirectory(res, dir, root, requestPath) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const rows = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory())
        || a.name.localeCompare(b.name))
      .map((e) => {
        const href = path.posix.join(requestPath, e.name) + (e.isDirectory() ? '/' : '');
        return `<li><a href="${escapeHtml(href)}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`;
      })
      .join('\n');

    const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(requestPath)}</title>
<style>body{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:48em;margin:3em auto;padding:0 1em;color:#16181d}
h1{font-size:1.1em;color:#6b7280;font-weight:500}ul{list-style:none;padding:0}
li{padding:.2em 0}a{color:#2f5bd6;text-decoration:none}a:hover{text-decoration:underline}
@media(prefers-color-scheme:dark){body{background:#14161a;color:#e8eaed}a{color:#8aa6ff}}</style>
<h1>Index of ${escapeHtml(requestPath)}</h1><ul>
${requestPath !== '/' ? '<li><a href="../">../</a></li>' : ''}
${rows}</ul>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  async stop(id) {
    const record = this.servers.get(id);
    if (!record) return false;
    await new Promise((resolve) => record.server.close(resolve));
    this.servers.delete(id);
    this.emit('changed', this.list());
    log.info(`stopped server on port ${record.port}`);
    return true;
  }

  async stopAll() {
    await Promise.all([...this.servers.keys()].map((id) => this.stop(id)));
  }

  list() {
    return [...this.servers.values()].map((r) => this._public(r));
  }

  _public({ server, ...rest }) {
    return { ...rest, listening: server.listening };
  }

  // ---- port scanning ---------------------------------------------------

  /**
   * Which local ports are listening?
   *
   * Done by attempting a connection rather than reading `/proc` or shelling
   * out to `lsof`, so it behaves the same on every platform. Concurrency is
   * bounded because opening 1000 sockets at once is itself a problem.
   */
  async scanPorts({ ports, concurrency = 64 } = {}) {
    this._check();
    const candidates = ports?.length
      ? ports
      : [...new Set([...COMMON_PORTS, ...range(3000, 3010), ...range(8000, 8010),
        ...range(5170, 5180)])];

    const open = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < candidates.length) {
        const port = candidates[cursor++];
        if (await isListening(port)) {
          open.push({
            port,
            url: `http://localhost:${port}`,
            ours: [...this.servers.values()].some((s) => s.port === port),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
    return open.sort((a, b) => a.port - b.port);
  }
}

/** Try to connect; a refused connection means nothing is listening. */
function isListening(port, timeout = 300) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** First free port at or above `from`. */
async function findFreePort(from) {
  for (let port = from; port < from + 200; port++) {
    if (!(await isListening(port))) return port;
  }
  throw new Error('no free port found');
}

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { LocalServerService, COMMON_PORTS };
