'use strict';
/**
 * Student Mode (spec §6).
 *
 * Citation formatting and ICS parsing live in their own modules because they
 * are pure and heavily tested; this file is the stateful part — the source
 * library, the study timer and its blocker, flashcard generation, PDF
 * annotations and OCR.
 *
 * The blocker is enforced at the **network layer**, through the same request
 * hub as ad blocking, rather than by a content script that hides the page.
 * A study blocker that only draws over the page is defeated by reader mode,
 * by view-source, and by the user's own muscle memory — it has to actually
 * not load.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const { hubFor, PRIORITY } = require('../web-request-hub');
const { JsonStore } = require('../../util/json-store');
const citations = require('./citations');
const { parseIcs, bucketByUrgency } = require('./ics');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('student');

/** Classic Pomodoro, and the two variants people actually ask for. */
const TIMER_PRESETS = [
  { id: 'pomodoro', name: 'Pomodoro', focusMin: 25, breakMin: 5, longBreakMin: 15, rounds: 4 },
  { id: 'deep', name: 'Deep work', focusMin: 50, breakMin: 10, longBreakMin: 20, rounds: 3 },
  { id: 'sprint', name: 'Sprint', focusMin: 15, breakMin: 3, longBreakMin: 10, rounds: 4 },
];

class StudentService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../settings').SettingsService} deps.settings
   * @param {import('../feature-store').FeatureStore} deps.features
   * @param {import('../ai')} deps.ai
   * @param {import('../content-bridge').ContentBridge} deps.content
   */
  constructor({ settings, features, ai, content }) {
    super();
    this.settings = settings;
    this.features = features;
    this.ai = ai;
    this.content = content;

    this.store = new JsonStore(paths.userData('study.json'), {
      sources: [],        // captured citations
      decks: [],          // flashcard decks
      annotations: {},    // docKey -> [{page, rect, colour, note, text}]
      deadlines: [],      // imported calendar events
      feeds: [],          // ICS subscription URLs
      ocr: {},            // docKey -> extracted text by page
    });

    /** Live timer state. Deliberately not persisted: a timer that survives a
     *  restart and claims you are 12 minutes into a session you abandoned
     *  yesterday is worse than one that simply starts fresh. */
    this.timer = null;
    this._tick = null;
  }

  // == Citations =========================================================

  /**
   * Capture the current page as a source.
   * @param {object} tab
   */
  async captureSource(tab) {
    if (!this.features.enabled('citations')) throw new Error('the citation manager is off');
    if (!tab?.webContents) throw new Error('no page to capture');

    const meta = await this.content.request(tab.webContents, 'page.metadata')
      .catch(() => ({}));

    const source = citations.fromPageMetadata(meta || {}, tab.url);
    source.id = crypto.randomUUID();
    source.capturedAt = Date.now();

    this.store.data.sources.unshift(source);
    this.store.save();

    log.info(`captured source: ${source.title} (${source.confidence} confidence)`);
    this.emit('changed', this.library());
    return source;
  }

  updateSource(id, patch) {
    const source = this.store.data.sources.find((s) => s.id === id);
    if (!source) throw new Error('unknown source');
    Object.assign(source, patch, { id: source.id });
    this.store.save();
    this.emit('changed', this.library());
    return source;
  }

  removeSource(id) {
    this.store.data.sources = this.store.data.sources.filter((s) => s.id !== id);
    this.store.save();
    this.emit('changed', this.library());
    return this.library();
  }

  /** Render one source, or the whole library, in a named style. */
  cite(id, style = 'apa') {
    const source = this.store.data.sources.find((s) => s.id === id);
    if (!source) throw new Error('unknown source');
    return { id, style, text: citations.format(source, style) };
  }

  exportBibliography(style = 'apa', ids = null) {
    const chosen = ids
      ? this.store.data.sources.filter((s) => ids.includes(s.id))
      : this.store.data.sources;
    return {
      style,
      count: chosen.length,
      entries: citations.bibliography(chosen, style),
      // CSL-JSON alongside the formatted text, so the library can be opened
      // in Zotero or fed to Pandoc without retyping anything.
      csl: chosen.map(toCsl),
    };
  }

  library() {
    return {
      sources: this.store.data.sources,
      styles: citations.styles(),
    };
  }

  // == Focus timer and blocker ===========================================

  timerPresets() {
    return TIMER_PRESETS;
  }

  /**
   * Start a study session. The blocker arms with the timer, so there is one
   * thing to turn on rather than two, and it cannot be left armed by
   * accident after the session ends.
   */
  startTimer({ preset = 'pomodoro', blockList } = {}) {
    if (!this.features.enabled('focusBlocker')) throw new Error('the focus timer is off');

    const config = TIMER_PRESETS.find((p) => p.id === preset) || TIMER_PRESETS[0];
    if (blockList) this.settings.set('study.blockList', normaliseHosts(blockList));

    this.timer = {
      preset: config.id,
      phase: 'focus',
      round: 1,
      rounds: config.rounds,
      startedAt: Date.now(),
      endsAt: Date.now() + config.focusMin * 60_000,
      config,
    };

    this._startTicking();
    log.info(`study session started: ${config.name}`);
    this.emit('timer', this.timerState());
    return this.timerState();
  }

  stopTimer() {
    this.timer = null;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this.emit('timer', this.timerState());
    return this.timerState();
  }

  _startTicking() {
    if (this._tick) clearInterval(this._tick);
    this._tick = setInterval(() => this._advance(), 1000);
    this._tick.unref?.();
  }

  _advance() {
    if (!this.timer) return;
    if (Date.now() < this.timer.endsAt) {
      this.emit('timer', this.timerState());
      return;
    }

    const { config } = this.timer;
    if (this.timer.phase === 'focus') {
      const isLong = this.timer.round % config.rounds === 0;
      this.timer.phase = isLong ? 'longBreak' : 'break';
      this.timer.endsAt = Date.now() + (isLong ? config.longBreakMin : config.breakMin) * 60_000;
    } else {
      this.timer.phase = 'focus';
      this.timer.round += 1;
      this.timer.endsAt = Date.now() + config.focusMin * 60_000;
    }

    this.emit('timer', this.timerState());
    this.emit('phase', { phase: this.timer.phase, round: this.timer.round });
  }

  timerState() {
    if (!this.timer) {
      return { running: false, blocking: false, blockList: this.blockList() };
    }
    return {
      running: true,
      phase: this.timer.phase,
      round: this.timer.round,
      rounds: this.timer.rounds,
      preset: this.timer.preset,
      remainingMs: Math.max(0, this.timer.endsAt - Date.now()),
      // Breaks deliberately unblock: a timer that never lets up gets turned
      // off entirely, and then blocks nothing at all.
      blocking: this.timer.phase === 'focus',
      blockList: this.blockList(),
    };
  }

  blockList() {
    return this.settings.get('study.blockList') || [];
  }

  setBlockList(hosts) {
    const list = normaliseHosts(hosts);
    this.settings.set('study.blockList', list);
    this.emit('timer', this.timerState());
    return list;
  }

  /** Per-site daily limits, independent of the timer. */
  setSiteLimit(host, minutes) {
    const limits = { ...(this.settings.get('study.siteLimits') || {}) };
    if (!minutes) delete limits[host];
    else limits[host] = minutes;
    this.settings.set('study.siteLimits', limits);
    return limits;
  }

  /**
   * Record time spent, so a per-site limit can be enforced. Called from the
   * window layer as the active tab changes.
   */
  recordTime(host, ms) {
    if (!host || !this.features.enabled('focusBlocker')) return;
    const today = new Date().toISOString().slice(0, 10);
    const usage = { ...(this.settings.get('study.usage') || {}) };
    if (usage.date !== today) { usage.date = today; usage.hosts = {}; }
    usage.hosts = { ...(usage.hosts || {}) };
    usage.hosts[host] = (usage.hosts[host] || 0) + ms;
    this.settings.set('study.usage', usage);
  }

  /**
   * The blocking decision, as a pure predicate so it can be tested without
   * a session or a live request.
   */
  shouldBlock(url) {
    if (!this.features.enabled('focusBlocker')) return null;

    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }

    const matches = (list) => (list || []).some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );

    if (this.timer?.phase === 'focus' && matches(this.blockList())) {
      return { reason: 'focus', host, until: this.timer.endsAt };
    }

    const limits = this.settings.get('study.siteLimits') || {};
    const usage = this.settings.get('study.usage') || {};
    const today = new Date().toISOString().slice(0, 10);
    if (usage.date !== today) return null;

    for (const [entry, minutes] of Object.entries(limits)) {
      if (host !== entry && !host.endsWith(`.${entry}`)) continue;
      const spent = (usage.hosts || {})[entry] || (usage.hosts || {})[host] || 0;
      if (spent >= minutes * 60_000) {
        return { reason: 'limit', host, minutes, spentMs: spent };
      }
    }
    return null;
  }

  /**
   * Arm the blocker on a session. Only main-frame navigations are cancelled:
   * blocking a subresource would break unrelated pages that happen to embed
   * something from a blocked host, which reads as the browser malfunctioning.
   */
  attach(session) {
    hubFor(session).register('onBeforeRequest', 'focus-blocker', PRIORITY.FOCUS_BLOCK,
      (details) => {
        if (details.resourceType !== 'mainFrame') return null;
        const verdict = this.shouldBlock(details.url);
        if (!verdict) return null;
        return {
          redirectURL: `aether://blocked?reason=${encodeURIComponent(verdict.reason)}`
            + `&host=${encodeURIComponent(verdict.host)}`,
        };
      });
  }

  // == Flashcards ========================================================

  /**
   * Generate a deck from the current page, a PDF, or supplied text.
   *
   * Cards are generated by the assistant, which means they inherit its
   * grounding rules: the model sees the document and nothing else, and a
   * private window contributes nothing.
   */
  async generateDeck({ tab, text, title, count = 20 } = {}) {
    if (!this.features.enabled('flashcards')) throw new Error('flashcards are off');

    const material = text || (tab
      ? (await this.ai.pageContext(tab)).text
      : null);
    if (!material) throw new Error('nothing to make cards from');

    const response = await this.ai.complete({
      system: 'You write study flashcards. Return ONLY a JSON array of objects with '
        + '"front", "back" and optional "hint". Each card tests one fact or idea. '
        + 'Fronts are questions, not fragments. Never invent material that is not in '
        + 'the source.',
      prompt: `Write up to ${count} flashcards from this material:\n\n${material.slice(0, 40_000)}`,
      json: true,
    });

    const cards = coerceCards(response);
    if (!cards.length) throw new Error('the model returned no usable cards');

    const deck = {
      id: crypto.randomUUID(),
      title: title || tab?.title || 'Untitled deck',
      sourceUrl: tab?.url || '',
      createdAt: Date.now(),
      cards: cards.map((c) => ({
        id: crypto.randomUUID(),
        front: c.front,
        back: c.back,
        hint: c.hint || '',
        // Leitner box scheduling: a card answered correctly moves up a box
        // and is seen less often. Simple, well-studied, and does not need a
        // spaced-repetition library.
        box: 1,
        dueAt: Date.now(),
      })),
    };

    this.store.data.decks.unshift(deck);
    this.store.save();
    this.emit('decks', this.decks());
    return deck;
  }

  decks() {
    return this.store.data.decks.map((d) => ({
      ...d,
      due: d.cards.filter((c) => c.dueAt <= Date.now()).length,
    }));
  }

  removeDeck(id) {
    this.store.data.decks = this.store.data.decks.filter((d) => d.id !== id);
    this.store.save();
    this.emit('decks', this.decks());
    return this.decks();
  }

  /** Grade a card and reschedule it. */
  reviewCard(deckId, cardId, correct) {
    const deck = this.store.data.decks.find((d) => d.id === deckId);
    const card = deck?.cards.find((c) => c.id === cardId);
    if (!card) throw new Error('unknown card');

    card.box = correct ? Math.min(card.box + 1, 5) : 1;
    const days = [0, 1, 2, 4, 8, 16][card.box];
    card.dueAt = Date.now() + days * 86_400_000;
    card.lastReviewed = Date.now();

    this.store.save();
    this.emit('decks', this.decks());
    return card;
  }

  // == PDF annotation and OCR ============================================

  /**
   * Annotations key off a hash of the document, not its URL, so the same
   * PDF opened from a different link — or from disk after downloading —
   * still shows the highlights the student made.
   */
  docKey(input) {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  annotations(docKey) {
    return this.store.data.annotations[docKey] || [];
  }

  addAnnotation(docKey, annotation) {
    if (!this.features.enabled('pdfAnnotate')) throw new Error('PDF annotation is off');
    const list = this.store.data.annotations[docKey] || [];
    const record = { id: crypto.randomUUID(), createdAt: Date.now(), ...annotation };
    list.push(record);
    this.store.data.annotations[docKey] = list;
    this.store.save();
    this.emit('annotations', { docKey, annotations: list });
    return record;
  }

  removeAnnotation(docKey, id) {
    const list = (this.store.data.annotations[docKey] || []).filter((a) => a.id !== id);
    this.store.data.annotations[docKey] = list;
    this.store.save();
    this.emit('annotations', { docKey, annotations: list });
    return list;
  }

  /**
   * Search every annotation and every OCR'd page.
   *
   * Plain substring matching over a student's own library, which is small
   * enough that an index would be more code than it saves.
   */
  searchNotes(query) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return [];

    const hits = [];
    for (const [docKey, list] of Object.entries(this.store.data.annotations)) {
      for (const a of list) {
        const haystack = `${a.text || ''} ${a.note || ''}`.toLowerCase();
        if (haystack.includes(needle)) hits.push({ kind: 'annotation', docKey, ...a });
      }
    }
    for (const [docKey, pages] of Object.entries(this.store.data.ocr)) {
      for (const [page, text] of Object.entries(pages)) {
        if (String(text).toLowerCase().includes(needle)) {
          hits.push({ kind: 'ocr', docKey, page: Number(page), excerpt: excerpt(text, needle) });
        }
      }
    }
    return hits;
  }

  /**
   * Store OCR output for a page.
   *
   * Aether does not bundle an OCR engine: a WASM build of Tesseract is
   * ~15 MB and most course PDFs already have a text layer. The recogniser is
   * therefore pluggable — the renderer runs it and posts results here — and
   * the panel says plainly when no engine is configured rather than showing
   * an empty search box that will never match anything.
   */
  storeOcr(docKey, page, text) {
    if (!this.features.enabled('ocrSearch')) throw new Error('OCR search is off');
    const pages = this.store.data.ocr[docKey] || {};
    pages[page] = text;
    this.store.data.ocr[docKey] = pages;
    this.store.save();
    return { docKey, page, chars: String(text).length };
  }

  ocrStatus() {
    const docs = Object.keys(this.store.data.ocr).length;
    return {
      indexedDocuments: docs,
      engine: this.settings.get('study.ocrEngine') || null,
      note: this.settings.get('study.ocrEngine')
        ? undefined
        : 'No OCR engine configured. Pages with a text layer are searchable already; '
          + 'scanned pages need an engine before they can be.',
    };
  }

  // == Deadlines =========================================================

  /**
   * Import an LMS calendar feed.
   * @param {string} url an ICS feed URL from Canvas, Moodle, etc.
   */
  async importFeed(url, fetchImpl = fetch) {
    if (!this.features.enabled('deadlines')) throw new Error('the deadline tracker is off');
    if (!/^https?:\/\//.test(url)) throw new Error('a calendar feed must be an http(s) URL');

    const response = await fetchImpl(url, { headers: { Accept: 'text/calendar' } });
    if (!response.ok) throw new Error(`the feed returned ${response.status}`);

    const { events, name, errors } = parseIcs(await response.text());

    const feeds = this.store.data.feeds.filter((f) => f.url !== url);
    feeds.push({ url, name: name || url, importedAt: Date.now(), count: events.length });
    this.store.data.feeds = feeds;

    // Replace this feed's events wholesale rather than merging: an
    // assignment cancelled upstream should disappear here too.
    this.store.data.deadlines = [
      ...this.store.data.deadlines.filter((d) => d.feedUrl !== url),
      ...events.map((e) => ({ ...e, feedUrl: url, due: e.due ? e.due.toISOString() : null })),
    ];
    this.store.save();

    log.info(`imported ${events.length} deadline(s) from ${name || url}`);
    this.emit('deadlines', this.deadlines());
    return { name, imported: events.length, errors };
  }

  removeFeed(url) {
    this.store.data.feeds = this.store.data.feeds.filter((f) => f.url !== url);
    this.store.data.deadlines = this.store.data.deadlines.filter((d) => d.feedUrl !== url);
    this.store.save();
    this.emit('deadlines', this.deadlines());
    return this.deadlines();
  }

  deadlines() {
    const events = this.store.data.deadlines.map((d) => ({
      ...d, due: d.due ? new Date(d.due) : null,
    }));
    return {
      feeds: this.store.data.feeds,
      buckets: bucketByUrgency(events),
      total: events.length,
    };
  }

  // == Study room ========================================================

  /**
   * A group study room is a URL pinned over the study tabs.
   *
   * Aether does not run signalling or TURN servers, so it does not implement
   * its own conferencing: it pins whatever room the group already uses. That
   * is a smaller promise than the spec's wording, and it is the honest one —
   * a browser-built video stack with no infrastructure behind it would work
   * on a LAN and fail everywhere else.
   */
  studyRoom() {
    return {
      url: this.settings.get('study.roomUrl') || '',
      pinned: this.settings.get('study.roomPinned') === true,
      note: 'Pins an existing room (Jitsi, Meet, Discord) over your tabs. '
        + 'Aether does not host the call.',
    };
  }

  setStudyRoom({ url, pinned }) {
    if (url !== undefined) this.settings.set('study.roomUrl', url);
    if (pinned !== undefined) this.settings.set('study.roomPinned', pinned === true);
    this.emit('room', this.studyRoom());
    return this.studyRoom();
  }

  dispose() {
    this.stopTimer();
  }
}

// ---------------------------------------------------------------------------

function normaliseHosts(hosts) {
  return [...new Set((hosts || [])
    .map((h) => String(h).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, ''))
    .filter(Boolean))];
}

/** Model output arrives as JSON, or as JSON wrapped in prose. Handle both. */
function coerceCards(response) {
  let value = response;
  if (typeof value === 'string') {
    const match = value.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { value = JSON.parse(match[0]); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string')
    .map((c) => ({ front: c.front.trim(), back: c.back.trim(), hint: c.hint }));
}

function toCsl(source) {
  const issued = source.issued ? source.issued.split('-').map(Number) : null;
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    author: source.authors,
    'container-title': source.container,
    publisher: source.publisher,
    URL: source.url,
    DOI: source.doi,
    volume: source.volume,
    issue: source.issue,
    page: source.pages,
    issued: issued ? { 'date-parts': [issued] } : undefined,
  };
}

function excerpt(text, needle, radius = 60) {
  const index = String(text).toLowerCase().indexOf(needle);
  if (index === -1) return String(text).slice(0, radius * 2);
  return String(text).slice(Math.max(0, index - radius), index + needle.length + radius);
}

module.exports = { StudentService, TIMER_PRESETS };
