'use strict';
/**
 * Content preload — injected into every page, in a sandboxed isolated world.
 *
 * Because it is sandboxed it has no `fs`, no arbitrary `require`, and no
 * access to the main process beyond two dedicated channels. It provides the
 * page-side half of features that genuinely need to run inside the document:
 * cosmetic filtering, reader extraction, gestures, autofill, and page
 * context for the AI panel.
 *
 * Two rules hold throughout:
 *   1. Nothing here trusts the page. Page script shares the DOM with us but
 *      not this JavaScript world, and we never eval page-supplied strings.
 *   2. The privileged `window.aether` bridge is exposed *only* on
 *      `aether://` documents. The main process independently re-checks that
 *      (ipc/router.js), so a page that somehow reaches the channel still
 *      gets refused.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const IS_INTERNAL = location.protocol === 'aether:';
const IS_TOP = window.top === window;

/** Ask the main process for something page-scoped. */
function call(op, payload) {
  return ipcRenderer.invoke('aether:content', op, payload);
}

/** Tell the main process something happened, without waiting. */
function notify(op, payload) {
  ipcRenderer.send('aether:content-event', op, payload);
}

// ===========================================================================
// Cosmetic filtering
// ===========================================================================

/**
 * The network layer already cancelled the ad requests. This removes the
 * empty shells left behind — sticky bars, reserved ad slots, "please
 * disable your blocker" interstitials.
 *
 * Generic rules arrive indexed by their leading class/id token, and we only
 * materialise the ones whose token actually exists in this document. A page
 * typically activates a few dozen of the ~13k generic selectors, so the
 * style engine never sees a selector list bigger than the page's own CSS.
 */
const cosmetic = {
  styleEl: null,
  applied: new Set(),
  index: null,
  genericOther: [],

  async init() {
    if (!IS_TOP || IS_INTERNAL) return;
    let payload;
    try {
      payload = await call('cosmetic', { url: location.href });
    } catch {
      return; // blocking disabled, or the service is not up yet
    }
    if (!payload || (!payload.specific?.length && !payload.genericOther?.length
      && !Object.keys(payload.genericByToken || {}).length)) return;

    this.index = payload.genericByToken || {};
    this.genericOther = payload.genericOther || [];

    // Site-specific rules are few and written for this page: apply at once.
    this.add(payload.specific || []);
    this.add(this.genericOther);
    this.scan();

    // Pages inject ad slots long after load, so keep watching — but cheaply,
    // and only for added element nodes.
    const observer = new MutationObserver((records) => {
      let interesting = false;
      for (const r of records) {
        if (r.addedNodes.length) { interesting = true; break; }
        if (r.type === 'attributes') { interesting = true; break; }
      }
      if (interesting) this.scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'id'],
    });
  },

  scheduleScan() {
    if (this._pending) return;
    this._pending = true;
    // Coalesce bursts of mutations into one pass per frame.
    requestAnimationFrame(() => {
      this._pending = false;
      this.scan();
    });
  },

  /** Activate generic selectors whose class/id token is present in the DOM. */
  scan() {
    if (!this.index) return;
    const found = [];
    // Walking the class/id tokens present in the document is far cheaper
    // than asking the style engine about 13k selectors.
    const seen = new Set();
    for (const el of document.querySelectorAll('[class],[id]')) {
      if (el.id) seen.add('#' + el.id);
      const cls = el.classList;
      for (let i = 0; i < cls.length; i++) seen.add('.' + cls[i]);
    }
    for (const token of seen) {
      const selectors = this.index[token];
      if (!selectors) continue;
      for (const sel of selectors) {
        if (!this.applied.has(sel)) found.push(sel);
      }
    }
    if (found.length) this.add(found);
  },

  add(selectors) {
    const fresh = selectors.filter((s) => s && !this.applied.has(s));
    if (!fresh.length) return;
    for (const s of fresh) this.applied.add(s);

    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.setAttribute('data-aether', 'cosmetic');
      (document.head || document.documentElement).appendChild(this.styleEl);
    }
    // `display:none !important` is what every blocker uses; anything softer
    // is trivially overridden by the site's own stylesheet.
    this.styleEl.textContent += fresh.map((s) => `${s}{display:none !important}`).join('\n');
  },
};

// ===========================================================================
// Reader mode extraction
// ===========================================================================

