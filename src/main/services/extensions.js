'use strict';
/**
 * Chrome extension support, including developer mode with hot reload and a
 * manifest linter (spec §1 and §5).
 *
 * Manifest V3 is what the Chrome Web Store ships today, and Electron's
 * extension host implements it on the same Chromium build the rest of the
 * browser runs on. Extensions load per session, so a profile's extension set
 * is genuinely its own and an incognito context starts with none.
 *
 * What "zero shims" means in practice: we do not translate MV3 APIs or
 * rewrite manifests. Anything Electron's extension host does not implement
 * is reported by the linter as a real gap rather than papered over, because
 * a silently half-working extension is worse than one that says why.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { shell } = require('electron');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { createLogger } = require('../util/logger');

const log = createLogger('extensions');

/** Debounce window for hot reload; editors write several files in a burst. */
const RELOAD_DEBOUNCE_MS = 300;

/**
 * MV3 permissions Electron's extension host does not currently back. The
 * linter names these explicitly so a developer knows what will not fire.
 */
const UNSUPPORTED_PERMISSIONS = new Set([
  'debugger', 'declarativeNetRequestFeedback', 'enterprise.platformKeys',
  'platformKeys', 'printing', 'vpnProvider', 'wallpaper', 'certificateProvider',
]);

class ExtensionService extends EventEmitter {
  constructor(settings, features, profiles) {
    super();
    this.settings = settings;
    this.features = features;
    this.profiles = profiles;

    this.store = new JsonStore(paths.userData('extensions.json'), {
      installed: [],   // { id, path, name, version, unpacked, enabled }
    });
    /** sessionKey -> Map<extensionId, Electron.Extension> */
    this._loaded = new Map();
    /** extension path -> fs.FSWatcher */
    this._watchers = new Map();
    this._sessions = new Set();
  }

  async init() {
    // Nothing eager: extensions load per session as profiles come up.
    if (this.settings.get('devtools.hotReloadExtensions') && this.features.enabled('extensionDev')) {
      this._startWatchers();
    }
  }

  /** Load this profile's extensions into its session. */
  attach(sess, profile) {
    this._sessions.add(sess);
    // Private windows start with no extensions at all: an extension with
    // host permissions would otherwise see everything the user browsed
    // privately (spec §3).
    if (profile?.kind === 'incognito') return;

    this._loadAll(sess).catch((err) => log.error(`load failed: ${err.message}`));
  }

  async _loadAll(sess) {
    const key = sess.storagePath || String(this._sessions.size);
    if (!this._loaded.has(key)) this._loaded.set(key, new Map());
    const map = this._loaded.get(key);

    for (const record of this.store.data.installed) {
      if (!record.enabled) continue;
      if (record.unpacked && !this.features.enabled('extensionDev')) continue;
      try {
        const ext = await sess.extensions.loadExtension(record.path, {
          allowFileAccess: Boolean(record.allowFileAccess),
        });
        map.set(ext.id, { ext, session: sess });
        record.id = ext.id;
        record.name = ext.name;
        record.version = ext.version;
        record.error = null;
      } catch (err) {
        record.error = err.message;
        log.warn(`could not load ${record.path}: ${err.message}`);
      }
    }
    this.store.save();
    this.emit('changed', this.list());
  }

  // ---- install / remove ------------------------------------------------

  /**
   * Load an unpacked extension from a directory (developer mode).
   * @param {{path:string, allowFileAccess?:boolean}} opts
   */
  async load({ path: dir, allowFileAccess = false }) {
    if (!this.features.enabled('extensionDev')) {
      throw new Error('Extension developer mode is turned off in the Feature Store');
    }
    const lint = await this.lint(dir);
    if (!lint.valid) {
      throw new Error(`manifest problems: ${lint.errors.map((e) => e.message).join('; ')}`);
    }

    const existing = this.store.data.installed.find((r) => r.path === dir);
    const record = existing || {
      path: dir,
      unpacked: true,
      enabled: true,
      allowFileAccess,
      addedAt: Date.now(),
    };
    if (!existing) this.store.data.installed.push(record);
    record.enabled = true;
    this.store.save();

    for (const sess of this._sessions) {
      try {
        const ext = await sess.extensions.loadExtension(dir, { allowFileAccess });
        record.id = ext.id;
        record.name = ext.name;
        record.version = ext.version;
        record.error = null;
      } catch (err) {
        record.error = err.message;
        throw err;
      }
    }

    if (this.settings.get('devtools.hotReloadExtensions')) this._watch(dir);
    this.store.save();
    this.emit('changed', this.list());
    log.info(`loaded unpacked extension "${record.name}" from ${dir}`);
    return { ...record, lint };
  }

