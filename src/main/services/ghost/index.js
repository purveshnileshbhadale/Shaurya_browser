'use strict';
/**
 * Ghost Mode (spec §7).
 *
 * Everything here is about *not leaving a trace*, so the implementation rule
 * throughout is: prefer not writing the data over writing it and cleaning up
 * afterwards. A history row that is created and then deleted still existed
 * on disk; one that was never written did not.
 *
 * Tor is a real SOCKS5 proxy to a local Tor daemon, not an approximation.
 * Aether does not bundle Tor: shipping a browser that claims Tor protection
 * while routing through something else would be actively dangerous, so if no
 * daemon is reachable the UI says Tor is unavailable and refuses to pretend.
 */
const EventEmitter = require('node:events');
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, session: electronSession } = require('electron');

const { shred, caveat } = require('./shredder');
const { stripMetadata, isStrippable } = require('./metadata');
const { createLogger } = require('../../util/logger');

const log = createLogger('ghost');

/** Where a local Tor daemon usually listens. Both are checked. */
const TOR_ENDPOINTS = [
  { host: '127.0.0.1', port: 9050, label: 'Tor daemon' },
  { host: '127.0.0.1', port: 9150, label: 'Tor Browser' },
];

/**
 * DoH resolvers offered in the picker.
 *
 * Chosen for having a published no-logging policy and being reachable
 * without an account. "System" is listed first and honestly labelled,
 * because a user whose OS already runs an encrypted resolver should not be
 * pushed off it by a browser-level default.
 */
const DOH_PROVIDERS = [
  { id: 'system', name: 'System resolver', url: '', note: 'Whatever your OS is configured to use.' },
  { id: 'quad9', name: 'Quad9', url: 'https://dns.quad9.net/dns-query', note: 'Blocks known-malicious domains. No logging of personal data.' },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query', note: 'Fast and widely reachable. 24-hour log retention.' },
  { id: 'mullvad', name: 'Mullvad', url: 'https://dns.mullvad.net/dns-query', note: 'No logging, no account needed.' },
  { id: 'custom', name: 'Custom…', url: '', note: 'Any RFC 8484 endpoint.' },
];

