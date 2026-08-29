'use strict';
/**
 * Per-site permission control (spec §3).
 *
 * Chromium asks us twice about permissions and the distinction matters:
 *
 *   - `setPermissionRequestHandler` fires when a page *asks* (a click on
 *     "share my location"). We can prompt the user here.
 *   - `setPermissionCheckHandler` fires when a page *queries* current state,
 *     synchronously, often before any user gesture. Prompting is impossible;
 *     we must answer from stored policy alone.
 *
 * Getting the second one wrong is how browsers end up either silently
 * granting camera access or making `navigator.permissions.query()` lie.
 */
const EventEmitter = require('node:events');
const { uid } = require('../util/id');
const { baseDomain } = require('./adblock/matcher');
const { createLogger } = require('../util/logger');

const log = createLogger('permissions');

/** Permissions we surface in the address bar, with friendly labels. */
const CATALOG = {
  media: { label: 'Camera & microphone', icon: 'camera' },
  camera: { label: 'Camera', icon: 'camera' },
  microphone: { label: 'Microphone', icon: 'mic' },
  geolocation: { label: 'Location', icon: 'pin' },
  notifications: { label: 'Notifications', icon: 'bell' },
  clipboard: { label: 'Clipboard', icon: 'clipboard' },
  'clipboard-read': { label: 'Clipboard', icon: 'clipboard' },
  'clipboard-sanitized-write': { label: 'Clipboard', icon: 'clipboard' },
  midi: { label: 'MIDI devices', icon: 'midi' },
  midiSysex: { label: 'MIDI devices', icon: 'midi' },
  'display-capture': { label: 'Screen sharing', icon: 'screen' },
  usb: { label: 'USB devices', icon: 'usb' },
  serial: { label: 'Serial ports', icon: 'serial' },
  hid: { label: 'Game controllers & HID', icon: 'hid' },
  bluetooth: { label: 'Bluetooth', icon: 'bluetooth' },
  'idle-detection': { label: 'Idle detection', icon: 'idle' },
  'persistent-storage': { label: 'Persistent storage', icon: 'disk' },
  fullscreen: { label: 'Full screen', icon: 'expand' },
  pointerLock: { label: 'Pointer lock', icon: 'pointer' },
};

/**
 * Granted without asking. These cannot exfiltrate anything and prompting for
 * them trains users to click "allow" reflexively, which is worse for safety
 * than granting them.
 */
const AUTO_GRANT = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);

/** Denied outright: high-risk and rarely legitimate from a web page. */
const HIGH_RISK = new Set(['usb', 'serial', 'hid', 'bluetooth']);

