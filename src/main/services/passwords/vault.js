'use strict';
/**
 * Encrypted password vault (spec §3).
 *
 * Design constraints, in priority order:
 *
 *  1. The master password is never stored, anywhere, in any form.
 *  2. The file on disk is opaque without it — including the entry metadata,
 *     not just the passwords. A vault that leaks "this user has an account
 *     at these 300 sites" is a privacy failure even if no password escapes.
 *  3. Decrypted secrets live in memory only while unlocked, and are wiped on
 *     lock, on idle timeout, and at shutdown.
 *  4. The same key material serves end-to-end encrypted sync, so the server
 *     side is zero-knowledge by construction rather than by policy.
 *
 * Crypto: scrypt for the KDF (memory-hard, in Node's standard library, no
 * native dependency) and AES-256-GCM for the sealed blob (authenticated, so
 * a tampered file fails to open rather than decrypting to garbage).
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { promisify } = require('node:util');
const paths = require('../../util/paths');
const { uid } = require('../../util/id');
const { checkPassword, checkMany } = require('./breach');
const { createLogger } = require('../../util/logger');

const scrypt = promisify(crypto.scrypt);
const log = createLogger('vault');

const FORMAT_VERSION = 1;
/**
 * scrypt parameters. N=2^17 with r=8 costs roughly 128 MiB and ~250ms on a
 * current laptop — slow enough to make offline guessing expensive, fast
 * enough that unlocking does not feel broken.
 */
const KDF = { N: 1 << 17, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };
/** Auto-lock after this much inactivity. */
const IDLE_LOCK_MS = 15 * 60 * 1000;

