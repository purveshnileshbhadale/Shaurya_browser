'use strict';
/**
 * Main-process half of the content preload channel.
 *
 * This is a separate, unprivileged channel from the chrome IPC router. Any
 * web page can reach it, so every operation here is page-scoped and
 * harmless: "what cosmetic rules apply to me", "here is a focused login
 * field", "the user swiped". Nothing on this channel can read the vault,
 * change settings or touch another tab.
 */
const EventEmitter = require('node:events');
const { ipcMain } = require('electron');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('content');

/** A page that never answers must not leak a pending promise forever. */
const COMMAND_TIMEOUT_MS = 8000;

class ContentBridge extends EventEmitter {
  constructor() {
    super();
    /** requestId -> {resolve, reject, timer} */
    this._pending = new Map();
    /** Handlers for page->main requests, registered by other services. */
    this._handlers = new Map();
    this._installed = false;
  }

  /**
   * Register a page->main operation.
   * @param {string} op
   * @param {(payload:any, ctx:{sender:Electron.WebContents}) => any} fn
   */
  handle(op, fn) {
    this._handlers.set(op, fn);
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    ipcMain.handle('aether:content', async (event, op, payload) => {
      const fn = this._handlers.get(op);
      if (!fn) return null;
      try {
        return await fn(payload, { sender: event.sender });
      } catch (err) {
        log.warn(`content op ${op} failed: ${err.message}`);
        return null;
      }
    });

    ipcMain.on('aether:content-event', (event, op, payload) => {
      this.emit(op, payload, { sender: event.sender });
    });

    ipcMain.on('aether:content-reply', (_event, id, result, error) => {
      const entry = this._pending.get(id);
      if (!entry) return; // already timed out
      this._pending.delete(id);
      clearTimeout(entry.timer);
      if (error) entry.reject(new Error(error));
      else entry.resolve(result);
    });
  }

  /**
   * Run an operation inside a page and await its result.
   *
   * @param {Electron.WebContents} webContents
   * @param {string} op
   * @param {any} [payload]
   * @returns {Promise<any>}
   */
  command(webContents, op, payload = {}) {
    if (!webContents || webContents.isDestroyed()) {
      return Promise.reject(new Error('page is not available'));
    }
    const id = uid('c_');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`content op "${op}" timed out`));
      }, COMMAND_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      this._pending.set(id, { resolve, reject, timer });
      webContents.send('aether:content-command', id, op, payload);
    });
  }
}

module.exports = { ContentBridge };
