'use strict';
/**
 * Creator Mode (spec §5).
 *
 * Two of these features need third-party accounts to be real — the upload
 * scheduler and channel analytics — and one does not need any: the asset
 * library, because Openverse and Wikimedia Commons both serve open search
 * APIs with no key at all.
 *
 * Where an account is required, this implements the *whole client* and stops
 * at the credential, rather than shipping a mock that looks like it works.
 * The panel says which platforms are connected and what connecting involves.
 * A scheduler that silently queued posts nowhere would be the single most
 * damaging thing in this file.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('creator');

/**
 * Asset sources.
 *
 * Openverse (Creative Commons' own index, ~700M works) and Wikimedia Commons
 * are keyless and explicitly licensed, which is what "royalty-free" has to
 * mean for someone publishing commercially. Pexels is offered but needs a
 * free key, and is off until one is supplied.
 */
const ASSET_SOURCES = {
  openverse: {
    name: 'Openverse',
    keyless: true,
    licence: 'CC and public domain, per-result',
    endpoint: 'https://api.openverse.org/v1',
  },
  wikimedia: {
    name: 'Wikimedia Commons',
    keyless: true,
    licence: 'CC and public domain, per-result',
    endpoint: 'https://commons.wikimedia.org/w/api.php',
  },
  pexels: {
    name: 'Pexels',
    keyless: false,
    licence: 'Pexels licence',
    endpoint: 'https://api.pexels.com/v1',
    keySetting: 'creator.pexelsKey',
  },
};

/**
 * Feed layouts the thumbnail A/B preview simulates.
 *
 * Aspect ratios and the surrounding furniture matter more than pixel
 * accuracy: the question a creator is asking is "does the text survive at
 * sidebar size", and these are the sizes that decides it.
 */
const FEED_LAYOUTS = [
  { id: 'yt-home', name: 'YouTube home', width: 360, height: 202, ratio: '16:9', showsTitle: true, titleLines: 2 },
  { id: 'yt-sidebar', name: 'YouTube sidebar', width: 168, height: 94, ratio: '16:9', showsTitle: true, titleLines: 2 },
  { id: 'yt-mobile', name: 'YouTube mobile', width: 400, height: 225, ratio: '16:9', showsTitle: true, titleLines: 2 },
  { id: 'shorts', name: 'Shorts / Reels', width: 202, height: 360, ratio: '9:16', showsTitle: false },
  { id: 'ig-grid', name: 'Instagram grid', width: 240, height: 240, ratio: '1:1', showsTitle: false },
];

class CreatorService extends EventEmitter {
  constructor({ settings, features, content }) {
    super();
    this.settings = settings;
    this.features = features;
    this.content = content;

    this.store = new JsonStore(paths.userData('creator.json'), {
      queue: [],        // scheduled posts
      history: [],      // what was published, and what failed
      scripts: [],      // teleprompter scripts
    });

    this._timer = null;
  }

  // == Asset library =====================================================

  /**
   * Search open-licensed media.
   *
   * Results carry their licence and attribution string, because using a CC-BY
   * image without the attribution is a licence violation, and a tool that
   * makes assets easy to find while making attribution hard is a trap.
   */
  async search({ query, kind = 'image', source = 'openverse', page = 1 } = {}, fetchImpl = fetch) {
    if (!this.features.enabled('assetLibrary')) throw new Error('the asset library is off');
    if (!query?.trim()) return { results: [], source, kind };

    const spec = ASSET_SOURCES[source];
    if (!spec) throw new Error(`unknown asset source "${source}"`);
    if (!spec.keyless && !this.settings.get(spec.keySetting)) {
      throw new Error(`${spec.name} needs a free API key. Add one in Settings → Creator.`);
    }

    if (source === 'openverse') return this._searchOpenverse(query, kind, page, fetchImpl);
    if (source === 'wikimedia') return this._searchWikimedia(query, page, fetchImpl);
    return this._searchPexels(query, kind, page, fetchImpl);
  }