class VaultService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.file = paths.vaultFile();

    /** Cleartext entries; null whenever the vault is locked. */
    this._entries = null;
    /** Derived key; zeroed on lock. */
    this._key = null;
    this._meta = this._readMeta();
    this._idleTimer = null;
  }

  // ---- state -----------------------------------------------------------

  _readMeta() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        version: raw.version,
        kdf: raw.kdf,
        salt: raw.salt,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        // Entry *count* is not secret and lets the UI show something useful
        // while locked; nothing about which sites is exposed.
        entryCount: raw.entryCount ?? null,
      };
    } catch {
      return null;
    }
  }

  get exists() {
    return this._meta !== null;
  }

  get unlocked() {
    return this._entries !== null;
  }

  status() {
    return {
      exists: this.exists,
      unlocked: this.unlocked,
      entryCount: this.unlocked ? this._entries.length : this._meta?.entryCount ?? 0,
      createdAt: this._meta?.createdAt ?? null,
      updatedAt: this._meta?.updatedAt ?? null,
      available: this.features.enabled('passwords'),
      idleLockMinutes: IDLE_LOCK_MS / 60000,
    };
  }

  // ---- lifecycle -------------------------------------------------------

  /**
   * Create a new vault.
   * @param {{masterPassword:string}} opts
   * @returns {Promise<{recoveryKey:string}>}
   */
  async create({ masterPassword }) {
    if (this.exists) throw new Error('a vault already exists');
    if (!masterPassword || masterPassword.length < 10) {
      throw new Error('the master password must be at least 10 characters');
    }

    const salt = crypto.randomBytes(32);
    this._key = await scrypt(masterPassword, salt, KDF.keylen, KDF);
    this._entries = [];
    this._meta = {
      version: FORMAT_VERSION,
      kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p },
      salt: salt.toString('base64'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entryCount: 0,
    };

    // A recovery key is a second, independently-derived way in, so losing
    // the master password is not automatically fatal. It is shown once and
    // never stored — only a wrapped copy of the vault key is.
    const recoveryKey = formatRecoveryKey(crypto.randomBytes(20));
    const recoverySalt = crypto.randomBytes(32);
    const recoveryDerived = await scrypt(
      recoveryKey.replace(/-/g, ''), recoverySalt, KDF.keylen, KDF);
    this._meta.recovery = {
      salt: recoverySalt.toString('base64'),
      wrapped: seal(recoveryDerived, this._key).toString('base64'),
    };

    await this._persist();
    this._armIdleTimer();
    this.emit('status', this.status());
    log.info('vault created');
    return { recoveryKey };
  }

  /**
   * @param {{masterPassword?:string, recoveryKey?:string}} opts
   */
  async unlock({ masterPassword, recoveryKey }) {
    if (!this.exists) throw new Error('no vault exists yet');
    if (this.unlocked) return this.status();

    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));

    let key;
    if (recoveryKey) {
      const rec = raw.recovery;
      if (!rec) throw new Error('this vault has no recovery key');
      const derived = await scrypt(
        recoveryKey.replace(/-/g, '').toUpperCase(),
        Buffer.from(rec.salt, 'base64'), KDF.keylen, KDF);
      try {
        key = open(derived, Buffer.from(rec.wrapped, 'base64'));
      } catch {
        throw new Error('that recovery key is not correct');
      }
    } else {
      key = await scrypt(
        masterPassword || '',
        Buffer.from(raw.salt, 'base64'),
        KDF.keylen,
        raw.kdf?.N ? { ...KDF, N: raw.kdf.N, r: raw.kdf.r, p: raw.kdf.p } : KDF
      );
    }

    let plaintext;
    try {
      plaintext = open(key, Buffer.from(raw.blob, 'base64'));
    } catch {
      // GCM authentication failed: wrong key, or the file was tampered with.
      // Both are "you cannot open this", and distinguishing them would leak.
      throw new Error('incorrect master password');
    }

    this._key = key;
    this._entries = JSON.parse(plaintext.toString('utf8'));
    this._meta = this._readMeta();
    this._armIdleTimer();
    this.emit('status', this.status());
    log.info(`vault unlocked (${this._entries.length} entries)`);
    return this.status();
  }

  lock() {
    if (this._key) this._key.fill(0);
    this._key = null;
    this._entries = null;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this.emit('status', this.status());
    return this.status();
  }

  _armIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      log.info('auto-locking after inactivity');
      this.lock();
    }, IDLE_LOCK_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _requireUnlocked() {
    if (!this.features.enabled('passwords')) {
      throw new Error('The password manager is turned off in the Feature Store');
    }
    if (!this.unlocked) throw new Error('the vault is locked');
    this._armIdleTimer();
  }

  async _persist() {
    const plaintext = Buffer.from(JSON.stringify(this._entries), 'utf8');
    const blob = seal(this._key, plaintext);
    this._meta.updatedAt = Date.now();
    this._meta.entryCount = this._entries.length;

    const document = {
      version: FORMAT_VERSION,
      kdf: this._meta.kdf,
      salt: this._meta.salt,
      recovery: this._meta.recovery,
      createdAt: this._meta.createdAt,
      updatedAt: this._meta.updatedAt,
      entryCount: this._meta.entryCount,
      blob: blob.toString('base64'),
    };

    // Write-then-rename so a crash cannot truncate the only copy of a
    // user's passwords.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(document), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
    plaintext.fill(0);
  }

  // ---- entries ---------------------------------------------------------

  /** Entries without their passwords — safe to send to the renderer. */
  list() {
    this._requireUnlocked();
    return this._entries.map(redact);
  }

  add({ origin, username, password, title, notes, totp }) {
    this._requireUnlocked();
    if (!origin || !password) throw new Error('an entry needs an origin and a password');

    const entry = {
      id: uid('pw_'),
      origin: normaliseOrigin(origin),
      username: username || '',
      password,
      title: title || normaliseOrigin(origin),
      notes: notes || '',
      totp: totp || null,
      created: Date.now(),
      updated: Date.now(),
      lastUsed: null,
      // Recorded so the health report can flag stale and reused credentials.
      passwordChanged: Date.now(),
    };
    this._entries.push(entry);
    this._persist();
    this.emit('changed');
    return redact(entry);
  }

  update(id, patch) {
    this._requireUnlocked();
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) throw new Error('no such entry');
    if (patch.password && patch.password !== entry.password) {
      entry.passwordChanged = Date.now();
    }
    Object.assign(entry, patch, { id: entry.id, updated: Date.now() });
    if (patch.origin) entry.origin = normaliseOrigin(patch.origin);
    this._persist();
    this.emit('changed');
    return redact(entry);
  }

  remove(id) {
    this._requireUnlocked();
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this._entries.splice(idx, 1);
    this._persist();
    this.emit('changed');
    return true;
  }

  /**
   * Reveal one password. Separate from list() so that the secret crosses the
   * IPC boundary only on an explicit, per-entry user action.
   */
  reveal(id) {
    this._requireUnlocked();
    const entry = this._entries.find((e) => e.id === id);
    if (!entry) throw new Error('no such entry');
    entry.lastUsed = Date.now();
    this._persist();
    return { id, username: entry.username, password: entry.password, totp: entry.totp };
  }

  /** Candidates for autofill on a given page origin. */
  candidatesFor(origin) {
    if (!this.unlocked) return [];
    const target = normaliseOrigin(origin);
    const host = hostOf(target);
    return this._entries
      .filter((e) => {
        const eh = hostOf(e.origin);
        // Match the registrable domain so `accounts.example.com` offers the
        // credential saved on `example.com`, but `example.com.evil` does not.
        return eh === host || host.endsWith('.' + eh) || eh.endsWith('.' + host);
      })
      .map((e) => ({ id: e.id, username: e.username, title: e.title, origin: e.origin }));
  }

  // ---- generation & health --------------------------------------------

  /**
   * Generate a password using rejection-free uniform sampling.
   * `crypto.randomInt` avoids the modulo bias that `randomBytes()[i] % n`
   * introduces, which measurably shrinks the effective keyspace.
   */
  generate({ length = 20, symbols = true, digits = true, uppercase = true, avoidAmbiguous = true } = {}) {
    let alphabet = 'abcdefghijkmnopqrstuvwxyz';
    if (uppercase) alphabet += 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    if (digits) alphabet += '23456789';
    if (symbols) alphabet += '!@#$%^&*()-_=+[]{};:,.?';
    if (!avoidAmbiguous) alphabet += 'lIO01';

    let out = '';
    for (let i = 0; i < length; i++) {
      out += alphabet[crypto.randomInt(alphabet.length)];
    }
    return {
      password: out,
      entropyBits: Math.round(length * Math.log2(alphabet.length)),
    };
  }

  /**
   * Breach and hygiene report.
   *
   * Uses Have I Been Pwned's k-anonymity range API: only the first five hex
   * characters of the SHA-1 hash are sent, so the service learns neither the
   * password nor which of the ~500 returned suffixes was ours.
   */
  async breachCheck({ id } = {}) {
    this._requireUnlocked();
    const targets = id ? this._entries.filter((e) => e.id === id) : this._entries;

    const breaches = await checkMany(targets.map((e) => e.password));

    // Reuse detection is local and needs no network at all.
    const counts = new Map();
    for (const e of this._entries) {
      counts.set(e.password, (counts.get(e.password) || 0) + 1);
    }

    const now = Date.now();
    return targets.map((e, i) => ({
      id: e.id,
      title: e.title,
      origin: e.origin,
      username: e.username,
      breached: breaches[i] > 0,
      breachCount: breaches[i],
      reused: counts.get(e.password) > 1,
      weak: e.password.length < 12,
      stale: now - (e.passwordChanged || e.created) > 400 * 86400_000,
    }));
  }

  /** Check a single candidate password before the user commits to it. */
  async checkOne(password) {
    return { breachCount: await checkPassword(password) };
  }

  // ---- sync integration ------------------------------------------------

  /**
   * The vault key doubles as the sync key, which is what makes sync
   * zero-knowledge: the server stores a blob it cannot open.
   */
  syncKey() {
    this._requireUnlocked();
    // A separate key derived from the vault key, so a sync-side compromise
    // cannot be replayed against the local file.
    return crypto.createHmac('sha256', this._key).update('aether-sync-v1').digest();
  }

  exportAll() {
    this._requireUnlocked();
    return this._entries;
  }

  importAll(entries) {
    this._requireUnlocked();
    const byKey = new Map(this._entries.map((e) => [`${e.origin}|${e.username}`, e]));
    for (const incoming of entries) {
      const key = `${incoming.origin}|${incoming.username}`;
      const existing = byKey.get(key);
      if (!existing) {
        this._entries.push(incoming);
      } else if ((incoming.updated || 0) > (existing.updated || 0)) {
        Object.assign(existing, incoming);
      }
    }
    this._persist();
    this.emit('changed');
  }

  flush() {
    if (this.unlocked) this._persist();
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM seal: `nonce || ciphertext || tag`.
 * GCM is authenticated, so tampering is detected at open() time.
 */
function seal(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function open(key, sealed) {
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(12, sealed.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Crockford-ish grouping so a recovery key can be read aloud. */
function formatRecoveryKey(bytes) {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out.match(/.{1,5}/g).join('-');
}

function redact(entry) {
  const { password, ...rest } = entry;
  return { ...rest, hasPassword: Boolean(password), passwordLength: password?.length ?? 0 };
}

function normaliseOrigin(origin) {
  try {
    const u = new URL(origin);
    return u.origin;
  } catch {
    return String(origin).replace(/\/+$/, '');
  }
}

function hostOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

module.exports = { VaultService, seal, open, KDF };
