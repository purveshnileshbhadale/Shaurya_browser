'use strict';
/**
 * IPC router.
 *
 * Services register handlers by channel name; the router enforces three
 * invariants that matter for a browser:
 *
 *  1. Only channels declared in channels.js can ever be handled or invoked.
 *  2. Only *trusted* renderers (the browser chrome and `shaurya://` internal
 *     pages) may invoke. A hostile web page that finds a way to call
 *     ipcRenderer must not be able to read the password vault.
 *  3. Handler errors are converted into a serialisable `{ __error }` shape
 *     instead of leaking main-process stack traces into the renderer.
 */
const { ipcMain } = require('electron');
const { INVOKE, SEND } = require('./channels');
const { createLogger } = require('../util/logger');

const log = createLogger('ipc');

class IpcRouter {
  constructor() {
    /** @type {Map<string, Function>} */
    this.handlers = new Map();
    /** WebContents ids allowed to invoke privileged channels. */
    this.trusted = new Set();
    this._installed = false;
  }

  /** Mark a WebContents as browser chrome / internal page. */
  trust(webContents) {
    this.trusted.add(webContents.id);
    webContents.once('destroyed', () => this.trusted.delete(webContents.id));
  }

  /**
   * Grant or revoke trust as a tab navigates.
   *
   * Trust follows the *committed document*, not the WebContents. A tab that
   * goes from `shaurya://settings` to `evil.example` keeps the same
   * WebContents id, so trust granted once and never revoked would hand a web
   * page the vault. This is called on every main-frame commit.
   */
  setTrusted(webContents, trusted) {
    if (!webContents || webContents.isDestroyed()) return;
    if (trusted) this.trust(webContents);
    else this.trusted.delete(webContents.id);
  }

  isTrusted(webContents) {
    return webContents ? this.trusted.has(webContents.id) : false;
  }

  /**
   * Register one handler.
   * @param {string} channel  must exist in INVOKE or SEND
   * @param {(payload:any, ctx:{sender:Electron.WebContents}) => any} fn
   */
  handle(channel, fn) {
    if (!INVOKE.includes(channel) && !SEND.includes(channel)) {
      throw new Error(`ipc: channel "${channel}" is not declared in channels.js`);
    }
    if (this.handlers.has(channel)) {
      throw new Error(`ipc: duplicate handler for "${channel}"`);
    }
    this.handlers.set(channel, fn);
  }

  /** Register a whole namespace at once: handleAll('tabs', { list, create }). */
  handleAll(namespace, map) {
    for (const [name, fn] of Object.entries(map)) {
      this.handle(`${namespace}.${name}`, fn);
    }
  }

  /** Wire the two multiplexed Electron channels. Call once at startup. */
  install() {
    if (this._installed) return;
    this._installed = true;

    ipcMain.handle('shaurya:invoke', async (event, channel, payload) => {
      if (!INVOKE.includes(channel)) {
        log.warn(`rejected undeclared channel "${channel}"`);
        return { __error: 'unknown-channel' };
      }
      if (!this.isTrusted(event.sender)) {
        log.warn(`rejected "${channel}" from untrusted renderer ${event.sender.id}`);
        return { __error: 'untrusted-renderer' };
      }
      const fn = this.handlers.get(channel);
      if (!fn) return { __error: `no-handler:${channel}` };
      try {
        return await fn(payload, { sender: event.sender });
      } catch (err) {
        log.error(`${channel} failed: ${err.stack || err.message}`);
        return { __error: err.message || String(err) };
      }
    });

    ipcMain.on('shaurya:send', (event, channel, payload) => {
      if (!SEND.includes(channel) || !this.isTrusted(event.sender)) return;
      const fn = this.handlers.get(channel);
      if (fn) {
        Promise.resolve(fn(payload, { sender: event.sender })).catch((err) =>
          log.error(`${channel} failed: ${err.message}`)
        );
      }
    });

    log.info(`router installed with ${this.handlers.size} handlers`);
  }

  /** Report channels declared but never implemented — a build-time smell. */
  missing() {
    return INVOKE.filter((c) => !this.handlers.has(c));
  }
}

module.exports = { IpcRouter };
