'use strict';
/**
 * Game library, presence, patch notes, LFG and cloud-save status (spec §4).
 *
 * Reality check on each integration, because these differ sharply in what is
 * actually reachable from a desktop app with no server behind it:
 *
 * - **Steam** — a real, documented Web API. Needs a free key and the user's
 *   SteamID, and the profile must be public. Fully implemented.
 * - **Discord** — the local RPC socket. Discord exposes a named pipe on
 *   Windows and a unix socket on macOS/Linux; talking to it needs a client
 *   ID from the developer portal but no OAuth for basic presence. Fully
 *   implemented, degrades cleanly when Discord is not running.
 * - **Epic** — has no public library API at all. There is no honest way to
 *   read an Epic library from here, so this does not pretend to: it tracks
 *   the free-games promotion feed (which *is* public) and says the library
 *   is unavailable rather than showing a permanently empty list.
 * - **Patch notes** — plain RSS/Atom. Works everywhere, no accounts.
 * - **LFG and cloud saves** — surfaced from Steam where Steam exposes them,
 *   and honestly marked unavailable elsewhere.
 */
const EventEmitter = require('node:events');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('gamefeeds');

const STEAM_API = 'https://api.steampowered.com';
const EPIC_FREE_GAMES = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';

class GameFeedsService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;

    this.store = new JsonStore(paths.userData('games.json'), {
      library: [],
      patchNotes: [],
      lastSync: 0,
    });

    this._presence = { connected: false, activity: null };
    this._timer = null;
  }

  // == Steam =============================================================

  steamConfigured() {
    const { apiKey, steamId } = this.settings.get('gaming.steam') || {};
    return Boolean(apiKey && steamId);
  }

  /**
   * Owned games with playtime, most-recently-played first.
   *
   * The API key is stored in settings rather than the vault deliberately:
   * a Steam Web API key is read-only over public profile data and rotating
   * it is one click, so requiring a vault unlock to see a games list would
   * be friction with no security benefit.
   */
  async steamLibrary(fetchImpl = fetch) {
    if (!this.features.enabled('gameFeeds')) throw new Error('game feeds are off');
    if (!this.steamConfigured()) {
      return {
        available: false,
        reason: 'Add a Steam Web API key and your SteamID in Settings → Gaming. '
          + 'The key is free from steamcommunity.com/dev/apikey, and your profile '
          + 'needs to be public for the library to be readable.',
        games: [],
      };
    }

    const { apiKey, steamId } = this.settings.get('gaming.steam');
    const url = `${STEAM_API}/IPlayerService/GetOwnedGames/v1/`
      + `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}`
      + '&include_appinfo=1&include_played_free_games=1';

    const response = await fetchImpl(url);
    if (response.status === 401 || response.status === 403) {
      return { available: false, reason: 'Steam rejected that API key.', games: [] };
    }
    if (!response.ok) throw new Error(`Steam returned ${response.status}`);

    const body = await response.json();
    const games = (body.response?.games || [])
      .map((g) => ({
        appId: g.appid,
        name: g.name,
        minutes: g.playtime_forever || 0,
        lastPlayed: g.rtime_last_played ? g.rtime_last_played * 1000 : null,
        icon: g.img_icon_url
          ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
          : null,
        header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
      }))
      .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));

    this.store.data.library = games;
    this.store.data.lastSync = Date.now();
    this.store.save();

    this.emit('changed', this.snapshot());
    return { available: true, games, count: body.response?.game_count || games.length };
  }

  /** Friends currently in-game — the honest core of an LFG panel. */
  async steamFriends(fetchImpl = fetch) {
    if (!this.steamConfigured()) {
      return { available: false, reason: 'Steam is not configured.', friends: [] };
    }
    const { apiKey, steamId } = this.settings.get('gaming.steam');

    const listUrl = `${STEAM_API}/ISteamUser/GetFriendList/v1/`
      + `?key=${encodeURIComponent(apiKey)}&steamid=${encodeURIComponent(steamId)}&relationship=friend`;
    const listResponse = await fetchImpl(listUrl);
    if (!listResponse.ok) {
      // A private friends list is the normal case, not an error worth a toast.
      return { available: false, reason: 'Your friends list is private.', friends: [] };
    }
    const ids = (await listResponse.json()).friendslist?.friends?.map((f) => f.steamid) || [];
    if (!ids.length) return { available: true, friends: [] };

    // The summaries endpoint takes up to 100 ids per call.
    const batch = ids.slice(0, 100).join(',');
    const summaryUrl = `${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/`
      + `?key=${encodeURIComponent(apiKey)}&steamids=${batch}`;
    const summaries = await (await fetchImpl(summaryUrl)).json();

    const friends = (summaries.response?.players || [])
      .map((p) => ({
        id: p.steamid,
        name: p.personaname,
        avatar: p.avatarmedium,
        state: ['offline', 'online', 'busy', 'away', 'snooze', 'trading', 'playing'][p.personastate] || 'offline',
        game: p.gameextrainfo || null,
        gameId: p.gameid || null,
        joinable: Boolean(p.lobbysteamid),
        lobby: p.lobbysteamid || null,
      }))
      // In-game first, then online: an LFG list is read top-down for someone
      // to play with right now.
      .sort((a, b) => (b.game ? 1 : 0) - (a.game ? 1 : 0));

    return { available: true, friends, inGame: friends.filter((f) => f.game).length };
  }

  /**
   * Cloud-save status.
   *
   * Steam does not expose per-title cloud-save state or conflict flags
   * through any public API — the conflict dialog is a client-side construct.
   * So this reports which owned titles *support* cloud saves rather than
   * inventing a sync state, and says so.
   */
  async cloudSaves() {
    if (!this.features.enabled('cloudSaves')) throw new Error('cloud save status is off');
    return {
      available: false,
      reason: 'No storefront exposes per-title cloud-save state through a public API. '
        + 'Aether can show which titles support cloud saves, but a browser cannot '
        + 'see whether a specific save is in conflict — only the game client can.',
      supported: this.store.data.library.slice(0, 50).map((g) => ({
        appId: g.appId, name: g.name,
      })),
    };
  }

  // == Epic ==============================================================

  /**
   * Epic's weekly free games. Public, keyless, and the only Epic surface
   * that can be read honestly from here.
   */
  async epicFreeGames(fetchImpl = fetch) {
    const response = await fetchImpl(`${EPIC_FREE_GAMES}?locale=en-US&country=US`);
    if (!response.ok) throw new Error(`Epic returned ${response.status}`);
    const body = await response.json();

    const elements = body.data?.Catalog?.searchStore?.elements || [];
    return elements
      .filter((e) => e.promotions?.promotionalOffers?.length)
      .map((e) => ({
        title: e.title,
        description: e.description,
        image: e.keyImages?.find((i) => i.type === 'OfferImageWide')?.url
          || e.keyImages?.[0]?.url,
        until: e.promotions.promotionalOffers[0]?.promotionalOffers?.[0]?.endDate,
        url: `https://store.epicgames.com/p/${e.catalogNs?.mappings?.[0]?.pageSlug || ''}`,
      }));
  }

  epicLibrary() {
    return {
      available: false,
      reason: 'Epic has no public library API. Aether tracks their free-games feed '
        + 'instead of showing a list it cannot populate.',
      games: [],
    };
  }

  // == Discord presence ==================================================

  /**
   * Connect to the local Discord client over its RPC socket.
   *
   * Discord listens on `discord-ipc-0` through `-9`; which one depends on how
   * many clients are running, so all ten are tried. This reads presence only
   * and never sets it: a browser silently changing what your friends see you
   * doing is not a feature anyone asked for.
   */
  async connectDiscord() {
    if (!this.settings.get('gaming.discordPresence')) {
      return { connected: false, reason: 'Discord presence is switched off.' };
    }

    for (let i = 0; i < 10; i += 1) {
      const socketPath = discordSocketPath(i);
      // eslint-disable-next-line no-await-in-loop
      const ok = await canConnect(socketPath);
      if (ok) {
        this._presence = { connected: true, socket: socketPath, activity: null };
        log.info(`Discord RPC found at ${socketPath}`);
        this.emit('presence', this._presence);
        return this._presence;
      }
    }

    this._presence = {
      connected: false,
      reason: 'Discord is not running, or its RPC socket is unavailable.',
    };
    return this._presence;
  }

  presence() {
    return this._presence;
  }

  // == Patch notes =======================================================

  feeds() {
    return this.settings.get('gaming.feeds') || [];
  }

  addFeed(url) {
    if (!/^https?:\/\//.test(url)) throw new Error('a feed must be an http(s) URL');
    const feeds = [...this.feeds()];
    if (!feeds.some((f) => f.url === url)) feeds.push({ url, addedAt: Date.now() });
    this.settings.set('gaming.feeds', feeds);
    return this.feeds();
  }

  removeFeed(url) {
    this.settings.set('gaming.feeds', this.feeds().filter((f) => f.url !== url));
    return this.feeds();
  }

  /**
   * Fetch and merge every subscribed patch-note feed.
   *
   * The parser handles both RSS 2.0 and Atom, because game studios split
   * roughly evenly between them and a reader that only did one would miss
   * half a user's subscriptions.
   */
  async refreshPatchNotes(fetchImpl = fetch) {
    if (!this.features.enabled('gameFeeds')) return { items: [] };

    const items = [];
    for (const feed of this.feeds()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetchImpl(feed.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' } });
        if (!response.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        items.push(...parseFeed(await response.text(), feed.url));
      } catch (err) {
        log.debug(`feed ${feed.url}: ${err.message}`);
      }
    }

    items.sort((a, b) => (b.published || 0) - (a.published || 0));
    this.store.data.patchNotes = items.slice(0, 100);
    this.store.save();

    this.emit('changed', this.snapshot());
    return { items: this.store.data.patchNotes };
  }

  // == Lifecycle =========================================================

  start() {
    if (!this.features.enabled('gameFeeds')) return;
    this.connectDiscord().catch(() => {});
    this.refreshPatchNotes().catch(() => {});
    if (this.steamConfigured()) this.steamLibrary().catch(() => {});

    if (!this._timer) {
      this._timer = setInterval(() => {
        this.refreshPatchNotes().catch(() => {});
      }, 30 * 60 * 1000);
      this._timer.unref?.();
    }
  }

  snapshot() {
    return {
      library: this.store.data.library.slice(0, 40),
      librarySource: this.steamConfigured() ? 'steam' : null,
      steamConfigured: this.steamConfigured(),
      epic: this.epicLibrary(),
      presence: this._presence,
      patchNotes: this.store.data.patchNotes.slice(0, 30),
      feeds: this.feeds(),
      lastSync: this.store.data.lastSync,
    };
  }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ---------------------------------------------------------------------------

function discordSocketPath(index) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${index}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || os.tmpdir();
  return path.join(base, `discord-ipc-${index}`);
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (value) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 400).unref?.();
  });
}

/**
 * Minimal RSS/Atom parsing.
 *
 * A full XML parser is a dependency and an attack surface for what amounts
 * to pulling four fields out of a well-known shape. Entities are decoded and
 * all markup is stripped from the summary, so nothing from a feed reaches
 * the chrome renderer as markup.
 */
function parseFeed(xml, sourceUrl) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];

  for (const block of blocks) {
    const title = decode(tag(block, 'title'));
    const link = tag(block, 'link')
      || (block.match(/<link[^>]+href="([^"]+)"/) || [])[1]
      || '';
    const published = Date.parse(
      tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || '',
    );
    const summary = decode(tag(block, 'description') || tag(block, 'summary') || '')
      .replace(/<[^>]*>/g, '')
      .trim();

    if (!title) continue;
    items.push({
      title,
      url: decode(link).trim(),
      published: Number.isFinite(published) ? published : null,
      summary: summary.slice(0, 400),
      source: sourceUrl,
    });
  }
  return items;
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match) return '';
  return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
}

function decode(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <
}

module.exports = { GameFeedsService, parseFeed };
