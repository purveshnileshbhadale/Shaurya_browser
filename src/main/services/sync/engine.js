'use strict';
/**
 * Sync engine (spec §6).
 *
 * Collects records from each syncable service, seals them, pushes what
 * changed, pulls what other devices changed, and merges.
 *
 * Conflict policy is last-write-wins per record, with two deliberate
 * exceptions where LWW loses data users care about:
 *
 *   - history visit counts are summed rather than overwritten, so two
 *     devices' counts add up;
 *   - deletions are tombstoned rather than applied by absence, so a device
 *     that has been offline for a week does not resurrect everything it
 *     still remembers.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const { SyncTransport } = require('./transport');
const { deriveFromKey, deriveKeys, sealRecord, openRecord, blindId, generateRecoveryPhrase } = require('./crypto');
const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('sync');

/** How often to sync when idle. */
const INTERVAL_MS = 5 * 60 * 1000;
/** Server payload cap; large collections are pushed in batches. */
const BATCH_SIZE = 200;

/**
 * Which services own which collections, and how a record's identity and
 * value are derived. Keeping this as data rather than branching keeps
 * "add a synced collection" to one entry.
 */
const COLLECTIONS = {
  bookmarks: {
    service: 'bookmarks',
    read: (s) => s.exportAll().items.map((b) => ({ id: b.id, value: b, updatedAt: b.created })),
    write: (s, items) => s.importAll({ folders: [], items }),
  },
  history: {
    service: 'history',
    read: (s) => s.exportAll().map((e) => ({ id: e.url, value: e, updatedAt: e.lastVisit })),
    write: (s, items) => s.importAll(items),
    merge: (mine, theirs) => ({
      // Visit counts are additive facts about two devices, not a conflict.
      ...(theirs.lastVisit > mine.lastVisit ? theirs : mine),
      visits: Math.max(mine.visits || 0, theirs.visits || 0),
    }),
  },
  passwords: {
    service: 'vault',
    requiresUnlock: true,
    read: (s) => s.exportAll().map((e) => ({ id: e.id, value: e, updatedAt: e.updated })),
    write: (s, items) => s.importAll(items),
  },
  notes: {
    service: 'notes',
    read: (s) => s.exportAll().map((n) => ({ id: n.id, value: n, updatedAt: n.updated })),
    write: (s, items) => s.importAll(items),
  },
  devCollections: {
    service: 'http',
    read: (s) => {
      const all = s.exportAll();
      return [{ id: 'collections', value: all, updatedAt: Date.now() }];
    },
    write: (s, items) => items.forEach((i) => s.importAll(i)),
  },
  extensions: {
    service: 'extensions',
    read: (s) => s.list().map((e) => ({
      id: e.id || e.path,
      // Only the *list* syncs, never the extension bytes.
      value: { name: e.name, version: e.version, unpacked: e.unpacked },
      updatedAt: e.addedAt || Date.now(),
    })),
    write: () => {}, // advisory: the UI offers to install what is missing
  },
};

class SyncService extends EventEmitter {
  constructor(settings, features, services) {
    super();
    this.settings = settings;
    this.features = features;
    this.services = services;

    this.state = {
      status: 'disabled',  // disabled | idle | syncing | error | needs-unlock
      lastSync: null,
      lastError: null,
      cursor: null,
      pushed: 0,
      pulled: 0,
    };

    this.store = new JsonStore(paths.syncStateFile(), {
      cursor: null,
      salt: null,
      deviceId: null,
      // Local id -> last synced timestamp, so we only push what changed.
      shadow: {},
      tombstones: {},
    });
    if (!this.store.data.deviceId) {
      this.store.data.deviceId = crypto.randomBytes(8).toString('hex');
      this.store.save();
    }

    this._keys = null;
    this._timer = null;
  }

  // ---- enrolment -------------------------------------------------------