  async remove(id) {
    const idx = this.store.data.installed.findIndex((r) => r.id === id || r.path === id);
    if (idx < 0) return false;
    const [record] = this.store.data.installed.splice(idx, 1);

    for (const sess of this._sessions) {
      try {
        if (record.id) sess.extensions.removeExtension(record.id);
      } catch (err) {
        log.debug(`remove from session failed: ${err.message}`);
      }
    }
    this._unwatch(record.path);
    this.store.save();
    this.emit('changed', this.list());
    return true;
  }

  /** Unload and reload — the core of hot reload. */
  async reload(id) {
    const record = this.store.data.installed.find((r) => r.id === id || r.path === id);
    if (!record) throw new Error('no such extension');

    for (const sess of this._sessions) {
      try {
        if (record.id) sess.extensions.removeExtension(record.id);
      } catch { /* was not loaded in this session */ }
      try {
        const ext = await sess.extensions.loadExtension(record.path, {
          allowFileAccess: Boolean(record.allowFileAccess),
        });
        record.id = ext.id;
        record.version = ext.version;
        record.error = null;
      } catch (err) {
        record.error = err.message;
        log.warn(`reload failed: ${err.message}`);
      }
    }
    this.store.save();
    this.emit('changed', this.list());
    this.emit('reloaded', { id: record.id, name: record.name });
    return record;
  }

  setEnabled(id, enabled) {
    const record = this.store.data.installed.find((r) => r.id === id || r.path === id);
    if (!record) throw new Error('no such extension');
    record.enabled = enabled;
    this.store.save();
    if (enabled) this.reload(record.id || record.path);
    else {
      for (const sess of this._sessions) {
        try { if (record.id) sess.extensions.removeExtension(record.id); } catch { /* not loaded */ }
      }
      this.emit('changed', this.list());
    }
    return record;
  }

  list() {
    return this.store.data.installed.map((r) => ({ ...r }));
  }

  /**
   * Unload every enabled extension, returning the ids that were touched.
   *
   * Used by Turbo (spec §4). The `enabled` flag is deliberately *not*
   * written: this is a temporary suspension, and persisting it would mean a
   * crash while Turbo was on left the user's extensions permanently off with
   * no record of why.
   *
   * @returns {Promise<string[]>} ids to hand back to `resume()`
   */
  async suspendAll() {
    const suspended = [];
    for (const record of this.store.data.installed) {
      if (!record.enabled || !record.id) continue;
      for (const sess of this._sessions) {
        try { sess.extensions.removeExtension(record.id); } catch { /* not loaded here */ }
      }
      suspended.push(record.id);
    }
    if (suspended.length) this.emit('changed', this.list());
    return suspended;
  }

