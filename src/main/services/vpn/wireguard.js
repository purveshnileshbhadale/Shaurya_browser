'use strict';
/**
 * WireGuard tunnel control.
 *
 * Aether does not reimplement WireGuard: it generates a standard
 * configuration and drives the platform's own tooling (`wg-quick` on
 * Linux/macOS, the WireGuard service on Windows). That means the data path
 * is the audited kernel/userspace implementation, and the browser only ever
 * handles configuration.
 *
 * Key material is generated locally with Curve25519 and the private key is
 * never sent anywhere — the provider only ever sees the public key, which is
 * what makes the "no-log" claim structurally meaningful rather than a
 * promise.
 */
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const execFileAsync = promisify(execFile);
const log = createLogger('wireguard');

/**
 * Generate a Curve25519 keypair in WireGuard's base64 encoding.
 *
 * Node's `x25519` gives us the same curve WireGuard uses. We export the raw
 * 32-byte scalars from the DER wrappers, which is the format `wg` expects.
 */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

  // The raw key is the tail of the DER encoding: SPKI ends with the 32-byte
  // public value, PKCS8 with the 32-byte private scalar.
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);

  return {
    publicKey: pub.toString('base64'),
    privateKey: priv.toString('base64'),
  };
}

/** Derive the public key for an existing private key. */
function publicKeyFor(privateKeyB64) {
  const raw = Buffer.from(privateKeyB64, 'base64');
  if (raw.length !== 32) throw new Error('a WireGuard private key is 32 bytes');
  // Wrap the raw scalar back into PKCS8 so Node will import it.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    raw,
  ]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  return pub.toString('base64');
}

/**
 * Render a wg-quick configuration file.
 *
 * @param {object} opts
 * @param {string} opts.privateKey     ours, never leaves the machine
 * @param {string} opts.address        e.g. '10.8.0.2/32'
 * @param {string} opts.dns            the provider's resolver
 * @param {string} opts.peerPublicKey
 * @param {string} opts.endpoint       'host:port'
 * @param {string[]} [opts.allowedIPs]
 * @param {boolean} [opts.killSwitch]
 */
function renderConfig({
  privateKey, address, dns, peerPublicKey, endpoint,
  allowedIPs = ['0.0.0.0/0', '::/0'],
  killSwitch = true,
  mtu = 1420,
}) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    `DNS = ${dns}`,
    `MTU = ${mtu}`,
  ];

  if (killSwitch && process.platform !== 'win32') {
    // wg-quick's own kill switch: this firewall rule drops any packet that
    // would leave via a non-tunnel interface, so traffic cannot silently
    // fall back to the plain connection if the tunnel drops.
    lines.push(
      'PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT',
      'PreDown = iptables -D OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT'
    );
  }

  lines.push(
    '',
    '[Peer]',
    `PublicKey = ${peerPublicKey}`,
    `AllowedIPs = ${allowedIPs.join(', ')}`,
    `Endpoint = ${endpoint}`,
    // Keeps the tunnel alive through NAT without meaningful bandwidth cost.
    'PersistentKeepalive = 25'
  );

  return lines.join('\n') + '\n';
}

/** Is the platform's WireGuard tooling present? */
async function isAvailable() {
  const probe = process.platform === 'win32' ? 'wireguard.exe' : 'wg-quick';
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [probe], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Write the config with 0600 permissions — it holds a private key. */
async function writeConfig(name, contents) {
  const dir = paths.userDataDir('vpn');
  const file = path.join(dir, `${name}.conf`);
  await fs.writeFile(file, contents, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

/**
 * Bring a tunnel up. Requires elevation, which is why this shells out rather
 * than trying to configure interfaces itself.
 */
async function up(name, configPath) {
  if (process.platform === 'win32') {
    await execFileAsync('wireguard.exe', ['/installtunnelservice', configPath], { timeout: 30000 });
  } else {
    await execFileAsync('wg-quick', ['up', configPath], { timeout: 30000 });
  }
  log.info(`tunnel ${name} up`);
}

async function down(name, configPath) {
  try {
    if (process.platform === 'win32') {
      await execFileAsync('wireguard.exe', ['/uninstalltunnelservice', name], { timeout: 30000 });
    } else {
      await execFileAsync('wg-quick', ['down', configPath], { timeout: 30000 });
    }
    log.info(`tunnel ${name} down`);
  } catch (err) {
    // "is not a WireGuard interface" just means it was already down.
    if (!/not a WireGuard interface|does not exist|No such/i.test(err.message)) throw err;
  }
}

/**
 * Live transfer counters and handshake age, parsed from `wg show`.
 * @returns {Promise<{rx:number, tx:number, lastHandshake:number|null}|null>}
 */
async function stats(name) {
  try {
    const { stdout } = await execFileAsync('wg', ['show', name, 'dump'], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    // The first line is the interface; peers follow.
    const peer = lines[1];
    if (!peer) return null;
    const cols = peer.split('\t');
    return {
      lastHandshake: Number(cols[4]) ? Number(cols[4]) * 1000 : null,
      rx: Number(cols[5]) || 0,
      tx: Number(cols[6]) || 0,
    };
  } catch {
    return null;
  }
}

module.exports = {
  generateKeypair, publicKeyFor, renderConfig,
  isAvailable, writeConfig, up, down, stats,
};