/**
 * A compact Readability-style extractor.
 *
 * Scores block elements by text density and paragraph count, penalising the
 * usual furniture (nav, footer, comments, share widgets), then returns the
 * highest-scoring subtree. It is intentionally simple and predictable rather
 * than exhaustive: it either finds a clear article or reports that it did
 * not, and the UI only offers reader mode in the former case.
 */
const reader = {
  NEGATIVE: /(^|[\s_-])(comment|disqus|share|footer|foot|header|nav|menu|sidebar|widget|promo|banner|advert|ad|related|recommend|newsletter|subscribe|popup|modal|cookie|social|breadcrumb|pagination|tag|meta)([\s_-]|$)/i,
  POSITIVE: /(^|[\s_-])(article|body|content|entry|main|page|post|story|text|blog|column)([\s_-]|$)/i,

  /** @returns {{title,byline,excerpt,html,text,readingMinutes,wordCount}|null} */
  extract() {
    const candidates = new Map();

    for (const p of document.querySelectorAll('p, pre, blockquote, article, section, div')) {
      const text = (p.innerText || '').trim();
      if (text.length < 25) continue;
      const parent = p.parentElement;
      if (!parent) continue;

      let score = 1;
      score += Math.min(Math.floor(text.length / 100), 3);
      score += (text.match(/[,、,]/g) || []).length * 0.5;
      score += this._classScore(p);

      // Credit the parent, which is usually the real article container.
      candidates.set(parent, (candidates.get(parent) || this._classScore(parent)) + score);
      if (parent.parentElement) {
        candidates.set(parent.parentElement,
          (candidates.get(parent.parentElement) || 0) + score / 2);
      }
    }

    let best = null;
    let bestScore = 0;
    for (const [el, raw] of candidates) {
      // Link-heavy blocks are navigation, not prose.
      const linkDensity = this._linkDensity(el);
      const score = raw * (1 - linkDensity);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (!best || bestScore < 12) return null;

    const clone = best.cloneNode(true);
    this._clean(clone);
    const text = (clone.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 300) return null;

    const words = text.split(/\s+/).filter(Boolean).length;
    return {
      title: this._title(),
      byline: this._byline(),
      siteName: this._meta('og:site_name') || location.hostname,
      publishedAt: this._meta('article:published_time') || null,
      excerpt: this._meta('description') || text.slice(0, 220),
      html: clone.innerHTML,
      text,
      wordCount: words,
      readingMinutes: Math.max(1, Math.round(words / 220)),
      url: location.href,
    };
  },

  _classScore(el) {
    const id = `${el.className || ''} ${el.id || ''}`;
    if (typeof id !== 'string') return 0;
    let s = 0;
    if (this.NEGATIVE.test(id)) s -= 25;
    if (this.POSITIVE.test(id)) s += 25;
    if (el.tagName === 'ARTICLE' || el.getAttribute('role') === 'main') s += 30;
    if (el.tagName === 'NAV' || el.tagName === 'ASIDE' || el.tagName === 'FOOTER') s -= 40;
    return s;
  },

  _linkDensity(el) {
    const total = (el.innerText || '').length || 1;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += (a.innerText || '').length;
    return Math.min(1, linked / total);
  },

  _clean(root) {
    const strip = 'script,style,noscript,iframe,form,button,input,svg,canvas,'
      + 'nav,aside,footer,header,[role=navigation],[aria-hidden=true],[data-aether]';
    for (const el of root.querySelectorAll(strip)) el.remove();
    // Drop presentational attributes so the reader stylesheet fully controls
    // typography rather than fighting inline styles.
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (!/^(href|src|alt|title|colspan|rowspan|datetime)$/.test(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
      // Resolve relative URLs; the reader renders on a different origin.
      if (el.tagName === 'A' && el.getAttribute('href')) {
        try { el.setAttribute('href', new URL(el.getAttribute('href'), location.href).href); } catch {}
      }
      if (el.tagName === 'IMG' && el.getAttribute('src')) {
        try { el.setAttribute('src', new URL(el.getAttribute('src'), location.href).href); } catch {}
      }
    }
  },

  _meta(name) {
    const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  },

  _title() {
    return this._meta('og:title')
      || document.querySelector('h1')?.innerText?.trim()
      || document.title;
  },

  _byline() {
    return this._meta('article:author')
      || document.querySelector('[rel=author], .byline, .author')?.innerText?.trim()
      || null;
  },
};

// ===========================================================================
// Page context for the AI layer
// ===========================================================================

/**
 * What the assistant is allowed to see. Deliberately *not* the raw DOM:
 * we hand over visible text, headings, links and form structure, capped in
 * size. Password fields and anything `type=hidden` are never included.
 */
const pageContext = {
  collect({ maxChars = 40000 } = {}) {
    const article = reader.extract();
    const bodyText = article
      ? article.text
      : (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();

    return {
      url: location.href,
      title: document.title,
      siteName: reader._meta('og:site_name') || location.hostname,
      description: reader._meta('description') || '',
      lang: document.documentElement.lang || null,
      isArticle: Boolean(article),
      readingMinutes: article?.readingMinutes ?? null,
      headings: [...document.querySelectorAll('h1,h2,h3')]
        .slice(0, 80)
        .map((h) => ({ level: Number(h.tagName[1]), text: h.innerText.trim().slice(0, 200) }))
        .filter((h) => h.text),
      text: bodyText.slice(0, maxChars),
      truncated: bodyText.length > maxChars,
      wordCount: bodyText.split(/\s+/).filter(Boolean).length,
      selection: (window.getSelection?.().toString() || '').slice(0, 4000),
      // Media the note generator can transcribe.
      media: [...document.querySelectorAll('video,audio')].slice(0, 5).map((m) => ({
        kind: m.tagName.toLowerCase(),
        src: m.currentSrc || m.src || null,
        duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null,
      })),
      // Any transcript track the page already exposes.
      tracks: [...document.querySelectorAll('track[kind=captions],track[kind=subtitles]')]
        .slice(0, 5).map((t) => ({ label: t.label, src: t.src, lang: t.srclang })),
    };
  },

  /** Forms the assistant may draft into (spec §4: "draft replies in web forms"). */
  forms() {
    return [...document.forms].slice(0, 20).map((form, i) => ({
      index: i,
      name: form.name || form.id || null,
      action: form.action || null,
      fields: [...form.elements]
        // Never surface secrets to the model.
        .filter((el) => el.type !== 'password' && el.type !== 'hidden')
        .slice(0, 40)
        .map((el) => ({
          name: el.name || el.id || null,
          type: el.type || el.tagName.toLowerCase(),
          label: labelFor(el),
          placeholder: el.placeholder || null,
          value: el.type === 'textarea' || el.type === 'text' ? (el.value || '').slice(0, 500) : null,
          maxLength: el.maxLength > 0 ? el.maxLength : null,
        })),
    }));
  },
};

function labelFor(el) {
  if (el.labels?.length) return el.labels[0].innerText.trim().slice(0, 120);
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').slice(0, 120);
  const wrapper = el.closest('label');
  return wrapper ? wrapper.innerText.trim().slice(0, 120) : null;
}

// ===========================================================================
// Gestures (spec §2)
// ===========================================================================

/**
 * Trackpad swipe for back/forward and pinch for zoom.
 *
 * Chromium delivers trackpad pinch as a wheel event with `ctrlKey`, and
 * horizontal two-finger scroll as `deltaX`. We only treat a horizontal
 * gesture as navigation when the page itself cannot scroll that way —
 * otherwise swiping inside a carousel would yank the user off the page.
 */
const gestures = {
  swipeAccum: 0,
  swipeTimer: null,

  init() {
    if (!IS_TOP || IS_INTERNAL) return;

    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        // Pinch zoom.
        const current = webFrame.getZoomLevel();
        webFrame.setZoomLevel(Math.max(-5, Math.min(5, current - Math.sign(e.deltaY) * 0.25)));
        notify('zoom', { level: webFrame.getZoomLevel() });
        e.preventDefault();
        return;
      }

      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (this._canScrollHorizontally(e.target, e.deltaX)) return;

      this.swipeAccum += e.deltaX;
      clearTimeout(this.swipeTimer);
      this.swipeTimer = setTimeout(() => { this.swipeAccum = 0; }, 220);

      // ~120px of committed horizontal travel is the threshold macOS uses.
      if (Math.abs(this.swipeAccum) > 120) {
        notify('gesture', { direction: this.swipeAccum < 0 ? 'back' : 'forward' });
        this.swipeAccum = 0;
      }
    }, { passive: false, capture: true });
  },

  _canScrollHorizontally(target, delta) {
    let el = target;
    while (el && el !== document.documentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const atStart = el.scrollLeft <= 0;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        if (!(delta < 0 && atStart) && !(delta > 0 && atEnd)) return true;
      }
      el = el.parentElement;
    }
    const doc = document.scrollingElement;
    return Boolean(doc && doc.scrollWidth > doc.clientWidth + 1);
  },
};

