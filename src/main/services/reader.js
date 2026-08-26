'use strict';
/**
 * Reader mode.
 *
 * Extraction happens in the page (content preload) because it needs the
 * rendered DOM; this service caches results per tab, decides whether reader
 * mode is even offered, and hands the article to `aether://reader`.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../util/logger');

const log = createLogger('reader');

class ReaderService extends EventEmitter {
  /**
   * @param {import('./content-bridge').ContentBridge} content
   * @param {import('./feature-store').FeatureStore} features
   */
  constructor(content, features) {
    super();
    this.content = content;
    this.features = features;
    /** tabId -> extracted article */
    this._articles = new Map();
    /** tabId -> the URL the article was extracted from */
    this._origins = new Map();
  }

  /**
   * Try to extract; caches the result so toggling is instant.
   * @returns {Promise<object|null>}
   */
  async extract(tab) {
    if (!this.features.enabled('reader')) return null;
    if (!tab?.webContents) return null;

    const cached = this._articles.get(tab.id);
    if (cached && this._origins.get(tab.id) === tab.url) return cached;

    try {
      const article = await this.content.command(tab.webContents, 'reader.extract');
      if (article) {
        this._articles.set(tab.id, article);
        this._origins.set(tab.id, tab.url);
      }
      return article;
    } catch (err) {
      log.debug(`extraction failed for ${tab.url}: ${err.message}`);
      return null;
    }
  }

  /** Is reader mode worth offering for this tab? */
  async available(tab) {
    if (!this.features.enabled('reader')) return false;
    if (!tab || !/^https?:/.test(tab.url || '')) return false;
    const article = await this.extract(tab);
    return Boolean(article);
  }

  /**
   * Switch a tab into or out of reader mode.
   * @returns {Promise<{readerMode:boolean}>}
   */
  async toggle(tab) {
    if (!tab) throw new Error('no tab');

    if (tab.readerMode) {
      // Leaving reader mode returns to the article's real URL.
      const original = this._origins.get(tab.id);
      tab.readerMode = false;
      if (original) await tab.navigate(original);
      this.emit('state', { tabId: tab.id, readerMode: false });
      return { readerMode: false };
    }

    const article = await this.extract(tab);
    if (!article) throw new Error('this page does not look like an article');

    this._origins.set(tab.id, tab.url);
    tab.readerMode = true;
    await tab.navigate(`aether://reader/?tab=${encodeURIComponent(tab.id)}`);
    // `navigate` resets readerMode on commit, so re-assert it after.
    tab.readerMode = true;
    this.emit('state', { tabId: tab.id, readerMode: true });
    return { readerMode: true };
  }

  /** Used by the `aether://api/reader` endpoint. */
  get(tabId) {
    return this._articles.get(tabId) || null;
  }

  state(tab) {
    return {
      tabId: tab?.id ?? null,
      readerMode: Boolean(tab?.readerMode),
      hasArticle: this._articles.has(tab?.id),
      originalUrl: this._origins.get(tab?.id) || null,
    };
  }

  forget(tabId) {
    this._articles.delete(tabId);
    this._origins.delete(tabId);
  }
}

module.exports = { ReaderService };