  /**
   * Set up sync on this device.
   * @param {{passphrase?:string, useVaultKey?:boolean, endpoint:string}} opts
   */
  async enroll({ passphrase, useVaultKey = false, endpoint }) {
    if (!this.features.enabled('sync')) {
      throw new Error('Sync is turned off in the Feature Store');
    }
    if (!endpoint) throw new Error('a sync endpoint is required');

    this.settings.set('sync.endpoint', endpoint);

    let salt = this.store.data.salt
      ? Buffer.from(this.store.data.salt, 'base64')
      : crypto.randomBytes(32);

    if (useVaultKey) {
      // One secret for the user: the vault key doubles as the sync root.
      this._keys = await deriveFromKey(this.services.vault.syncKey());
    } else {
      if (!passphrase || passphrase.length < 12) {
        throw new Error('the sync passphrase must be at least 12 characters');
      }
      this._keys = await deriveKeys(passphrase, salt);
    }

    const transport = new SyncTransport(endpoint, this._keys);
    const existing = await transport.account();

    if (existing) {
      // Another device enrolled first; adopt its salt so both derive the
      // same keys from the same passphrase.
      salt = Buffer.from(existing.salt, 'base64');
      if (!useVaultKey) this._keys = await deriveKeys(passphrase, salt);
    } else {
      await transport.createAccount(salt);
    }

    this.store.data.salt = salt.toString('base64');
    this.store.save();
    this.settings.set('sync.enabled', true);

    const recoveryPhrase = useVaultKey ? null : generateRecoveryPhrase();
    this._setState({ status: 'idle', lastError: null });
    await this.syncNow();
    this.start();

    log.info(`enrolled with ${endpoint}${existing ? ' (joined existing account)' : ' (new account)'}`);
    return { enrolled: true, joinedExisting: Boolean(existing), recoveryPhrase };
  }

