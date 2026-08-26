'use strict';
/**
 * Container status widget (spec §3).
 *
 * Talks to the Docker Engine API over its local socket — a unix socket on
 * macOS and Linux, a named pipe on Windows — which is how the `docker` CLI
 * itself works. No shelling out: parsing `docker ps` output is fragile across
 * versions, and the socket returns structured JSON.
 *
 * **Read-only, deliberately.** The Docker socket is root-equivalent on most
 * systems: anything that can write to it can start a privileged container and
 * own the host. A browser panel that could stop or start containers would be
 * a remote-code-execution primitive one XSS away from a compromised page. So
 * this issues GETs only, and the panel says why the stop button is absent.
 */
const EventEmitter = require('node:events');
const http = require('node:http');
const fs = require('node:fs');

const { createLogger } = require('../../util/logger');

const log = createLogger('docker');

const SOCKET = process.platform === 'win32'
  ? '\\\\.\\pipe\\docker_engine'
  : (process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock');

class DockerService extends EventEmitter {
  constructor({ features }) {
    super();
    this.features = features;
    this._available = null;
    this._timer = null;
    this._last = { containers: [], at: 0 };
  }

  /** Is a Docker socket present and answering? */
  async available({ refresh = false } = {}) {
    if (this._available !== null && !refresh) return this._available;

    if (process.platform !== 'win32' && !fs.existsSync(SOCKET)) {
      this._available = {
        available: false,
        reason: `No Docker socket at ${SOCKET}.`,
        remedy: 'Start Docker Desktop, or the docker daemon.',
      };
      return this._available;
    }

    try {
      const version = await this._get('/version');
      this._available = {
        available: true,
        version: version.Version,
        apiVersion: version.ApiVersion,
        socket: SOCKET,
      };
    } catch (err) {
      this._available = {
        available: false,
        reason: err.message,
        remedy: /permission/i.test(err.message)
          ? 'Your user is not in the "docker" group, so the socket is not readable.'
          : 'Start Docker Desktop, or the docker daemon.',
      };
    }
    return this._available;
  }

  /**
   * Running containers with their published ports.
   *
   * Ports are the reason this panel exists: the common question while
   * developing is "what is on 5432 right now", and the answer is one glance
   * instead of a terminal round trip.
   */
  async containers({ all = false } = {}) {
    if (!this.features.enabled('docker')) throw new Error('the container widget is off');

    const status = await this.available();
    if (!status.available) return { available: false, ...status, containers: [] };

    const raw = await this._get(`/containers/json?all=${all ? 1 : 0}`);
    const containers = (raw || []).map((c) => ({
      id: c.Id.slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      // Deduplicated and sorted: Docker reports IPv4 and IPv6 bindings
      // separately, which shows every port twice for no benefit.
      ports: dedupePorts(c.Ports),
      created: c.Created * 1000,
      health: /\(healthy\)/.test(c.Status) ? 'healthy'
        : /\(unhealthy\)/.test(c.Status) ? 'unhealthy'
          : /\(health: starting\)/.test(c.Status) ? 'starting' : null,
      compose: c.Labels?.['com.docker.compose.project'] || null,
    }));

    this._last = { containers, at: Date.now() };
    this.emit('changed', this._last);
    return { available: true, containers, at: this._last.at, readOnly: true };
  }

  /** Recent log lines for one container. Read-only, and capped. */
  async logs(id, { tail = 200 } = {}) {
    const status = await this.available();
    if (!status.available) throw new Error(status.reason);

    const text = await this._get(
      `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${Number(tail) || 200}`,
      { raw: true },
    );
    return { id, lines: demultiplex(text) };
  }

  start(intervalMs = 5000) {
    if (this._timer || !this.features.enabled('docker')) return;
    this._timer = setInterval(() => {
      this.containers().catch(() => {});
    }, intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * A GET against the Engine API.
   *
   * Only GET is implemented — see the header. Adding a `method` parameter
   * here is the change that would turn this into a privilege-escalation
   * surface, so there is deliberately nowhere to pass one.
   */
  _get(path, { raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { socketPath: SOCKET, path, method: 'GET', timeout: 4000 },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (response.statusCode >= 400) {
              reject(new Error(`Docker returned ${response.statusCode}: ${buffer.toString().slice(0, 200)}`));
              return;
            }
            if (raw) { resolve(buffer); return; }
            try { resolve(JSON.parse(buffer.toString('utf8'))); } catch (err) { reject(err); }
          });
        },
      );
      request.on('timeout', () => { request.destroy(new Error('Docker socket timed out')); });
      request.on('error', reject);
      request.end();
    });
  }

  dispose() {
    this.stop();
  }
}

/**
 * Docker multiplexes stdout and stderr into one stream with an 8-byte header
 * per frame. Without demultiplexing, log output arrives with binary garbage
 * every few hundred bytes.
 */
function demultiplex(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer).split('\n');

  const lines = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    // Not a valid frame header: the daemon was started without TTY
    // multiplexing, so the whole buffer is plain text.
    if (stream > 2 || offset + 8 + length > buffer.length) {
      return buffer.toString('utf8').split('\n').filter(Boolean);
    }
    const text = buffer.subarray(offset + 8, offset + 8 + length).toString('utf8');
    for (const line of text.split('\n')) {
      if (line) lines.push({ stream: stream === 2 ? 'stderr' : 'stdout', text: line });
    }
    offset += 8 + length;
  }
  return lines;
}

function dedupePorts(ports) {
  const seen = new Map();
  for (const p of ports || []) {
    if (!p.PublicPort) continue;
    const key = `${p.PublicPort}/${p.Type}`;
    if (!seen.has(key)) {
      seen.set(key, { public: p.PublicPort, private: p.PrivatePort, type: p.Type });
    }
  }
  return [...seen.values()].sort((a, b) => a.public - b.public);
}

module.exports = { DockerService, demultiplex, dedupePorts, SOCKET };
