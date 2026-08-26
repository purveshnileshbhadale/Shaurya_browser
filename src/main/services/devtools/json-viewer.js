'use strict';
/**
 * Auto-activating JSON viewer (spec §5).
 *
 * When a navigation returns raw JSON, Chromium renders it as a wall of
 * unwrapped text. This intercepts the response headers, and for a top-level
 * document whose type is JSON, redirects the tab to `aether://json`, which
 * renders a collapsible tree with search and a copy-path affordance.
 *
 * The original response is not consumed twice: the viewer page re-fetches
 * the URL itself, so the request is served from Chromium's cache.
 */
const EventEmitter = require('node:events');
const { hubFor, PRIORITY } = require('../web-request-hub');
const { createLogger } = require('../../util/logger');

const log = createLogger('json-viewer');

const JSON_TYPES = /^application\/(json|.*\+json|ld\+json)|^text\/json/i;

class JsonViewerService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    /** URLs the user chose to see raw, so the toggle sticks for one visit. */
    this._rawOnce = new Set();
  }

  attach(sess, profile) {
    hubFor(sess).register('onHeadersReceived', 'json-viewer', PRIORITY.JSON_VIEWER, (details) => {
      if (!this._enabled()) return null;
      // Only top-level navigations: an XHR returning JSON must be left alone.
      if (details.resourceType !== 'mainFrame') return null;
      if (details.method !== 'GET') return null;
      if (this._rawOnce.has(details.url)) {
        this._rawOnce.delete(details.url);
        return null;
      }

      const contentType = headerValue(details.responseHeaders, 'content-type');
      if (!contentType || !JSON_TYPES.test(contentType)) return null;

      // A download must stay a download.
      const disposition = headerValue(details.responseHeaders, 'content-disposition');
      if (disposition && /attachment/i.test(disposition)) return null;

      this.emit('detected', { url: details.url, contentType });
      return null; // headers untouched; the tab layer performs the redirect
    });
  }

  _enabled() {
    return this.features.enabled('jsonViewer') && this.settings.get('devtools.jsonViewer');
  }

  /**
   * Should this committed navigation be shown in the viewer?
   * Called by the tab layer, which owns navigation.
   */
  shouldIntercept({ url, contentType, resourceType = 'mainFrame' }) {
    if (!this._enabled()) return false;
    if (resourceType !== 'mainFrame') return false;
    if (!contentType || !JSON_TYPES.test(contentType)) return false;
    if (url.startsWith('aether://')) return false;
    return true;
  }

  /** The viewer URL for a target document. */
  viewerUrl(url) {
    return `aether://json/?src=${encodeURIComponent(url)}`;
  }

  /** "Show raw" — the next load of this URL bypasses the viewer. */
  showRaw(url) {
    this._rawOnce.add(url);
    return url;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

module.exports = { JsonViewerService, JSON_TYPES };
