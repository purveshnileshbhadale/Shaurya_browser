'use strict';
/**
 * Latency measurement and server-region testing (spec §4).
 *
 * What this measures, precisely: the time to complete a **TCP handshake** to
 * a region's endpoint. That is not the same as a game's in-client ping, which
 * is usually UDP round-trip to a specific match server, and it will read a
 * little higher because a handshake is one and a half round trips rather than
 * one.
 *
 * ICMP ping — the thing that would match a game client most closely — needs a
 * raw socket, which needs root on every platform this ships to. Asking a
 * browser user for elevation to draw a latency graph is not a trade worth
 * making, so TCP it is, and the panel labels the number "TCP handshake"
 * rather than "ping". The *relative* ordering between regions, which is what
 * you actually pick a server with, is preserved either way.
 */
const net = require('node:net');
const EventEmitter = require('node:events');

/**
 * Region endpoints.
 *
 * Deliberately anycast/CDN edges rather than any single game's servers: they
 * are stable, they are not rate-limited against a handful of connections,
 * and a game's own IPs change without notice. Port 443 because it is open
 * everywhere a browser works at all.
 */
const REGIONS = [
  { id: 'eu-west', name: 'EU West', city: 'London', host: 'lhr.icanhazip.com', port: 443 },
  { id: 'eu-central', name: 'EU Central', city: 'Frankfurt', host: 'fra.icanhazip.com', port: 443 },
  { id: 'us-east', name: 'US East', city: 'Ashburn', host: 'iad.icanhazip.com', port: 443 },
  { id: 'us-west', name: 'US West', city: 'San Jose', host: 'sjc.icanhazip.com', port: 443 },
  { id: 'ap-southeast', name: 'Asia Pacific', city: 'Singapore', host: 'sin.icanhazip.com', port: 443 },
  { id: 'ap-northeast', name: 'Japan', city: 'Tokyo', host: 'nrt.icanhazip.com', port: 443 },
  { id: 'sa-east', name: 'South America', city: 'São Paulo', host: 'gru.icanhazip.com', port: 443 },
  { id: 'oceania', name: 'Oceania', city: 'Sydney', host: 'syd.icanhazip.com', port: 443 },
];

/** Samples per region. Enough for a median and a jitter figure. */
const SAMPLES = 5;
const TIMEOUT_MS = 2500;

class PingService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;

    /** regionId -> { samples: number[], median, jitter, loss } */
    this._results = new Map();
    /** Rolling history for the live graph overlay. */
    this._history = [];
    this._watchTimer = null;
    this._watchTarget = null;
  }

  regions() {
    const custom = this.settings.get('gaming.pingRegions') || [];
    return [...REGIONS, ...custom];
  }

  addRegion({ name, host, port = 443 }) {
    if (!host) throw new Error('a region needs a host');
    const custom = [...(this.settings.get('gaming.pingRegions') || [])];
    custom.push({
      id: `custom-${host.replace(/\W+/g, '-')}`,
      name: name || host,
      city: '',
      host,
      port: Number(port) || 443,
      custom: true,
    });
    this.settings.set('gaming.pingRegions', custom);
    return this.regions();
  }

  removeRegion(id) {
    const custom = (this.settings.get('gaming.pingRegions') || []).filter((r) => r.id !== id);
    this.settings.set('gaming.pingRegions', custom);
    return this.regions();
  }

  /**
   * Measure every region.
   *
   * Regions run in parallel but samples within a region run in series: firing
   * five simultaneous handshakes at one host measures the host's concurrency
   * behaviour, not the path's latency.
   */
  async testAll({ samples = SAMPLES } = {}) {
    if (!this.features.enabled('pingTester')) throw new Error('the ping tester is off');

    const results = await Promise.all(
      this.regions().map((region) => this.testRegion(region, { samples })),
    );

    results.sort((a, b) => {
      if (a.median == null) return 1;
      if (b.median == null) return -1;
      return a.median - b.median;
    });

    this.emit('results', results);
    return {
      results,
      best: results.find((r) => r.median != null) || null,
      measuredAt: Date.now(),
      method: 'TCP handshake (not ICMP; see the panel note)',
    };
  }

  async testRegion(region, { samples = SAMPLES } = {}) {
    const times = [];
    let failures = 0;

    for (let i = 0; i < samples; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ms = await handshake(region.host, region.port, TIMEOUT_MS);
      if (ms == null) failures += 1; else times.push(ms);
    }

    const stats = summarise(times);
    const record = {
      ...region,
      ...stats,
      samples: times.length,
      loss: samples ? failures / samples : 0,
      reachable: times.length > 0,
    };
    this._results.set(region.id, record);
    return record;
  }

  /**
   * Live graph feed. Samples one endpoint continuously so the overlay can
   * show a trend line rather than a single number — jitter and spikes are
   * what actually ruin a match, and a point-in-time reading hides both.
   */
  startWatch(regionId) {
    const region = this.regions().find((r) => r.id === regionId);
    if (!region) throw new Error(`unknown region "${regionId}"`);

    this.stopWatch();
    this._watchTarget = region;
    this._history = [];

    const tick = async () => {
      const ms = await handshake(region.host, region.port, TIMEOUT_MS);
      // 120 points at one second each is two minutes of history, which is
      // about as far back as anyone looks while deciding to switch server.
      this._history = [...this._history.slice(-119), { at: Date.now(), ms }];
      this.emit('sample', { region: region.id, ms, history: this._history });
    };

    this._watchTimer = setInterval(tick, 1000);
    this._watchTimer.unref?.();
    tick();
    return { watching: region.id };
  }

  stopWatch() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    this._watchTarget = null;
    return { watching: null };
  }

  state() {
    return {
      regions: this.regions(),
      results: [...this._results.values()],
      watching: this._watchTarget?.id || null,
      history: this._history,
      method: 'TCP handshake',
      note: 'Measured as a TCP handshake, so it reads slightly higher than a '
        + 'game client\'s UDP ping. The ranking between regions is what matters.',
    };
  }

  dispose() {
    this.stopWatch();
  }
}

/**
 * Time a TCP handshake.
 * @returns {Promise<number|null>} milliseconds, or null if it did not connect
 */
function handshake(host, port, timeout) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = new net.Socket();

    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      const ns = Number(process.hrtime.bigint() - started);
      finish(Math.round((ns / 1e6) * 10) / 10);
    });
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));

    try {
      socket.connect(port, host);
    } catch {
      finish(null);
    }
  });
}

/**
 * Median rather than mean: one 900ms outlier from a retransmit would drag an
 * average into uselessness, and the median is what a player experiences most
 * of the time.
 */
function summarise(times) {
  if (!times.length) return { median: null, min: null, max: null, jitter: null };

  const sorted = [...times].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  // Mean absolute deviation from the median: the same quantity RTP calls
  // jitter, and more robust than a standard deviation on five samples.
  const jitter = times.reduce((n, t) => n + Math.abs(t - median), 0) / times.length;

  return {
    median: Math.round(median * 10) / 10,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    jitter: Math.round(jitter * 10) / 10,
  };
}

/** Rate a latency figure the way a player would read it. */
function grade(ms) {
  if (ms == null) return 'unreachable';
  if (ms < 30) return 'excellent';
  if (ms < 60) return 'good';
  if (ms < 100) return 'fair';
  if (ms < 180) return 'poor';
  return 'bad';
}

module.exports = { PingService, REGIONS, summarise, grade, handshake };