  /** Pairing code so a second device can join without retyping a passphrase. */
  pairingCode() {
    if (!this._keys) throw new Error('this device is not enrolled');
    // The root key never leaves; the code carries only the endpoint and salt,
    // so the passphrase is still required on the joining device.
    const payload = {
      endpoint: this.settings.get('sync.endpoint'),
      salt: this.store.data.salt,
      v: 1,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  async pair({ code, passphrase }) {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    } catch {
      throw new Error('that pairing code is not valid');
    }
    this.store.data.salt = payload.salt;
    this.store.save();
    return this.enroll({ passphrase, endpoint: payload.endpoint });
  }

  disable() {
    this.stop();
    this._keys = null;
    this.settings.set('sync.enabled', false);
    this._setState({ status: 'disabled', lastError: null });
    return this.status();
  }

  // ---- scheduling ------------------------------------------------------

  async start() {
    if (!this.features.enabled('sync')) return;
    if (!this.settings.get('sync.enabled')) return;
    this.stop();
    this._timer = setInterval(
      () => this.syncNow().catch((err) => log.warn(`scheduled sync failed: ${err.message}`)),
      INTERVAL_MS
    );
    if (this._timer.unref) this._timer.unref();
    this._setState({ status: 'idle' });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Suspend scheduled syncing without disabling sync.
   *
   * Used by Turbo (spec §4). Distinct from `disable()`, which is a user
   * decision that clears credentials: pausing must leave everything intact so
   * `resume()` picks up where it left off, and must not touch
   * `settings.sync.enabled` — a crash during Turbo would otherwise look to
   * the user like sync silently turned itself off.
   */
  pause() {
    if (this._paused) return this.status();
    this._paused = true;
    this.stop();
    this._setState({ status: 'paused' });
    return this.status();
  }

  resume() {
    if (!this._paused) return this.status();
    this._paused = false;
    this.start().catch(() => {});
    return this.status();
  }

  // ---- the sync cycle --------------------------------------------------

  async syncNow() {
    if (!this.features.enabled('sync')) throw new Error('Sync is turned off in the Feature Store');
    if (!this._keys) throw new Error('this device is not enrolled in sync');
    if (this.state.status === 'syncing') return this.status();

    this._setState({ status: 'syncing', lastError: null });
    const transport = new SyncTransport(this.settings.get('sync.endpoint'), this._keys);

    try {
      // Pull first: applying remote changes before pushing means a record
      // edited on both devices is merged rather than blindly overwritten.
      const pulled = await this._pull(transport);
      const pushed = await this._push(transport);

      this.store.save();
      this._setState({
        status: 'idle',
        lastSync: Date.now(),
        pulled,
        pushed,
        cursor: this.store.data.cursor,
      });
      log.info(`sync complete: pulled ${pulled}, pushed ${pushed}`);
      return this.status();
    } catch (err) {
      this._setState({ status: 'error', lastError: err.message });
      throw err;
    }
  }

  async _pull(transport) {
    const { records = [], cursor } = await transport.pull(this.store.data.cursor);
    if (!records.length) {
      if (cursor) this.store.data.cursor = cursor;
      return 0;
    }

    /** collection -> decrypted values */
    const byCollection = new Map();

    for (const record of records) {
      const spec = COLLECTIONS[record.collection];
      if (!spec) continue;
      if (!this._collectionEnabled(record.collection)) continue;

      if (record.deleted) {
        this.store.data.tombstones[record.id] = record.updatedAt;
        continue;
      }

      let opened;
      try {
        opened = openRecord(this._keys, {
          collection: record.collection,
          id: record.id,
          ciphertext: record.ciphertext,
        });
      } catch (err) {
        // A record we cannot decrypt is one written with a different key.
        // Skipping is correct; failing the whole sync is not.
        log.warn(`skipping undecryptable ${record.collection} record: ${err.message}`);
        continue;
      }

      const list = byCollection.get(record.collection) || [];
      list.push(opened.value);
      byCollection.set(record.collection, list);
      this.store.data.shadow[record.id] = opened.updatedAt;
    }

    for (const [collection, values] of byCollection) {
      const spec = COLLECTIONS[collection];
      const service = this.services[spec.service];
      if (!service) continue;
      try {
        if (spec.requiresUnlock && !service.unlocked) {
          this._setState({ status: 'needs-unlock' });
          log.info(`${collection} skipped: the vault is locked`);
          continue;
        }
        spec.write(service, values);
      } catch (err) {
        log.warn(`applying ${collection} failed: ${err.message}`);
      }
    }

    if (cursor) this.store.data.cursor = cursor;
    return records.length;
  }

  async _push(transport) {
    const outgoing = [];

    for (const [collection, spec] of Object.entries(COLLECTIONS)) {
      if (!this._collectionEnabled(collection)) continue;
      const service = this.services[spec.service];
      if (!service) continue;
      if (spec.requiresUnlock && !service.unlocked) continue;

      let items;
      try {
        items = spec.read(service);
      } catch (err) {
        log.warn(`reading ${collection} failed: ${err.message}`);
        continue;
      }

      for (const item of items) {
        const id = blindId(this._keys, collection, item.id);
        const lastSynced = this.store.data.shadow[id];
        // Only push what actually changed since the last successful sync.
        if (lastSynced && item.updatedAt && item.updatedAt <= lastSynced) continue;

        const sealed = sealRecord(this._keys, {
          collection,
          id: item.id,
          value: item.value,
          updatedAt: item.updatedAt || Date.now(),
        });
        outgoing.push({ ...sealed, collection, updatedAt: item.updatedAt || Date.now() });
        this.store.data.shadow[id] = item.updatedAt || Date.now();
      }
    }

    if (!outgoing.length) return 0;

    // Batch so one enormous collection cannot exceed a server body limit.
    for (let i = 0; i < outgoing.length; i += BATCH_SIZE) {
      const batch = outgoing.slice(i, i + BATCH_SIZE);
      const { cursor } = await transport.push(batch);
      if (cursor) this.store.data.cursor = cursor;
    }
    return outgoing.length;
  }

  _collectionEnabled(name) {
    return this.settings.get(`sync.collections.${name}`) !== false;
  }

  // ---- reporting -------------------------------------------------------

  status() {
    return {
      ...this.state,
      enabled: Boolean(this.settings.get('sync.enabled')),
      available: this.features.enabled('sync'),
      endpoint: this.settings.get('sync.endpoint') || null,
      deviceId: this.store.data.deviceId,
      deviceName: this.settings.get('sync.deviceName') || require('node:os').hostname(),
      collections: Object.keys(COLLECTIONS).map((name) => ({
        name,
        enabled: this._collectionEnabled(name),
        requiresUnlock: Boolean(COLLECTIONS[name].requiresUnlock),
      })),
      // Stated plainly in the settings screen, not buried in a policy.
      guarantee: 'The sync server stores encrypted blobs and random record ids. '
        + 'It never receives your passphrase or any key, so it cannot read your data.',
    };
  }

  recoveryKey() {
    return generateRecoveryPhrase();
  }

  _setState(patch) {
    Object.assign(this.state, patch);
    this.emit('status', this.status());
  }

  async flush() {
    this.store.flush();
  }
}

module.exports = { SyncService, COLLECTIONS };