// ===========================================================================
// Password autofill (spec §3)
// ===========================================================================

/**
 * Detects sign-in forms and fills them on request. Credentials only ever
 * travel in the direction main -> page, once the user has picked an entry;
 * the page is never handed the vault, and we never autosubmit.
 */
const autofill = {
  init() {
    if (IS_INTERNAL) return;
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el || !el.form) return;
      if (el.type === 'password' || this._looksLikeUsername(el)) {
        notify('autofill-focus', {
          origin: location.origin,
          fieldType: el.type === 'password' ? 'password' : 'username',
          rect: el.getBoundingClientRect().toJSON(),
        });
      }
    }, true);

    // Offer to save after a submit that carried a password.
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const pw = form.querySelector('input[type=password]');
      if (!pw || !pw.value) return;
      const user = this._findUsername(form);
      notify('autofill-submit', {
        origin: location.origin,
        username: user ? user.value : '',
        // The password is sent so the vault can offer to store it; it goes
        // straight into the encrypted vault and is never logged.
        password: pw.value,
        title: document.title,
      });
    }, true);
  },

  fill({ username, password }) {
    const pw = document.querySelector('input[type=password]');
    const form = pw?.form || document.forms[0];
    if (!form) return false;
    const user = this._findUsername(form);
    if (user && username != null) this._setValue(user, username);
    if (pw && password != null) this._setValue(pw, password);
    return true;
  },

  /**
   * Set a value the way a user would, so frameworks notice.
   * React and friends install a value setter on the element; assigning
   * `.value` directly bypasses their tracker and the change is discarded.
   */
  _setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  _looksLikeUsername(el) {
    if (el.tagName !== 'INPUT') return false;
    if (!['text', 'email', 'tel', ''].includes(el.type)) return false;
    const hint = `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`.toLowerCase();
    return /user|email|login|account|phone|identifier/.test(hint);
  },

  _findUsername(form) {
    const fields = [...form.querySelectorAll('input')];
    return fields.find((f) => f.autocomplete === 'username' || f.autocomplete === 'email')
      || fields.find((f) => this._looksLikeUsername(f))
      || null;
  },
};

