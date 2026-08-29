'use strict';
/**
 * Deals and key tracking (spec §4).
 *
 * Backed by CheapShark, which aggregates ~30 storefronts (Steam, GOG, Epic,
 * Humble, Fanatical, GreenManGaming and the rest), is free, needs no key,
 * and asks only that you do not hammer it. That last point shapes the design
 * here more than anything else: prices are cached, the watch loop runs
 * hourly rather than continuously, and a wishlist scan walks the list in
 * series.
 *
 * Grey-market key resellers are deliberately not aggregated. CheapShark's
 * store list is authorised retailers, and a browser feature that steered
 * users toward keys of unclear provenance would be doing them a disservice
 * dressed as a saving.
 */
const EventEmitter = require('node:events');

const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('deals');

const API = 'https://www.cheapshark.com/api/1.0';
/** Prices do not move minute to minute; an hour is generous and polite. */
const REFRESH_MS = 60 * 60 * 1000;
const CACHE_MS = 15 * 60 * 1000;

class DealsService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;

    this.store = new JsonStore(paths.userData('deals.json'), {
      watched: [],      // { id, title, gameId, targetPrice, lastPrice, notifiedAt }
      stores: [],       // cached store metadata
      lastRefresh: 0,
    });

    this._cache = new Map();   // url -> { at, body }
    this._timer = null;
  }

  // -- catalogue ---------------------------------------------------------

  async stores(fetchImpl = fetch) {
    if (this.store.data.stores.length
      && Date.now() - this.store.data.lastRefresh < 24 * 60 * 60 * 1000) {
      return this.store.data.stores;
    }

    const body = await this._get(`${API}/stores`, fetchImpl);
    this.store.data.stores = (body || [])
      .filter((s) => s.isActive)
      .map((s) => ({ id: s.storeID, name: s.storeName }));
    this.store.data.lastRefresh = Date.now();
    this.store.save();
    return this.store.data.stores;
  }

  /**
   * Search for a title.
   *
   * Returns the cheapest current price per game plus the store holding it,
   * which is the only shape the panel actually renders.
   */
  async search(title, fetchImpl = fetch) {
    if (!this.features.enabled('deals')) throw new Error('the deals tracker is off');
    if (!title?.trim()) return [];

    const body = await this._get(
      `${API}/games?title=${encodeURIComponent(title.trim())}&limit=20`, fetchImpl,
    );

    return (body || []).map((g) => ({
      gameId: g.gameID,
      title: g.external,
      thumbnail: g.thumb,
      cheapest: g.cheapest ? Number(g.cheapest) : null,
      cheapestDealId: g.cheapestDealID,
    }));
  }

  /** Every current offer for one game, cheapest first. */
  async offers(gameId, fetchImpl = fetch) {
    const body = await this._get(`${API}/games?id=${encodeURIComponent(gameId)}`, fetchImpl);
    const stores = await this.stores(fetchImpl).catch(() => []);
    const byId = new Map(stores.map((s) => [s.id, s.name]));

    return {
      title: body?.info?.title || '',
      thumbnail: body?.info?.thumb || '',
      cheapestEver: body?.cheapestPriceEver
        ? { price: Number(body.cheapestPriceEver.price), at: body.cheapestPriceEver.date * 1000 }
        : null,
      deals: (body?.deals || [])
        .map((d) => ({
          storeId: d.storeID,
          store: byId.get(d.storeID) || d.storeID,
          price: Number(d.price),
          retail: Number(d.retailPrice),
          savings: Math.round(Number(d.savings)),
          dealId: d.dealID,
          url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
        }))
        .sort((a, b) => a.price - b.price),
    };
  }

  /** The start-page feed: current highlights across storefronts. */
  async feed({ limit = 12, maxPrice } = {}, fetchImpl = fetch) {
    if (!this.features.enabled('deals')) return { deals: [] };

    const params = new URLSearchParams({
      pageSize: String(limit),
      sortBy: 'Savings',
      onSale: '1',
      AAA: '1',                        // filter out the endless asset-flip noise
    });
    if (maxPrice) params.set('upperPrice', String(maxPrice));

    const body = await this._get(`${API}/deals?${params}`, fetchImpl);
    const stores = await this.stores(fetchImpl).catch(() => []);
    const byId = new Map(stores.map((s) => [s.id, s.name]));

    return {
      deals: (body || []).map((d) => ({
        title: d.title,
        thumbnail: d.thumb,
        price: Number(d.salePrice),
        retail: Number(d.normalPrice),
        savings: Math.round(Number(d.savings)),
        store: byId.get(d.storeID) || d.storeID,
        url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
        rating: d.steamRatingPercent ? Number(d.steamRatingPercent) : null,
      })),
      fetchedAt: Date.now(),
    };
  }

  // -- wishlist ----------------------------------------------------------

  watch({ gameId, title, targetPrice }) {
    if (!this.features.enabled('deals')) throw new Error('the deals tracker is off');
    if (!gameId) throw new Error('a watch needs a game');

    const watched = this.store.data.watched.filter((w) => w.gameId !== gameId);
    watched.push({
      id: `watch-${gameId}`,
      gameId,
      title,
      targetPrice: targetPrice != null ? Number(targetPrice) : null,
      lastPrice: null,
      addedAt: Date.now(),
    });
    this.store.data.watched = watched;
    this.store.save();
    this._ensureTimer();
    this.emit('changed', this.watchlist());
    return this.watchlist();
  }

  unwatch(gameId) {
    this.store.data.watched = this.store.data.watched.filter((w) => w.gameId !== gameId);
    this.store.save();
    this.emit('changed', this.watchlist());
    return this.watchlist();
  }

  watchlist() {
    return {
      watched: this.store.data.watched,
      currency: this.settings.get('gaming.dealsCurrency') || 'USD',
      // CheapShark quotes USD only. Saying so beats rendering a £ in front
      // of a dollar figure.
      currencyNote: 'Prices are quoted in USD by the aggregator.',
    };
  }

  /**
   * Re-price everything on the watchlist.
   *
   * Serial rather than parallel, with the cache in front: twenty simultaneous
   * requests to a free community API is exactly the behaviour that gets a
   * user-agent blocked for everyone.
   */
  async refresh(fetchImpl = fetch) {
    if (!this.features.enabled('deals')) return this.watchlist();

    const hits = [];
    for (const entry of this.store.data.watched) {
      let offers;
      try {
        // eslint-disable-next-line no-await-in-loop
        offers = await this.offers(entry.gameId, fetchImpl);
      } catch (err) {
        log.debug(`refresh failed for ${entry.title}: ${err.message}`);
        continue;
      }

      const best = offers.deals[0];
      if (!best) continue;

      const previous = entry.lastPrice;
      entry.lastPrice = best.price;
      entry.lastStore = best.store;
      entry.lastUrl = best.url;
      entry.checkedAt = Date.now();

      const hitTarget = entry.targetPrice != null && best.price <= entry.targetPrice;
      const dropped = previous != null && best.price < previous;

      // Notify once per price level, not once per poll: a game sitting at
      // its target for a week should not produce 168 notifications.
      if (hitTarget && entry.notifiedAtPrice !== best.price) {
        entry.notifiedAtPrice = best.price;
        hits.push({ ...entry, reason: 'target', price: best.price, store: best.store, url: best.url });
      } else if (dropped) {
        hits.push({ ...entry, reason: 'drop', price: best.price, was: previous, store: best.store, url: best.url });
      }
    }

    this.store.save();
    if (hits.length) this.emit('hits', hits);
    this.emit('changed', this.watchlist());
    return { ...this.watchlist(), hits };
  }

  start() {
    if (!this.features.enabled('deals')) return;
    this._ensureTimer();
    this.refresh().catch((err) => log.debug(`initial refresh: ${err.message}`));
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.refresh().catch((err) => log.debug(`refresh: ${err.message}`));
    }, REFRESH_MS);
    this._timer.unref?.();
  }

  async _get(url, fetchImpl) {
    const cached = this._cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;

    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Shaurya-Browser' },
    });
    if (!response.ok) throw new Error(`CheapShark returned ${response.status}`);
    const body = await response.json();

    this._cache.set(url, { at: Date.now(), body });
    return body;
  }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._cache.clear();
  }
}

module.exports = { DealsService, API };
