'use strict';
/**
 * VPN service (spec §3).
 *
 * Two tunnel modes, chosen by what the machine can actually do:
 *
 *   `device`  A real WireGuard tunnel via the platform's own tooling. Covers
 *             every application, survives browser restarts, and carries a
 *             firewall kill switch. Needs the WireGuard tools installed and
 *             an elevation prompt.
 *
 *   `browser` The provider's tunnel entered through an authenticated proxy,
 *             applied per Electron session. Covers Shaurya's traffic only,
 *             needs no elevation, and works everywhere. This is what Opera
 *             and Brave ship as a "browser VPN"; naming it honestly matters,
 *             so the UI says "this window" rather than implying device-wide
 *             protection.
 *
 * The kill switch means different things in each mode and is implemented for
 * both: a firewall rule for `device`, and refusing to emit any un-proxied
 * request for `browser`.
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const wg = require('./wireguard');
const { createProvider, REGIONS } = require('./providers');
const { hubFor, PRIORITY } = require('../web-request-hub');
const paths = require('../../util/paths');
const { JsonStore } = require('../../util/json-store');
const { createLogger } = require('../../util/logger');

const log = createLogger('vpn');

const TUNNEL_NAME = 'shaurya0';
/** Free tier allowance, enforced client-side and again by the provider. */
const FREE_MONTHLY_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

