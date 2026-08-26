'use strict';
/**
 * Download manager.
 *
 * Tracks items per session so an incognito window's downloads are listed in
 * that window and forgotten when it closes.
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const { app, shell, dialog } = require('electron');
const { uid } = require('../util/id');
const { createLogger } = require('../util/logger');

const log = createLogger('downloads');

/** Extensions that execute on double-click and deserve a warning. */
const RISKY = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js',
  '.jar', '.app', '.dmg', '.pkg', '.deb', '.rpm', '.sh', '.run', '.apk',
]);

class DownloadService extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    /** @type {Map<string, object>} */
    this.items = new Map();
  }

  attach(sess, profile) {
    sess.on('will-download', (event, item, webContents) => {
      const id = uid('dl_');
      const ext = path.extname(item.getFilename()).toLowerCase();

      const dir = this.settings.get('downloads.directory') || app.getPath('downloads');
      if (!this.settings.get('downloads.askEveryTime')) {
        item.setSavePath(path.join(dir, this._uniqueName(dir, item.getFilename())));
      }

      const record = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        mime: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        startedAt: Date.now(),
        savePath: null,
        profileId: profile?.id ?? null,
        incognito: profile?.kind === 'incognito',
        risky: RISKY.has(ext),
        paused: false,
      };
      this.items.set(id, record);
      this.emit('changed', this.list());

      item.on('updated', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        record.paused = item.isPaused();
        record.savePath = item.getSavePath();
        // Rate-limit progress events: a fast download would otherwise fire
        // hundreds of IPC messages a second.
        this._throttledEmit();
      });

      item.once('done', (_e, state) => {
        record.state = state; // completed | cancelled | interrupted
        record.savePath = item.getSavePath();
        record.finishedAt = Date.now();
        record.receivedBytes = item.getReceivedBytes();
        this.emit('changed', this.list());
        log.info(`${state}: ${record.filename}`);
      });

      // Keep a handle so cancel/pause can reach the real item.
      record._item = item;
    });
  }

  _throttledEmit() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('changed', this.list());
    }, 250);
    if (this._timer.unref) this._timer.unref();
  }

  /** Avoid clobbering an existing file: `report.pdf` -> `report (2).pdf`. */
  _uniqueName(dir, filename) {
    const fs = require('node:fs');
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let candidate = filename;
    let n = 2;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = `${base} (${n++})${ext}`;
    }
    return candidate;
  }

  list({ includeIncognito = true } = {}) {
    return [...this.items.values()]
      .filter((r) => includeIncognito || !r.incognito)
      .map(({ _item, ...rest }) => rest)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  cancel(id) {
    const record = this.items.get(id);
    if (!record?._item) return false;
    record._item.cancel();
    return true;
  }

  togglePause(id) {
    const record = this.items.get(id);
    if (!record?._item) return false;
    if (record._item.isPaused()) record._item.resume();
    else record._item.pause();
    return true;
  }

  reveal(id) {
    const record = this.items.get(id);
    if (!record?.savePath) return false;
    shell.showItemInFolder(record.savePath);
    return true;
  }

  clear({ completedOnly = true } = {}) {
    for (const [id, record] of this.items) {
      if (!completedOnly || record.state !== 'progressing') this.items.delete(id);
    }
    this.emit('changed', this.list());
    return this.list();
  }

  /** Forget an incognito context's downloads when its window closes. */
  forgetProfile(profileId) {
    for (const [id, record] of this.items) {
      if (record.profileId === profileId) this.items.delete(id);
    }
    this.emit('changed', this.list());
  }
}

module.exports = { DownloadService, RISKY };