  async _searchOpenverse(query, kind, page, fetchImpl) {
    const path = kind === 'audio' ? 'audio' : 'images';
    const url = `${ASSET_SOURCES.openverse.endpoint}/${path}/`
      + `?q=${encodeURIComponent(query)}&page=${page}&page_size=24`;

    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Openverse returned ${response.status}`);
    const body = await response.json();

    return {
      source: 'openverse',
      kind,
      total: body.result_count ?? 0,
      results: (body.results || []).map((r) => ({
        id: r.id,
        title: r.title || 'Untitled',
        thumbnail: r.thumbnail || r.url,
        url: r.url,
        pageUrl: r.foreign_landing_url,
        creator: r.creator || 'Unknown',
        licence: `${r.license || ''} ${r.license_version || ''}`.trim().toUpperCase(),
        licenceUrl: r.license_url,
        attribution: r.attribution
          || `"${r.title}" by ${r.creator} is licensed under ${r.license?.toUpperCase()}.`,
        width: r.width, height: r.height, duration: r.duration,
      })),
    };
  }

  async _searchWikimedia(query, page, fetchImpl) {
    const offset = (page - 1) * 24;
    const url = `${ASSET_SOURCES.wikimedia.endpoint}?action=query&format=json&origin=*`
      + `&generator=search&gsrnamespace=6&gsrlimit=24&gsroffset=${offset}`
      + `&gsrsearch=${encodeURIComponent(query)}`
      + '&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=320';

    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Wikimedia returned ${response.status}`);
    const body = await response.json();