class PermissionService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    /** requestId -> { resolve, meta } */
    this._pending = new Map();
    /** Ephemeral grants that last only for this browsing session. */
    this._sessionGrants = new Map(); // `${origin}|${permission}` -> boolean
  }

  /** @param {Electron.Session} sess */
  attach(sess, profile) {
    sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
      this._handleRequest(webContents, permission, callback, details, profile);
    });

    // Synchronous: answer from policy only, never prompt.
    sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const origin = requestingOrigin || details?.requestingUrl || webContents?.getURL() || '';
      const decision = this.resolve(origin, permission, profile);
      return decision === 'allow';
    });

    // Device pickers (USB/serial/HID). Refusing here means the page's
    // `requestDevice()` rejects, which is the correct, quiet outcome.
    sess.setDevicePermissionHandler(({ deviceType, origin }) => {
      const decision = this.resolve(origin, deviceType, profile);
      return decision === 'allow';
    });
  }

  _handleRequest(webContents, permission, callback, details, profile) {
    const origin = this._originOf(details, webContents);

    if (AUTO_GRANT.has(permission)) return callback(true);

    // Private windows never persist a grant, and default to deny for
    // anything that identifies the user or their surroundings.
    const isIncognito = profile?.kind === 'incognito';

    const decision = this.resolve(origin, permission, profile);
    if (decision === 'allow') return callback(true);
    if (decision === 'deny') return callback(false);

    // 'ask' — surface a prompt in the address bar.
    if (HIGH_RISK.has(permission) && isIncognito) return callback(false);

    const id = uid('perm_');
    const payload = {
      id,
      origin,
      permission,
      label: (CATALOG[permission] || {}).label || permission,
      icon: (CATALOG[permission] || {}).icon || 'shield',
      incognito: isIncognito,
      // Screen sharing and camera get an extra warning in the UI.
      highRisk: HIGH_RISK.has(permission) || permission === 'display-capture',
      mediaTypes: details?.mediaTypes || null,
    };

    // If nothing answers within two minutes, deny — an abandoned prompt must
    // not leave a page's promise hanging forever.
    const timer = setTimeout(() => this.respond(id, 'deny', { remember: false }), 120_000);
    if (timer.unref) timer.unref();

    this._pending.set(id, { callback, payload, timer, profile });
    this.emit('prompt', { webContents, payload });
    log.info(`prompting for ${permission} on ${origin}`);
  }

  _originOf(details, webContents) {
    const raw = details?.requestingUrl || webContents?.getURL() || '';
    try {
      return new URL(raw).origin;
    } catch {
      return raw;
    }
  }

  /**
   * Answer a pending prompt.
   * @param {string} id
   * @param {'allow'|'deny'} decision
   * @param {{remember?:boolean}} opts
   */
  respond(id, decision, { remember = true } = {}) {
    const entry = this._pending.get(id);
    if (!entry) return false;
    this._pending.delete(id);
    clearTimeout(entry.timer);

    const allow = decision === 'allow';
    const { origin, permission } = entry.payload;

    if (remember && entry.profile?.kind !== 'incognito') {
      this.set(origin, permission, allow ? 'allow' : 'deny');
    } else {
      this._sessionGrants.set(`${origin}|${permission}`, allow);
    }

    entry.callback(allow);
    this.emit('changed', { origin, permission, decision });
    log.info(`${decision} ${permission} for ${origin}${remember ? ' (remembered)' : ''}`);
    return true;
  }

  /** Prompts still awaiting an answer, for the UI to re-render after reload. */
  pending() {
    return [...this._pending.values()].map((e) => e.payload);
  }

  // ---- policy ----------------------------------------------------------

  /**
   * Current effective policy for an origin.
   * @returns {'allow'|'deny'|'ask'}
   */
  resolve(origin, permission, profile) {
    if (!origin) return 'deny';

    // Internal pages are ours and need no gate.
    if (origin.startsWith('shaurya://')) return 'allow';

    const sessionGrant = this._sessionGrants.get(`${origin}|${permission}`);
    if (typeof sessionGrant === 'boolean') return sessionGrant ? 'allow' : 'deny';

    const host = this._hostOf(origin);
    const perSite = this.settings.get(`privacy.siteSettings.${host}.permissions.${permission}`);
    if (perSite) return perSite;

    // Insecure origins never get powerful features, regardless of policy.
    if (origin.startsWith('http://') && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      if (permission !== 'notifications') return 'deny';
    }

    if (HIGH_RISK.has(permission)) {
      return this.settings.get(`privacy.defaultPermissions.${permission}`) || 'deny';
    }

    return this.settings.get(`privacy.defaultPermissions.${permission}`) || 'ask';
  }

  _hostOf(origin) {
    try {
      return baseDomain(new URL(origin).hostname);
    } catch {
      return origin;
    }
  }

  /** Set a durable per-site policy. */
  set(origin, permission, value) {
    const host = this._hostOf(origin);
    const sites = this.settings.get('privacy.siteSettings') || {};
    const site = sites[host] || {};
    site.permissions = { ...(site.permissions || {}), [permission]: value };
    if (value === 'ask') delete site.permissions[permission];
    sites[host] = site;
    this.settings.set('privacy.siteSettings', sites);
    this._sessionGrants.delete(`${origin}|${permission}`);
    this.emit('changed', { origin, permission, decision: value });
    return value;
  }

  /** Everything the address-bar popover shows for the current site. */
  forSite(url) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return { origin: null, permissions: [] };
    }
    const interesting = ['camera', 'microphone', 'geolocation', 'notifications',
      'clipboard-read', 'display-capture', 'midi', 'usb', 'serial', 'hid'];
    return {
      origin,
      host: this._hostOf(origin),
      permissions: interesting.map((p) => ({
        id: p,
        label: CATALOG[p]?.label || p,
        icon: CATALOG[p]?.icon || 'shield',
        state: this.resolve(origin, p),
        isDefault: !this.settings.get(`privacy.siteSettings.${this._hostOf(origin)}.permissions.${p}`),
      })),
    };
  }

  /** Forget every decision for a site. */
  clearSite(origin) {
    const host = this._hostOf(origin);
    const sites = this.settings.get('privacy.siteSettings') || {};
    if (sites[host]) {
      delete sites[host].permissions;
      this.settings.set('privacy.siteSettings', sites);
    }
    for (const key of [...this._sessionGrants.keys()]) {
      if (key.startsWith(`${origin}|`)) this._sessionGrants.delete(key);
    }
    this.emit('changed', { origin, permission: '*', decision: 'ask' });
    return true;
  }
}

module.exports = { PermissionService, CATALOG, HIGH_RISK, AUTO_GRANT };
