'use strict';
/**
 * Crash-safe JSON file store with debounced writes.
 *
 * Writes go to a temp file and are renamed into place, so a power loss can
 * never leave a half-written settings/history file behind — a real failure
 * mode for browsers that hold thousands of history rows in one document.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('./logger');

const log = createLogger('store');

class JsonStore {
  /**
   * @param {string} file      absolute path to the backing document
   * @param {object} fallback  value used when the file is absent or corrupt
   * @param {number} debounceMs coalescing window for writes
   */
  constructor(file, fallback = {}, debounceMs = 250) {
    this.file = file;
    this.fallback = fallback;
    this.debounceMs = debounceMs;
    this._timer = null;
    this._data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      // Structural sanity: never hand back a primitive where callers expect
      // an object/array, which would break every downstream `.foo` access.
      if (parsed && typeof parsed === 'object') return parsed;
      log.warn(`${path.basename(this.file)} had unexpected shape; using defaults`);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`could not read ${this.file}: ${err.message}`);
    }
    return structuredClone(this.fallback);
  }

  get data() {
    return this._data;
  }

  set data(next) {
    this._data = next;
    this.save();
  }

  /** Mutate in place then persist. */
  update(fn) {
    const result = fn(this._data);
    this.save();
    return result;
  }

  /** Debounced persist. Call flush() when you need durability now. */
  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.debounceMs);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error(`failed writing ${this.file}: ${err.message}`);
    }
  }
}

module.exports = { JsonStore };