class GhostService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../settings').SettingsService} deps.settings
   * @param {import('../feature-store').FeatureStore} deps.features
   * @param {import('../modes').ModeService} deps.modes
   * @param {import('../passwords/vault').VaultService} deps.vault
   * @param {object} deps.breach  the existing HIBP client
   */
  constructor({ settings, features, modes, vault, breach }) {
    super();
    this.settings = settings;
    this.features = features;
    this.modes = modes;
    this.vault = vault;
    this.breach = breach;

    this.windowManager = null;

    /** sessionPartition -> 'tor' | 'direct' */
    this._routing = new Map();
    this._torAvailable = null;
    this._monitorTimer = null;
    this._breachReport = { checkedAt: 0, entries: [], running: false };
  }

  attach(windowManager) {
    this.windowManager = windowManager;
  }

  // == Tor ================================================================

  /**
   * Is a Tor SOCKS proxy actually listening?
   *
   * Probed by opening a TCP connection rather than trusting configuration,
   * because the failure mode we must avoid is telling someone their traffic
   * is anonymised when it is going out clear.
   */
  async torAvailable({ refresh = false } = {}) {
    if (this._torAvailable && !refresh) return this._torAvailable;

    for (const endpoint of TOR_ENDPOINTS) {
      // eslint-disable-next-line no-await-in-loop
      const open = await probe(endpoint.host, endpoint.port);
      if (open) {
        this._torAvailable = { available: true, ...endpoint };
        return this._torAvailable;
      }
    }

    this._torAvailable = {
      available: false,
      reason: 'No Tor SOCKS proxy is listening on 127.0.0.1:9050 or :9150.',
      remedy: process.platform === 'darwin' ? 'brew install tor && brew services start tor'
        : process.platform === 'win32' ? 'Install the Tor Browser, or run tor.exe as a service.'
          : 'Install the "tor" package and start the service.',
    };
    return this._torAvailable;
  }

  /**
   * Route one session through Tor.
   *
   * Applied per Electron session, so a Ghost window is routed while ordinary
   * windows are not — which is what "for a given window, separate from the
   * default VPN" in the spec asks for.
   */
  async routeThroughTor(session, { enabled = true } = {}) {
    if (!enabled) {
      await session.setProxy({ mode: 'system' });
      this._routing.set(session.storagePath || 'memory', 'direct');
      this.emit('changed', this.status());
      return { routed: false };
    }

    const tor = await this.torAvailable({ refresh: true });
    if (!tor.available) {
      // Refuse rather than silently falling back to a direct connection.
      throw new Error(`Tor is not running. ${tor.remedy}`);
    }

    await session.setProxy({
      proxyRules: `socks5://${tor.host}:${tor.port}`,
      // A DNS lookup made outside the tunnel would leak every hostname
      // visited, which defeats the entire exercise.
      proxyBypassRules: '<-loopback>',
    });
    this._routing.set(session.storagePath || 'memory', 'tor');
    log.info(`session routed through ${tor.label} at ${tor.host}:${tor.port}`);
    this.emit('changed', this.status());
    return { routed: true, endpoint: `${tor.host}:${tor.port}` };
  }

  /**
   * Confirm with Tor's own checking service that traffic really is exiting
   * through the network. Offered as a button, because "trust me" is not a
   * privacy guarantee a user should have to accept.
   */
  async verifyTor(session) {
    try {
      const response = await session.fetch('https://check.torproject.org/api/ip');
      const body = await response.json();
      return { ok: body.IsTor === true, exitIp: body.IP || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // == DNS over HTTPS =====================================================

  dohProviders() {
    return DOH_PROVIDERS.map((p) => ({
      ...p,
      active: p.id === (this.settings.get('privacy.dohProvider') || 'system'),
    }));
  }

  /**
   * Chromium resolves DNS for the whole app, so this is process-wide rather
   * than per-session. The UI says so instead of implying a Ghost window can
   * have its own resolver while other windows do not.
   */
  setDoh({ id, url }) {
    const provider = DOH_PROVIDERS.find((p) => p.id === id);
    if (!provider) throw new Error(`unknown DNS provider "${id}"`);

    const endpoint = id === 'custom' ? String(url || '').trim() : provider.url;
    if (id === 'custom' && !/^https:\/\//.test(endpoint)) {
      throw new Error('a custom resolver must be an https:// endpoint');
    }

    this.settings.set('privacy.dohProvider', id);
    this.settings.set('privacy.dohUrl', endpoint);

    try {
      app.configureHostResolver(
        id === 'system'
          ? { secureDnsMode: 'automatic', secureDnsServers: [] }
          : { secureDnsMode: 'secure', secureDnsServers: [endpoint] },
      );
    } catch (err) {
      log.warn(`configureHostResolver failed: ${err.message}`);
      throw new Error(`Could not apply the resolver: ${err.message}`);
    }

    this.emit('changed', this.status());
    return { id, url: endpoint, scope: 'entire browser' };
  }

  /** Re-apply the stored resolver at boot. */
  applyStoredDoh() {
    const id = this.settings.get('privacy.dohProvider');
    if (!id || id === 'system') return;
    try {
      this.setDoh({ id, url: this.settings.get('privacy.dohUrl') });
    } catch (err) {
      log.warn(`could not restore DNS setting: ${err.message}`);
    }
  }

  // == Metadata stripping =================================================

  /**
   * Clean a downloaded file in place.
   * @returns {Promise<{changed:boolean, removed:string[], bytesRemoved:number}>}
   */
  async stripFile(filePath) {
    if (!this.features.enabled('metadataStrip')) {
      return { changed: false, removed: [], bytesRemoved: 0, skipped: 'feature off' };
    }
    if (!isStrippable(filePath)) {
      return { changed: false, removed: [], bytesRemoved: 0, skipped: 'unsupported format' };
    }

    const buffer = await fs.readFile(filePath);
    const result = stripMetadata(buffer);
    if (!result.changed) return { changed: false, removed: [], bytesRemoved: 0 };

    // Write to a sibling then rename: a crash mid-write must not leave the
    // user with a truncated file where their photo used to be.
    const temp = `${filePath}.aether-tmp`;
    await fs.writeFile(temp, result.data);
    await fs.rename(temp, filePath);

    log.info(`stripped ${result.removed.length} metadata block(s) from ${path.basename(filePath)}`);
    this.emit('stripped', { path: filePath, ...result, data: undefined });
    return { changed: true, removed: result.removed, bytesRemoved: result.bytesRemoved };
  }

  // == Shredder ===========================================================

  async shredFile(filePath, { passes } = {}) {
    if (!this.features.enabled('shredder')) throw new Error('the shredder is switched off');
    const result = await shred(filePath, { passes: passes || 3 });
    this.emit('shredded', result);
    return result;
  }

  shredderCaveat() {
    return caveat();
  }

  // == Breach monitor =====================================================

  /**
   * Continuously re-check saved accounts.
   *
   * Runs on a long timer rather than on every unlock: the k-anonymity range
   * API is cheap but not free, and a breach corpus does not change minute to
   * minute. Nothing about the password leaves the machine — only a 5-hex-
   * character prefix of its SHA-1, which is what makes the check safe.
   */
  startMonitor() {
    if (this._monitorTimer || !this.features.enabled('breachMonitor')) return;
    const everyMs = 6 * 60 * 60 * 1000;
    this._monitorTimer = setInterval(() => {
      this.runBreachScan().catch((err) => log.debug(`breach scan: ${err.message}`));
    }, everyMs);
    this._monitorTimer.unref?.();
    this.runBreachScan().catch(() => {});
  }

  stopMonitor() {
    if (!this._monitorTimer) return;
    clearInterval(this._monitorTimer);
    this._monitorTimer = null;
  }

  async runBreachScan() {
    if (!this.features.enabled('breachMonitor')) throw new Error('breach monitoring is off');
    if (this._breachReport.running) return this._breachReport;
    if (!this.vault.isUnlocked?.()) {
      // Never prompt for the passphrase on a timer — an unexpected unlock
      // prompt trains users to type it at anything that asks.
      return { ...this._breachReport, blocked: 'vault locked' };
    }

    this._breachReport = { ...this._breachReport, running: true };
    this.emit('breach', this._breachReport);

    const entries = [];
    let unchecked = 0;
    try {
      for (const entry of this.vault.list()) {
        // eslint-disable-next-line no-await-in-loop
        const secret = await this.vault.reveal(entry.id).catch(() => null);
        if (!secret?.password) continue;
        // Returns an occurrence count, 0 for clean, or -1 when the lookup
        // itself failed — which must not be reported as "not breached".
        // eslint-disable-next-line no-await-in-loop
        const count = await this.breach.checkPassword(secret.password).catch(() => -1);
        if (count > 0) {
          entries.push({
            id: entry.id,
            site: entry.site,
            username: entry.username,
            count,
            severity: count > 100_000 ? 'high' : count > 1000 ? 'medium' : 'low',
          });
        } else if (count < 0) {
          unchecked += 1;
        }
      }
      this._breachReport = {
        checkedAt: Date.now(),
        entries,
        running: false,
        total: this.vault.list().length,
        // A lookup that failed is not a clean result, and a dashboard that
        // silently counted it as one would be telling the user they are safe
        // on the strength of a network error.
        unchecked,
      };
    } catch (err) {
      this._breachReport = { ...this._breachReport, running: false, error: err.message };
    }

    this.emit('breach', this._breachReport);
    return this._breachReport;
  }

  breachReport() {
    return this._breachReport;
  }

  // == Panic ==============================================================

  /**
   * Close and wipe.
   *
   * Order matters and is deliberate: windows close *first*, so anything on
   * screen is gone within a frame, and the slower storage clearing happens
   * behind an already-blank screen. Someone reaching for this key needs the
   * display clear immediately, not correctly a second later.
   *
   * @param {'window'|'browser'} scope
   */
  async panic({ scope = 'window', windowId } = {}) {
    if (!this.features.enabled('panicButton')) throw new Error('the panic button is off');
    log.warn(`panic triggered (scope: ${scope})`);

    const wm = this.windowManager;
    const targets = scope === 'browser'
      ? (wm?.list() || [])
      : [wm?.get(windowId) || wm?.focused()].filter(Boolean);

    const sessions = new Set();
    for (const win of targets) {
      for (const tab of win.tabs?.list?.() || []) {
        const ses = tab.webContents?.session;
        if (ses) sessions.add(ses);
      }
    }

    // 1. Screen clear.
    for (const win of targets) {
      try { win.destroy(); } catch { /* already going */ }
    }

    // 2. Then the data.
    const wipes = [];
    for (const ses of sessions) {
      wipes.push(ses.clearStorageData().catch(() => {}));
      wipes.push(ses.clearCache().catch(() => {}));
      wipes.push(ses.clearAuthCache?.().catch(() => {}) ?? Promise.resolve());
    }

    if (scope === 'browser') {
      const preserve = this.settings.get('ghost.panicPreserveSettings') !== false;
      wipes.push(electronSession.defaultSession.clearStorageData().catch(() => {}));
      wipes.push(electronSession.defaultSession.clearCache().catch(() => {}));
      try {
        this.settings.set('ghost.lastPanicAt', Date.now());
        if (!preserve) this.settings.reset();
      } catch { /* best effort */ }
    }

    await Promise.all(wipes);
    this.emit('panic', { scope, windows: targets.length, sessions: sessions.size });

    if (scope === 'browser') app.quit();
    return { scope, windowsClosed: targets.length, sessionsWiped: sessions.size };
  }

  // == Status =============================================================

  status() {
    return {
      tor: {
        ...(this._torAvailable || { available: null }),
        routedSessions: [...this._routing.values()].filter((v) => v === 'tor').length,
      },
      doh: {
        provider: this.settings.get('privacy.dohProvider') || 'system',
        url: this.settings.get('privacy.dohUrl') || '',
        providers: this.dohProviders(),
        scope: 'entire browser',
      },
      metadataStrip: this.features.enabled('metadataStrip'),
      shredder: this.features.enabled('shredder'),
      breach: this._breachReport,
      panic: {
        enabled: this.features.enabled('panicButton'),
        scope: this.settings.get('ghost.panicScope') || 'window',
      },
    };
  }

  dispose() {
    this.stopMonitor();
  }
}

/** Open a TCP connection with a short deadline. Resolves true if it lands. */
function probe(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

module.exports = { GhostService, DOH_PROVIDERS, TOR_ENDPOINTS };