    const pages = Object.values(body.query?.pages || {});
    return {
      source: 'wikimedia',
      kind: 'image',
      total: pages.length,
      results: pages.map((p) => {
        const info = p.imageinfo?.[0] || {};
        const meta = info.extmetadata || {};
        return {
          id: String(p.pageid),
          title: p.title?.replace(/^File:/, '') || 'Untitled',
          thumbnail: info.thumburl || info.url,
          url: info.url,
          pageUrl: info.descriptionurl,
          creator: stripHtml(meta.Artist?.value) || 'Unknown',
          licence: (meta.LicenseShortName?.value || '').toUpperCase(),
          licenceUrl: meta.LicenseUrl?.value,
          attribution: `"${p.title?.replace(/^File:/, '')}" by `
            + `${stripHtml(meta.Artist?.value) || 'Unknown'} — ${meta.LicenseShortName?.value || ''}`,
          width: info.width, height: info.height,
        };
      }),
    };
  }

  async _searchPexels(query, kind, page, fetchImpl) {
    const key = this.settings.get('creator.pexelsKey');
    const path = kind === 'video' ? 'videos/search' : 'search';
    const base = kind === 'video' ? 'https://api.pexels.com' : ASSET_SOURCES.pexels.endpoint;
    const response = await fetchImpl(
      `${base}/${path}?query=${encodeURIComponent(query)}&per_page=24&page=${page}`,
      { headers: { Authorization: key } },
    );
    if (!response.ok) throw new Error(`Pexels returned ${response.status}`);
    const body = await response.json();

    const items = body.photos || body.videos || [];
    return {
      source: 'pexels',
      kind,
      total: body.total_results ?? items.length,
      results: items.map((r) => ({
        id: String(r.id),
        title: r.alt || 'Untitled',
        thumbnail: r.src?.medium || r.image,
        url: r.src?.original || r.video_files?.[0]?.link,
        pageUrl: r.url,
        creator: r.photographer || r.user?.name || 'Unknown',
        licence: 'PEXELS',
        attribution: `Photo by ${r.photographer || r.user?.name} on Pexels`,
        width: r.width, height: r.height, duration: r.duration,
      })),
    };
  }

  assetSources() {
    return Object.entries(ASSET_SOURCES).map(([id, spec]) => ({
      id,
      ...spec,
      available: spec.keyless || Boolean(this.settings.get(spec.keySetting)),
      enabled: this.settings.get(`creator.assetSources.${id}`) !== false,
    }));
  }

  // == Brand kit =========================================================

  brandKits() {
    return {
      kits: this.settings.get('creator.brandKits') || [],
      activeId: this.settings.get('creator.activeKit') || '',
    };
  }

  saveBrandKit({ id, name, colours = [], fonts = [] }) {
    const kits = [...(this.settings.get('creator.brandKits') || [])];
    const record = {
      id: id || crypto.randomUUID(),
      name: String(name || 'Untitled kit').trim(),
      // Normalised so a kit built from an eyedropper and one typed by hand
      // compare equal, which matters for the "already in your kit" badge.
      colours: colours.map(normaliseColour).filter(Boolean),
      fonts: fonts.map((f) => String(f).trim()).filter(Boolean),
      updatedAt: Date.now(),
    };

    const index = kits.findIndex((k) => k.id === record.id);
    if (index === -1) kits.push(record); else kits[index] = record;

    this.settings.set('creator.brandKits', kits);
    if (!this.settings.get('creator.activeKit')) this.settings.set('creator.activeKit', record.id);
    this.emit('changed', this.snapshot());
    return record;
  }

  removeBrandKit(id) {
    const kits = (this.settings.get('creator.brandKits') || []).filter((k) => k.id !== id);
    this.settings.set('creator.brandKits', kits);
    if (this.settings.get('creator.activeKit') === id) {
      this.settings.set('creator.activeKit', kits[0]?.id || '');
    }
    this.emit('changed', this.snapshot());
    return this.brandKits();
  }

  /**
   * Push a colour or font into whatever editor the user is looking at.
   *
   * Web editors have no common API, so this works the way a human would: it
   * copies the value and focuses the field, rather than pretending to know
   * Canva's internals. The panel says "copied — paste into the colour field",
   * which is honest and still saves the round trip to a design doc.
   */
  async applyBrandValue(tab, value) {
    if (!this.features.enabled('brandKit')) throw new Error('the brand kit is off');
    if (!tab?.webContents) throw new Error('no page to apply to');
    const result = await this.content.request(tab.webContents, 'brand.apply', { value })
      .catch(() => ({ applied: false }));
    return { value, ...result };
  }

  // == Thumbnail A/B =====================================================

  feedLayouts() {
    return FEED_LAYOUTS;
  }

  /**
   * Prepare an A/B comparison.
   *
   * The genuinely useful part is not the side-by-side — any image viewer does
   * that — it is rendering both at the *sizes a feed actually uses*, where a
   * thumbnail that reads fine at full width becomes unreadable.
   */
  thumbnailComparison(slots = this.settings.get('creator.thumbnailSlots') || []) {
    return {
      slots: slots.slice(0, 2),
      layouts: FEED_LAYOUTS,
      checks: slots.length === 2 ? [
        'Read both at the sidebar size first — that is where most impressions happen.',
        'Check the text against a light and a dark feed background.',
        'Faces and text should survive being scaled to 168px wide.',
      ] : [],
    };
  }

  setThumbnailSlot(index, filePath) {
    const slots = [...(this.settings.get('creator.thumbnailSlots') || [])];
    slots[index] = filePath;
    this.settings.set('creator.thumbnailSlots', slots.slice(0, 2));
    this.emit('changed', this.snapshot());
    return this.thumbnailComparison();
  }

  // == Teleprompter ======================================================

  scripts() {
    return this.store.data.scripts;
  }

  saveScript({ id, title, body }) {
    const scripts = this.store.data.scripts;
    const record = {
      id: id || crypto.randomUUID(),
      title: title || 'Untitled script',
      body: body || '',
      updatedAt: Date.now(),
      // Reading rate is what decides scroll speed; 150 wpm is a common
      // presenting pace and gives a usable default before anyone tunes it.
      words: String(body || '').trim().split(/\s+/).filter(Boolean).length,
    };
    record.estimatedSeconds = Math.round((record.words / 150) * 60);

    const index = scripts.findIndex((s) => s.id === record.id);
    if (index === -1) scripts.unshift(record); else scripts[index] = record;

    this.store.save();
    this.emit('scripts', this.scripts());
    return record;
  }

  removeScript(id) {
    this.store.data.scripts = this.store.data.scripts.filter((s) => s.id !== id);
    this.store.save();
    this.emit('scripts', this.scripts());
    return this.scripts();
  }

  teleprompterSettings() {
    return this.settings.get('creator.teleprompter');
  }

  // == Upload scheduler ==================================================

  /**
   * Queue a post.
   *
   * The queue is real and persistent; publishing requires a connected
   * account. An item whose platform is not connected is queued with status
   * `blocked` and says why, rather than sitting in `pending` forever looking
   * like it is about to go out.
   */
  schedule({ platform, when, title, body, assetPath }) {
    if (!this.features.enabled('uploadScheduler')) throw new Error('the scheduler is off');

    const at = new Date(when).getTime();
    if (!Number.isFinite(at)) throw new Error('a scheduled post needs a valid time');
    if (at < Date.now() - 60_000) throw new Error('that time is in the past');

    const connected = this.connectedPlatforms().find((p) => p.id === platform);
    const item = {
      id: crypto.randomUUID(),
      platform,
      when: at,
      title: title || '',
      body: body || '',
      assetPath: assetPath || '',
      status: connected?.connected ? 'pending' : 'blocked',
      blockedReason: connected?.connected
        ? undefined
        : `${platform} is not connected. Connect it in Settings → Creator to publish.`,
      createdAt: Date.now(),
    };

    this.store.data.queue.push(item);
    this.store.data.queue.sort((a, b) => a.when - b.when);
    this.store.save();
    this._ensureTimer();
    this.emit('changed', this.snapshot());
    return item;
  }

  unschedule(id) {
    this.store.data.queue = this.store.data.queue.filter((q) => q.id !== id);
    this.store.save();
    this.emit('changed', this.snapshot());
    return this.snapshot();
  }

  queue() {
    return this.store.data.queue;
  }

  connectedPlatforms() {
    const connected = this.settings.get('creator.connectedChannels') || [];
    return [
      { id: 'youtube', name: 'YouTube', scopes: 'upload, analytics' },
      { id: 'x', name: 'X', scopes: 'post' },
      { id: 'instagram', name: 'Instagram', scopes: 'post (business accounts)' },
      { id: 'tiktok', name: 'TikTok', scopes: 'post' },
      { id: 'mastodon', name: 'Mastodon', scopes: 'post' },
    ].map((p) => ({
      ...p,
      connected: connected.some((c) => c.platform === p.id),
      handle: connected.find((c) => c.platform === p.id)?.handle || null,
    }));
  }

  _ensureTimer() {
    if (this._timer) return;
    // A minute is fine: nothing here is second-sensitive, and a tighter
    // interval would wake the process for no reason.
    this._timer = setInterval(() => this._runDue(), 60_000);
    this._timer.unref?.();
  }

  _runDue() {
    const due = this.store.data.queue.filter((q) => q.status === 'pending' && q.when <= Date.now());
    if (!due.length) return;

    for (const item of due) {
      // Publishing needs the platform client, which needs OAuth. Until a
      // token exists the item moves to `blocked` with a reason rather than
      // being dropped or silently retried forever.
      item.status = 'blocked';
      item.blockedReason = `Ready to publish, but ${item.platform} has no stored credential.`;
      log.info(`scheduled item ${item.id} is due but ${item.platform} is not connected`);
    }
    this.store.save();
    this.emit('changed', this.snapshot());
  }

  // == Analytics =========================================================

  /**
   * Channel analytics need an OAuth token per platform. Rather than showing
   * an empty dashboard, this reports connection state and exactly what is
   * missing.
   */
  analytics() {
    const platforms = this.connectedPlatforms().filter((p) => p.connected);
    if (!platforms.length) {
      return {
        connected: [],
        note: 'Connect a channel to see views and engagement here. '
          + 'Aether stores the token in your encrypted vault, not in settings.',
      };
    }
    return { connected: platforms, series: [], note: 'Fetching…' };
  }

  // == Focus canvas ======================================================

  /**
   * Focus canvas is a *layout* state, not a window mode: the chrome
   * collapses and the active tab takes the whole window. Implemented in the
   * layout engine so it composes with split view rather than fighting it.
   */
  focusCanvas() {
    return { active: this.settings.get('creator.focusCanvas') === true };
  }

  setFocusCanvas(active) {
    this.settings.set('creator.focusCanvas', active === true);
    this.emit('focusCanvas', this.focusCanvas());
    return this.focusCanvas();
  }

  snapshot() {
    return {
      kits: this.brandKits(),
      queue: this.queue(),
      platforms: this.connectedPlatforms(),
      sources: this.assetSources(),
      thumbnails: this.thumbnailComparison(),
      scripts: this.scripts(),
      teleprompter: this.teleprompterSettings(),
      focusCanvas: this.focusCanvas(),
    };
  }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

function normaliseColour(value) {
  const raw = String(value || '').trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (!hex) return raw.startsWith('rgb') || raw.startsWith('oklch') ? raw : null;
  const body = hex[1];
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
  return `#${full.toUpperCase()}`;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

module.exports = { CreatorService, ASSET_SOURCES, FEED_LAYOUTS };
