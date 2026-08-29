'use strict';
/**
 * VPN provider adapters.
 *
 * A provider's job is narrow: given *our* freshly generated public key, hand
 * back peer details for a region. It never sees the private key, so the
 * no-log claim does not depend on trusting the provider with key material —
 * only with not recording traffic metadata.
 *
 * Shaurya ships with the adapter for its own service plus a BYO adapter so a
 * user can point the same UI at their own WireGuard server (a Mullvad
 * account, a self-hosted box) without waiting for us to add it.
 */
const { request } = require('../../util/net');
const { createLogger } = require('../../util/logger');

const log = createLogger('vpn:provider');

/** Regions offered on the free tier. Pro unlocks the full list. */
const REGIONS = [
  { id: 'auto', name: 'Fastest', country: null, free: true },
  { id: 'nl-ams', name: 'Amsterdam', country: 'NL', free: true },
  { id: 'de-fra', name: 'Frankfurt', country: 'DE', free: true },
  { id: 'us-nyc', name: 'New York', country: 'US', free: true },
  { id: 'us-sfo', name: 'San Francisco', country: 'US', free: false },
  { id: 'gb-lon', name: 'London', country: 'GB', free: false },
  { id: 'jp-tyo', name: 'Tokyo', country: 'JP', free: false },
  { id: 'sg-sin', name: 'Singapore', country: 'SG', free: false },
  { id: 'au-syd', name: 'Sydney', country: 'AU', free: false },
  { id: 'ca-tor', name: 'Toronto', country: 'CA', free: false },
  { id: 'br-gru', name: 'São Paulo', country: 'BR', free: false },
  { id: 'in-bom', name: 'Mumbai', country: 'IN', free: false },
];

/**
 * @typedef {object} PeerConfig
 * @property {string} peerPublicKey
 * @property {string} endpoint       host:port
 * @property {string} address        our tunnel address, e.g. 10.8.0.2/32
 * @property {string} dns
 * @property {string} [proxy]        optional HTTPS/SOCKS proxy for browser-only mode
 * @property {number} [expiresAt]
 */

/**
 * Shaurya's own service.
 *
 * The endpoint is configurable so the same adapter serves staging, self-host
 * and the production service.
 */
class ShauryaProvider {
  constructor({ endpoint = 'https://vpn.shaurya.dev', token = null } = {}) {
    this.id = 'shaurya';
    this.name = 'Shaurya VPN';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.token = token;
  }

  regions(tier = 'free') {
    return REGIONS.filter((r) => tier === 'pro' || r.free);
  }

  /**
   * Provision a peer for our public key.
   * @param {{publicKey:string, region:string, tier:string}} opts
   * @returns {Promise<PeerConfig>}
   */
  async provision({ publicKey, region, tier }) {
    const res = await request(`${this.endpoint}/v1/peers`, {
      method: 'POST',
      timeout: 15000,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ publicKey, region, tier }),
    });

    if (res.status === 402) {
      throw new Error('Free-tier data allowance used up — resets monthly, or upgrade to Pro');
    }
    if (res.status === 429) {
      throw new Error('Too many connections from this device; try again shortly');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`provisioning failed (HTTP ${res.status})`);
    }

    const data = JSON.parse(res.body.toString('utf8'));
    if (!data.peerPublicKey || !data.endpoint || !data.address) {
      throw new Error('provider returned an incomplete peer configuration');
    }
    return data;
  }

  /** Free-tier usage, so the UI can show a remaining-data meter. */
  async usage() {
    if (!this.token) return null;
    try {
      const res = await request(`${this.endpoint}/v1/usage`, {
        timeout: 10000,
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (res.status !== 200) return null;
      return JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      log.debug(`usage lookup failed: ${err.message}`);
      return null;
    }
  }
}

/**
 * Bring-your-own WireGuard.
 *
 * Takes a standard wg-quick config the user pastes in (from Mullvad, IVPN, a
 * self-hosted server) and drives it through the same UI. No account, no
 * provisioning call, nothing leaves the machine.
 */
class ByoProvider {
  constructor({ config } = {}) {
    this.id = 'byo';
    this.name = 'Custom WireGuard';
    this.config = config || '';
  }

  regions() {
    return [{ id: 'custom', name: 'Custom endpoint', country: null, free: true }];
  }

  /** Parse the pasted config rather than calling out anywhere. */
  async provision() {
    const cfg = parseWgConfig(this.config);
    if (!cfg.peerPublicKey || !cfg.endpoint) {
      throw new Error('the pasted configuration is missing a [Peer] PublicKey or Endpoint');
    }
    return cfg;
  }

  async usage() {
    return null; // Unmetered: it is the user's own server.
  }
}

/** Minimal wg-quick config parser for the BYO path. */
function parseWgConfig(text) {
  const out = { allowedIPs: ['0.0.0.0/0', '::/0'] };
  let section = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    if (/^\[(\w+)\]$/.test(line)) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();

    if (section === 'interface') {
      if (key === 'privatekey') out.privateKey = value;
      if (key === 'address') out.address = value;
      if (key === 'dns') out.dns = value;
      if (key === 'mtu') out.mtu = Number(value);
    } else if (section === 'peer') {
      if (key === 'publickey') out.peerPublicKey = value;
      if (key === 'endpoint') out.endpoint = value;
      if (key === 'allowedips') out.allowedIPs = value.split(',').map((s) => s.trim());
    }
  }
  out.dns = out.dns || '1.1.1.1';
  return out;
}

/** Build the configured provider from settings. */
function createProvider(settings, token) {
  const kind = settings.get('vpn.provider') || 'shaurya';
  if (kind === 'byo') {
    return new ByoProvider({ config: settings.get('vpn.customConfig') });
  }
  return new ShauryaProvider({
    endpoint: settings.get('vpn.endpoint') || undefined,
    token,
  });
}

module.exports = { ShauryaProvider, ByoProvider, createProvider, parseWgConfig, REGIONS };