// ===========================================================================
// Picture-in-picture & media
// ===========================================================================

const media = {
  async requestPip() {
    const video = this._pickVideo();
    if (!video) return { ok: false, reason: 'no-video' };
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return { ok: true, active: false };
      }
      await video.requestPictureInPicture();
      return { ok: true, active: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  /** The largest playing video, falling back to the largest one present. */
  _pickVideo() {
    const videos = [...document.querySelectorAll('video')]
      .filter((v) => v.readyState > 0)
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    return videos.find((v) => !v.paused) || videos[0] || null;
  },
};

// ===========================================================================
// Full-page capture support
// ===========================================================================

/**
 * Scrolling capture needs the page to hold still and report its true height.
 * The main process drives the scroll/capture loop; this side just prepares
 * the document and reports geometry.
 */
const capture = {
  begin() {
    const doc = document.scrollingElement || document.documentElement;
    this._saved = {
      scrollTop: doc.scrollTop,
      overflow: document.documentElement.style.overflow,
      behavior: document.documentElement.style.scrollBehavior,
    };
    // Smooth scrolling would blur every seam between captured strips.
    document.documentElement.style.scrollBehavior = 'auto';
    // Sticky headers repeat in every strip; neutralise them for the capture.
    this._stuck = [];
    for (const el of document.querySelectorAll('*')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        this._stuck.push([el, el.style.position]);
        el.style.position = 'absolute';
      }
    }
    return {
      width: doc.clientWidth,
      height: doc.scrollHeight,
      viewport: doc.clientHeight,
      dpr: window.devicePixelRatio || 1,
    };
  },

  scrollTo(y) {
    const doc = document.scrollingElement || document.documentElement;
    doc.scrollTop = y;
    return doc.scrollTop;
  },

  end() {
    const doc = document.scrollingElement || document.documentElement;
    for (const [el, pos] of this._stuck || []) el.style.position = pos;
    this._stuck = [];
    if (this._saved) {
      doc.scrollTop = this._saved.scrollTop;
      document.documentElement.style.scrollBehavior = this._saved.behavior;
    }
  },
};