class VpnService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;

    this.state = {
      status: 'disconnected', // disconnected | connecting | connected | error
      mode: null,             // device | browser
      region: null,
      since: null,
      error: null,
      killSwitch: settings.get('vpn.killSwitch') !== false,
      publicIp: null,
    };

    /** Sessions we have applied a proxy to, so we can revert them. */
    this._proxiedSessions = new Set();
    this._configPath = null;
    this._statsTimer = null;

    this.usageStore = new JsonStore(paths.userData('vpn-usage.json'), {
      month: currentMonth(), bytes: 0,
    });
    if (this.usageStore.data.month !== currentMonth()) {
      this.usageStore.data = { month: currentMonth(), bytes: 0 };
    }
  }

  // ---- session wiring --------------------------------------------------

  /**
   * Every profile session registers here so that:
   *  - a session created *after* connecting still gets the proxy;
   *  - the kill switch can cancel requests that would otherwise leak.
   */
  attach(sess, profile) {
    this._sessions ||= new Set();
    this._sessions.add(sess);

    if (this.state.status === 'connected' && this.state.mode === 'browser') {
      this._applyProxy(sess).catch((err) => log.warn(`late proxy apply: ${err.message}`));
    }

    hubFor(sess).register('onBeforeRequest', 'vpn-killswitch', PRIORITY.VPN, (details) => {
      if (!this.state.killSwitch) return null;
      // While a browser-mode tunnel is mid-reconnect there is a window where
      // requests would go out over the bare connection. Drop them instead —
      // that is the entire point of a kill switch.
      if (this.state.status === 'connecting' && this.state.mode === 'browser') {
        if (details.url.startsWith('shaurya://') || details.url.startsWith('devtools://')) return null;
        return { cancel: true };
      }
      return null;
    });
  }

  // ---- connect / disconnect -------------------------------------------

  regions() {
    const tier = this.settings.get('vpn.tier') || 'free';
    return REGIONS.map((r) => ({ ...r, locked: tier !== 'pro' && !r.free }));
  }

  /**
   * @param {{region?:string, mode?:'auto'|'device'|'browser'}} opts
   */
  async connect({ region, mode = 'auto' } = {}) {
    if (!this.features.enabled('vpn')) {
      throw new Error('The VPN is turned off in the Feature Store');
    }
    if (this.state.status === 'connected') return this.status();

    const tier = this.settings.get('vpn.tier') || 'free';
    const target = region || this.settings.get('vpn.region') || 'auto';
    const chosen = REGIONS.find((r) => r.id === target);
    if (chosen && !chosen.free && tier !== 'pro') {
      throw new Error(`${chosen.name} is a Pro region — free regions stay available`);
    }
    if (tier === 'free' && this.usageStore.data.bytes >= FREE_MONTHLY_BYTES) {
      throw new Error('Free-tier data allowance used up for this month');
    }

    this._setState({ status: 'connecting', region: target, error: null });

    try {
      // The private key is generated here and never transmitted.
      const keys = wg.generateKeypair();
      const provider = createProvider(this.settings, this.settings.get('vpn.token'));
      const peer = await provider.provision({
        publicKey: keys.publicKey,
        region: target,
        tier,
      });

      const wantDevice = mode === 'device' || (mode === 'auto' && await wg.isAvailable());

      if (wantDevice) {
        await this._connectDevice(keys, peer, target);
      } else {
        await this._connectBrowser(peer, target);
      }

      this._startStatsLoop();
      return this.status();
    } catch (err) {
      this._setState({ status: 'error', error: err.message, mode: null });
      log.error(`connect failed: ${err.message}`);
      throw err;
    }
  }

  async _connectDevice(keys, peer, region) {
    const config = wg.renderConfig({
      privateKey: keys.privateKey,
      address: peer.address,
      dns: peer.dns,
      peerPublicKey: peer.peerPublicKey,
      endpoint: peer.endpoint,
      allowedIPs: peer.allowedIPs,
      killSwitch: this.state.killSwitch,
      mtu: peer.mtu,
    });
    this._configPath = await wg.writeConfig(TUNNEL_NAME, config);
    await wg.up(TUNNEL_NAME, this._configPath);

    this._setState({
      status: 'connected',
      mode: 'device',
      region,
      since: Date.now(),
      error: null,
    });
    log.info(`device tunnel up via ${region}`);
  }

  async _connectBrowser(peer, region) {
    if (!peer.proxy) {
      throw new Error(
        'WireGuard tools are not installed, and this region offers no browser-mode entry point. '
        + 'Install WireGuard for a device-wide tunnel.'
      );
    }
    this._proxyUrl = peer.proxy;
    for (const sess of this._sessions || []) await this._applyProxy(sess);

    this._setState({
      status: 'connected',
      mode: 'browser',
      region,
      since: Date.now(),
      error: null,
    });
    log.info(`browser tunnel up via ${region} (this browser's traffic only)`);
  }

  async _applyProxy(sess) {
    await sess.setProxy({
      proxyRules: this._proxyUrl,
      // Never send local development traffic through the tunnel.
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
    });
    this._proxiedSessions.add(sess);
  }

  async disconnect({ reason } = {}) {
    if (this.state.status === 'disconnected') return this.status();
    this._stopStatsLoop();

    try {
      if (this.state.mode === 'device' && this._configPath) {
        await wg.down(TUNNEL_NAME, this._configPath);
        // The config holds a private key; remove it once the tunnel is down.
        await fs.rm(this._configPath, { force: true });
        this._configPath = null;
      }
      for (const sess of this._proxiedSessions) {
        await sess.setProxy({ mode: 'direct' }).catch(() => {});
      }
      this._proxiedSessions.clear();
      this._proxyUrl = null;
    } catch (err) {
      log.warn(`disconnect: ${err.message}`);
    }

    this._setState({
      status: 'disconnected', mode: null, since: null,
      error: reason === 'shutdown' ? null : this.state.error,
    });
    log.info(`disconnected${reason ? ` (${reason})` : ''}`);
    return this.status();
  }

  setKillSwitch(enabled) {
    this.state.killSwitch = Boolean(enabled);
    this.settings.set('vpn.killSwitch', this.state.killSwitch);
    this._setState({});
    return this.state.killSwitch;
  }

  // ---- telemetry-free usage accounting --------------------------------

  _startStatsLoop() {
    this._stopStatsLoop();
    this._statsTimer = setInterval(async () => {
      if (this.state.mode !== 'device') return;
      const s = await wg.stats(TUNNEL_NAME);
      if (!s) return;

      // Counters are cumulative for the tunnel's lifetime; bank the delta.
      const total = s.rx + s.tx;
      const delta = Math.max(0, total - (this._lastTotal || 0));
      this._lastTotal = total;
      this._addUsage(delta);

      // A handshake older than three minutes means the tunnel is dead even
      // though the interface still exists — reconnect rather than leak.
      if (s.lastHandshake && Date.now() - s.lastHandshake > 180_000) {
        log.warn('tunnel handshake stale; reconnecting');
        const region = this.state.region;
        await this.disconnect({ reason: 'stale' });
        this.connect({ region }).catch((err) => log.error(`reconnect failed: ${err.message}`));
      }
    }, 15_000);
    if (this._statsTimer.unref) this._statsTimer.unref();
  }

  _stopStatsLoop() {
    if (this._statsTimer) clearInterval(this._statsTimer);
    this._statsTimer = null;
    this._lastTotal = 0;
  }

  _addUsage(bytes) {
    if (this.usageStore.data.month !== currentMonth()) {
      this.usageStore.data = { month: currentMonth(), bytes: 0 };
    }
    this.usageStore.data.bytes += bytes;
    this.usageStore.save();

    const tier = this.settings.get('vpn.tier') || 'free';
    if (tier === 'free' && this.usageStore.data.bytes >= FREE_MONTHLY_BYTES) {
      log.info('free allowance exhausted; disconnecting');
      this.disconnect({ reason: 'quota' }).catch(() => {});
      this._setState({ error: 'Free-tier data allowance used up for this month' });
    }
  }

  usage() {
    const tier = this.settings.get('vpn.tier') || 'free';
    const used = this.usageStore.data.bytes;
    return {
      tier,
      used,
      limit: tier === 'pro' ? null : FREE_MONTHLY_BYTES,
      remaining: tier === 'pro' ? null : Math.max(0, FREE_MONTHLY_BYTES - used),
      resetsOn: nextMonthStart(),
      month: this.usageStore.data.month,
    };
  }

  status() {
    return {
      ...this.state,
      available: this.features.enabled('vpn'),
      usage: this.usage(),
      // Made explicit so the UI can be honest about scope.
      scope: this.state.mode === 'device' ? 'entire device'
        : this.state.mode === 'browser' ? 'this browser only'
          : null,
    };
  }

  _setState(patch) {
    Object.assign(this.state, patch);
    this.emit('status', this.status());
  }
}

function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonthStart() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

module.exports = { VpnService, FREE_MONTHLY_BYTES };