  /** Reload exactly the extensions `suspendAll()` unloaded. */
  async resume(ids = []) {
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.reload(id);
      } catch { /* an extension removed while suspended is simply gone */ }
    }
    if (ids.length) this.emit('changed', this.list());
    return this.list();
  }

  /** Open the Chrome Web Store, which installs into the current profile. */
  openStore() {
    return 'https://chromewebstore.google.com/';
  }

  // ---- hot reload ------------------------------------------------------

  _startWatchers() {
    for (const record of this.store.data.installed) {
      if (record.unpacked && record.enabled) this._watch(record.path);
    }
  }

  _watch(dir) {
    if (this._watchers.has(dir)) return;
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        // Editors write temp files and swap; ignore the noise.
        if (filename && /(\.swp|~|\.tmp|^\.git)/.test(filename)) return;
        clearTimeout(this._reloadTimers?.[dir]);
        this._reloadTimers ||= {};
        this._reloadTimers[dir] = setTimeout(() => {
          log.info(`change detected in ${dir}; reloading`);
          this.reload(dir).catch((err) => log.warn(`hot reload: ${err.message}`));
        }, RELOAD_DEBOUNCE_MS);
      });
      this._watchers.set(dir, watcher);
      log.info(`watching ${dir} for changes`);
    } catch (err) {
      // Recursive watch is unsupported on some Linux filesystems.
      log.warn(`could not watch ${dir}: ${err.message}`);
    }
  }

  _unwatch(dir) {
    const watcher = this._watchers.get(dir);
    if (watcher) {
      watcher.close();
      this._watchers.delete(dir);
    }
  }

  stopWatching() {
    for (const [dir] of this._watchers) this._unwatch(dir);
  }

  setDevMode(enabled) {
    this.settings.set('devtools.hotReloadExtensions', enabled);
    if (enabled) this._startWatchers();
    else this.stopWatching();
    return enabled;
  }

  // ---- manifest linter -------------------------------------------------

  /**
   * Check a manifest for the mistakes that cost the most debugging time,
   * plus anything this runtime genuinely cannot honour.
   *
   * @param {string} dir
   * @returns {Promise<{valid:boolean, errors:Array, warnings:Array, manifest:object|null}>}
   */
  async lint(dir) {
    const errors = [];
    const warnings = [];
    let manifest = null;

    const manifestPath = path.join(dir, 'manifest.json');
    let raw;
    try {
      raw = await fsp.readFile(manifestPath, 'utf8');
    } catch {
      return {
        valid: false, manifest: null, warnings,
        errors: [{ field: 'manifest.json', message: `no manifest.json in ${dir}` }],
      };
    }

    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      return {
        valid: false, manifest: null, warnings,
        errors: [{ field: 'manifest.json', message: `invalid JSON: ${err.message}` }],
      };
    }

    // --- required fields ---
    if (manifest.manifest_version !== 3) {
      if (manifest.manifest_version === 2) {
        errors.push({
          field: 'manifest_version',
          message: 'Manifest V2 is no longer accepted by the Chrome Web Store; migrate to V3',
        });
      } else {
        errors.push({ field: 'manifest_version', message: 'manifest_version must be 3' });
      }
    }
    if (!manifest.name) errors.push({ field: 'name', message: 'name is required' });
    if (!manifest.version) errors.push({ field: 'version', message: 'version is required' });
    else if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
      errors.push({ field: 'version', message: 'version must be 1–4 dot-separated integers' });
    }

    // --- V2 leftovers that silently do nothing under V3 ---
    if (manifest.background?.scripts) {
      errors.push({
        field: 'background.scripts',
        message: 'V3 uses background.service_worker, not background.scripts',
      });
    }
    if (manifest.browser_action || manifest.page_action) {
      errors.push({
        field: 'browser_action',
        message: 'V3 merges browser_action and page_action into "action"',
      });
    }
    if (manifest.web_accessible_resources?.some?.((r) => typeof r === 'string')) {
      errors.push({
        field: 'web_accessible_resources',
        message: 'V3 requires objects with "resources" and "matches", not bare strings',
      });
    }
    if (typeof manifest.content_security_policy === 'string') {
      errors.push({
        field: 'content_security_policy',
        message: 'V3 expects an object with extension_pages / sandbox keys',
      });
    }

    // --- referenced files must exist ---
    const referenced = [];
    if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
    if (manifest.action?.default_popup) referenced.push(manifest.action.default_popup);
    if (manifest.options_page) referenced.push(manifest.options_page);
    if (manifest.options_ui?.page) referenced.push(manifest.options_ui.page);
    for (const cs of manifest.content_scripts || []) {
      referenced.push(...(cs.js || []), ...(cs.css || []));
    }
    for (const icons of [manifest.icons, manifest.action?.default_icon]) {
      if (icons && typeof icons === 'object') referenced.push(...Object.values(icons));
      else if (typeof icons === 'string') referenced.push(icons);
    }
    for (const rel of [...new Set(referenced)]) {
      if (typeof rel !== 'string') continue;
      if (!fs.existsSync(path.join(dir, rel))) {
        errors.push({ field: 'files', message: `referenced file is missing: ${rel}` });
      }
    }

    // --- content script sanity ---
    for (const [i, cs] of (manifest.content_scripts || []).entries()) {
      if (!cs.matches?.length) {
        errors.push({ field: `content_scripts[${i}].matches`, message: 'matches is required' });
      }
      for (const pattern of cs.matches || []) {
        if (pattern !== '<all_urls>' && !/^(\*|https?|file|ftp):\/\/.+/.test(pattern)) {
          errors.push({
            field: `content_scripts[${i}].matches`,
            message: `"${pattern}" is not a valid match pattern`,
          });
        }
      }
    }

    // --- permissions ---
    const permissions = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
    for (const p of permissions) {
      if (UNSUPPORTED_PERMISSIONS.has(p)) {
        warnings.push({
          field: 'permissions',
          message: `"${p}" is not implemented by this runtime; APIs behind it will not fire`,
        });
      }
      if (/^(\*|https?):\/\//.test(p)) {
        warnings.push({
          field: 'permissions',
          message: `host permission "${p}" belongs in host_permissions under V3`,
        });
      }
    }
    if (permissions.includes('<all_urls>') || (manifest.host_permissions || []).includes('<all_urls>')) {
      warnings.push({
        field: 'host_permissions',
        message: '<all_urls> grants access to every site; reviewers scrutinise this heavily',
      });
    }

    // --- quality-of-life warnings ---
    if (!manifest.description) {
      warnings.push({ field: 'description', message: 'a description is shown in the store listing' });
    }
    if (!manifest.icons || !manifest.icons['128']) {
      warnings.push({ field: 'icons', message: 'a 128px icon is required for store submission' });
    }

    return { valid: errors.length === 0, errors, warnings, manifest };
  }
}

module.exports = { ExtensionService, UNSUPPORTED_PERMISSIONS };