// ===========================================================================
// Main-process command dispatch
// ===========================================================================

ipcRenderer.on('aether:content-command', async (_event, id, op, payload) => {
  let result = null;
  let error = null;
  try {
    switch (op) {
      case 'reader.extract': result = reader.extract(); break;
      case 'context.collect': result = pageContext.collect(payload || {}); break;
      case 'context.forms': result = pageContext.forms(); break;
      case 'autofill.fill': result = autofill.fill(payload || {}); break;
      case 'media.pip': result = await media.requestPip(); break;
      case 'capture.begin': result = capture.begin(); break;
      case 'capture.scroll': result = capture.scrollTo(payload.y); break;
      case 'capture.end': result = capture.end(); break;
      case 'cosmetic.refresh': cosmetic.scan(); result = cosmetic.applied.size; break;
      case 'zoom.set': webFrame.setZoomLevel(payload.level); result = webFrame.getZoomLevel(); break;
      case 'scroll.top': window.scrollTo({ top: 0, behavior: 'smooth' }); result = true; break;
      default: error = `unknown content op: ${op}`;
    }
  } catch (err) {
    error = err.message;
  }
  ipcRenderer.send('aether:content-reply', id, result, error);
});

// ===========================================================================
// Frame timing (spec §4 — the FPS readout)
// ===========================================================================

/**
 * Measure the page's real frame rate and report it to the main process.
 *
 * This has to live here because the main process genuinely cannot observe a
 * renderer's vsync — there is no Electron or Chromium API that exposes a
 * tab's frame rate. The page counting its own `requestAnimationFrame`
 * callbacks is the only honest source, so an overlay showing FPS is showing
 * a number this loop produced.
 *
 * Deliberately cheap and deliberately quiet:
 *   - only the top frame samples, so a page with twenty iframes reports once;
 *   - `requestAnimationFrame` stops being called when the tab is hidden, so
 *     a background tab reports nothing rather than reporting zero, and the
 *     HUD shows a dash instead of implying the page has stalled;
 *   - one IPC message per second, not per frame.
 */
const frameStats = {
  frames: 0,
  windowStart: 0,
  running: false,

  init() {
    if (!IS_TOP) return;

    // Only sample while something is watching. The main process turns this on
    // when the overlay or the per-tab metrics panel needs it, so an ordinary
    // browsing session pays nothing at all.
    ipcRenderer.on('aether:frame-stats', (_event, enabled) => {
      if (enabled && !this.running) this.start();
      else if (!enabled) this.running = false;
    });
  },

  start() {
    this.running = true;
    this.frames = 0;
    this.windowStart = performance.now();

    const step = (now) => {
      if (!this.running) return;
      this.frames += 1;

      const elapsed = now - this.windowStart;
      if (elapsed >= 1000) {
        notify('frameStats', { fps: (this.frames * 1000) / elapsed });
        this.frames = 0;
        this.windowStart = now;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },
};

// ===========================================================================
// Bootstrap
// ===========================================================================

cosmetic.init();
gestures.init();
autofill.init();
frameStats.init();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => cosmetic.scan(), { once: true });
}

/**
 * Internal pages get the full privileged bridge. Web pages never do — and
 * the main process re-checks trust independently, so this is the outer of
 * two locks rather than the only one.
 */
if (IS_INTERNAL) {
  contextBridge.exposeInMainWorld('aether', Object.freeze({
    invoke: async (channel, payload) => {
      const result = await ipcRenderer.invoke('aether:invoke', channel, payload);
      if (result && typeof result === 'object' && '__error' in result) {
        throw new Error(result.__error);
      }
      return result;
    },
    send: (channel, payload) => ipcRenderer.send('aether:send', channel, payload),
    on: (channel, callback) => {
      const handler = (_e, ch, payload) => { if (ch === channel) callback(payload); };
      ipcRenderer.on('aether:event', handler);
      return () => ipcRenderer.off('aether:event', handler);
    },
    env: Object.freeze({
      platform: process.platform,
      chromium: process.versions.chrome,
      internal: true,
    }),
  }));
}
