'use strict';
/**
 * Profile service — isolated browsing contexts.
 *
 * Each profile owns an Electron `Session`, which in Chromium terms means its
 * own cookie jar, cache, storage, service workers, permissions and extension
 * set. That is what makes "client work / personal / testing" genuinely
 * cookie-tight rather than cosmetically separated (spec §5).
 *
 * Three flavours:
 *   - `normal`    persistent, on disk
 *   - `dev`       persistent, and the only kind where the CORS relaxation
 *                 switch is even offered (spec §5)
 *   - `incognito` in-memory only; the partition string omits `persist:` so
 *                 Chromium never writes it out, and we destroy it on close
 */
const EventEmitter = require('node:events');
const { session, app } = require('electron');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('profiles');

const PALETTE = ['#6C8CFF', '#4CC9A7', '#F7A072', '#C77DFF', '#FF6B8A', '#5BC0EB', '#F5D547'];

class ProfileService extends EventEmitter {
  /**
   * @param {import('./settings').SettingsService} settings
   * @param {import('./feature-store').FeatureStore} features
   */
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.store = new JsonStore(paths.userData('profiles.json'), {
      active: 'default',
      profiles: [
        { id: 'default', name: 'Personal', kind: 'normal', color: PALETTE[0], created: 0 },
      ],
    });
    /** @type {Map<string, {profile:object, session:Electron.Session}>} */
    this._live = new Map();
    /** Hooks other services register to configure every session they see. */
    this._configurators = [];
  }

  // ---- catalogue -------------------------------------------------------

  list() {
    return this.store.data.profiles.map((p) => ({
      ...p,
      active: p.id === this.store.data.active,
      live: this._live.has(p.id),
    }));
  }

  /** The profile currently in use. */
  active() {
    return this.get(this.activeId);
  }

  get(id) {
    return this.store.data.profiles.find((p) => p.id === id) || null;
  }

  get activeId() {
    return this.store.data.active;
  }

  create({ name, kind = 'normal', color } = {}) {
    const profile = {
      id: uid('p_'),
      name: name || `Profile ${this.store.data.profiles.length + 1}`,
      kind,
      color: color || PALETTE[this.store.data.profiles.length % PALETTE.length],
      created: Date.now(),
    };
    this.store.data.profiles.push(profile);
    this.store.save();
    this.emit('changed', this.list());
    log.info(`created ${kind} profile "${profile.name}" (${profile.id})`);
    return profile;
  }

  update(id, patch) {
    const p = this.get(id);
    if (!p) throw new Error(`unknown profile ${id}`);
    Object.assign(p, patch, { id: p.id, kind: p.kind });
    this.store.save();
    this.emit('changed', this.list());
    return p;
  }

  remove(id) {
    if (id === 'default') throw new Error('the default profile cannot be removed');
    const idx = this.store.data.profiles.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.store.data.profiles.splice(idx, 1);
    if (this.store.data.active === id) this.store.data.active = 'default';
    this.store.save();
    const live = this._live.get(id);
    if (live) {
      live.session.clearStorageData().catch(() => {});
      this._live.delete(id);
    }
    this.emit('changed', this.list());
    return true;
  }

  switch(id) {
    if (!this.get(id)) throw new Error(`unknown profile ${id}`);
    this.store.data.active = id;
    this.store.save();
    this.emit('changed', this.list());
    this.emit('switched', id);
    return id;
  }

  // ---- sessions --------------------------------------------------------

  /**
   * Register a function run once per newly-created session. Adblock,
   * permissions, HTTPS-only, VPN proxy and extensions all attach this way,
   * so a profile created at runtime is configured identically to one that
   * existed at boot.
   *
   * @param {(sess:Electron.Session, profile:object) => void} fn
   */
  addConfigurator(fn) {
    this._configurators.push(fn);
    // Retro-apply to sessions that already exist.
    for (const { profile, session: sess } of this._live.values()) fn(sess, profile);
  }

  /** Partition string for a profile. `persist:` is what makes it durable. */
  partitionFor(profile) {
    if (profile.kind === 'incognito') return `incognito-${profile.id}`;
    return `persist:aether-${profile.id}`;
  }

  /**
   * Get (creating if needed) the Electron session for a profile id.
   * @returns {Electron.Session}
   */
  sessionFor(id = this.activeId) {
    const existing = this._live.get(id);
    if (existing) return existing.session;

    const profile = this.get(id);
    if (!profile) throw new Error(`unknown profile ${id}`);

    const sess = session.fromPartition(this.partitionFor(profile), {
      cache: profile.kind !== 'incognito',
    });

    // A browser must not advertise Electron: sites gate features on it and
    // some block it outright. Present as the Chromium we actually embed.
    const chromeVersion = process.versions.chrome;
    sess.setUserAgent(
      sess.getUserAgent()
        .replace(/ Electron\/[\d.]+/, '')
        .replace(/ aether-browser\/[\d.]+/i, '')
        .replace(/Chrome\/[\d.]+/, `Chrome/${chromeVersion}`)
    );

    this._live.set(id, { profile, session: sess });
    for (const fn of this._configurators) {
      try { fn(sess, profile); } catch (err) { log.error(`configurator failed: ${err.message}`); }
    }
    log.info(`session ready for "${profile.name}" (${this.partitionFor(profile)})`);
    return sess;
  }

  /**
   * Spin up a throwaway incognito profile. Multiple simultaneous incognito
   * windows each get their own, so two private windows do not share a
   * cookie jar (spec §3).
   */
  createIncognito() {
    const profile = {
      id: uid('inc_'),
      name: 'Private',
      kind: 'incognito',
      color: '#8B5CF6',
      created: Date.now(),
      ephemeral: true,
    };
    // Deliberately not persisted to profiles.json.
    this.store.data.profiles.push(profile);
    this._live.delete(profile.id);
    this.sessionFor(profile.id);
    log.info(`incognito context ${profile.id} created`);
    return profile;
  }

  /** Destroy an incognito context and everything Chromium buffered for it. */
  async destroyIncognito(id) {
    const profile = this.get(id);
    if (!profile || profile.kind !== 'incognito') return;
    const live = this._live.get(id);
    if (live) {
      try {
        await live.session.clearStorageData();
        await live.session.clearCache();
        await live.session.clearAuthCache();
        await live.session.clearHostResolverCache();
      } catch (err) {
        log.warn(`incognito teardown incomplete: ${err.message}`);
      }
      this._live.delete(id);
    }
    const idx = this.store.data.profiles.findIndex((p) => p.id === id);
    if (idx >= 0) this.store.data.profiles.splice(idx, 1);
    log.info(`incognito context ${id} destroyed`);
  }

  /** Honour settings.privacy.clearOnExit for every persistent profile. */
  async clearOnExit() {
    const kinds = this.settings.get('privacy.clearOnExit') || [];
    if (!kinds.length) return;
    for (const { profile, session: sess } of this._live.values()) {
      if (profile.kind === 'incognito') continue;
      if (kinds.includes('cache')) await sess.clearCache().catch(() => {});
      const storages = kinds.filter((k) => k !== 'cache');
      if (storages.length) {
        await sess.clearStorageData({ storages }).catch(() => {});
      }
    }
    log.info(`cleared on exit: ${kinds.join(', ')}`);
  }
}

module.exports = { ProfileService, PALETTE };
