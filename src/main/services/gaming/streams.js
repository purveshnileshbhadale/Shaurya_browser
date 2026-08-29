'use strict';
/**
 * Always-on-top stream player and streaming layouts (spec §4).
 *
 * The mini player is a real `BaseWindow` with `alwaysOnTop` set, not a
 * floating div: a div lives inside the browser window and disappears the
 * moment the user alt-tabs to their game, which is precisely when they
 * wanted to keep watching. `setAlwaysOnTop(true, 'screen-saver')` is the
 * level that stays above a borderless-fullscreen game on Windows and above
 * Spaces on macOS.
 *
 * Embeds are used rather than scraping stream manifests. Twitch and YouTube
 * both publish documented iframe players; pulling the HLS manifest directly
 * would break their terms, break on every player change, and strip the
 * creator's ad revenue.
 */
const EventEmitter = require('node:events');
const { BaseWindow, WebContentsView, screen } = require('electron');

const { createLogger } = require('../../util/logger');

const log = createLogger('streams');

/**
 * Layout presets.
 *
 * Sizes are fractions of the work area rather than pixels, so a preset
 * behaves the same on a 1080p laptop and a 4K monitor.
 */
const LAYOUTS = [
  {
    id: 'solo', name: 'Solo', description: 'Just the stream, bottom-right.',
    player: { w: 0.24, h: 0.135, x: 0.75, y: 0.83 }, chat: null,
  },
  {
    id: 'chat', name: 'Stream + chat', description: 'Player with chat docked beside it.',
    player: { w: 0.24, h: 0.135, x: 0.60, y: 0.83 }, chat: { w: 0.14, h: 0.4, x: 0.85, y: 0.55 },
  },
  {
    id: 'webcam', name: 'Webcam corner', description: 'Small player, top-left, out of the HUD.',
    player: { w: 0.16, h: 0.09, x: 0.02, y: 0.04 }, chat: null,
  },
  {
    id: 'full', name: 'Second screen', description: 'Large player for a spare monitor.',
    player: { w: 0.5, h: 0.28, x: 0.25, y: 0.36 }, chat: { w: 0.2, h: 0.5, x: 0.78, y: 0.25 },
  },
];

class StreamService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;

    /** @type {BaseWindow|null} */
    this.window = null;
    this.chatWindow = null;
    this.current = null;
  }

  layouts() {
    return LAYOUTS;
  }

  saved() {
    return this.settings.get('gaming.streams') || [];
  }

  add({ platform, channel, label }) {
    if (!platform || !channel) throw new Error('a stream needs a platform and a channel');
    const streams = this.saved().filter(
      (s) => !(s.platform === platform && s.channel === channel),
    );
    streams.push({ platform, channel, label: label || channel, addedAt: Date.now() });
    this.settings.set('gaming.streams', streams);
    this.emit('changed', this.state());
    return this.state();
  }

  remove({ platform, channel }) {
    this.settings.set('gaming.streams', this.saved().filter(
      (s) => !(s.platform === platform && s.channel === channel),
    ));
    this.emit('changed', this.state());
    return this.state();
  }

  /**
   * Build the embed URL.
   *
   * Twitch requires a `parent` parameter naming the embedding host or it
   * refuses to play. Electron pages served from a custom scheme have no host
   * Twitch will accept, so the player is loaded from `https://player.twitch.tv`
   * directly as a top-level document, where no parent is needed.
   */
  embedUrl({ platform, channel }) {
    if (platform === 'twitch') {
      return `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}`
        + '&parent=player.twitch.tv&muted=false';
    }
    if (platform === 'youtube') {
      // A channel handle needs the live redirect; a bare video id does not.
      return channel.startsWith('@') || channel.startsWith('UC')
        ? `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channel)}&autoplay=1`
        : `https://www.youtube.com/embed/${encodeURIComponent(channel)}?autoplay=1`;
    }
    if (platform === 'kick') return `https://player.kick.com/${encodeURIComponent(channel)}`;
    throw new Error(`unsupported platform "${platform}"`);
  }

  chatUrl({ platform, channel }) {
    if (platform === 'twitch') {
      return `https://www.twitch.tv/embed/${encodeURIComponent(channel)}/chat?parent=twitch.tv&darkpopout`;
    }
    if (platform === 'youtube') {
      return `https://www.youtube.com/live_chat?v=${encodeURIComponent(channel)}`;
    }
    return null;
  }

  /**
   * Open (or retarget) the mini player.
   *
   * Retargeting an existing window rather than creating a new one keeps the
   * user's manual size and position: someone who dragged the player exactly
   * where it does not cover their minimap should not lose that by switching
   * channel.
   */
  open({ platform, channel, layout } = {}) {
    if (!this.features.enabled('streamPlayer')) throw new Error('the stream player is off');

    const url = this.embedUrl({ platform, channel });
    const preset = LAYOUTS.find((l) => l.id === (layout || this.settings.get('gaming.streamLayout')))
      || LAYOUTS[0];

    if (this.window && !this.window.isDestroyed()) {
      this.view.webContents.loadURL(url);
      this.current = { platform, channel, layout: preset.id };
      this.emit('changed', this.state());
      return this.state();
    }

    const area = screen.getPrimaryDisplay().workArea;
    const bounds = fractionToBounds(preset.player, area);

    this.window = new BaseWindow({
      ...bounds,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#000000',
      minWidth: 240,
      minHeight: 135,
      title: `${channel} — Shaurya`,
    });
    // 'screen-saver' is the only level that reliably stays above a
    // borderless-fullscreen game on Windows.
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });

    this.window.on('resize', () => {
      const [w, h] = this.window.getContentSize();
      this.view.setBounds({ x: 0, y: 0, width: w, height: h });
    });
    this.window.on('closed', () => {
      this.window = null;
      this.view = null;
      this.current = null;
      this.emit('changed', this.state());
    });

    this.view.webContents.loadURL(url);
    this.current = { platform, channel, layout: preset.id };

    if (preset.chat) this._openChat({ platform, channel }, preset, area);

    log.info(`mini player opened: ${platform}/${channel} (${preset.id})`);
    this.emit('changed', this.state());
    return this.state();
  }

  _openChat(target, preset, area) {
    const url = this.chatUrl(target);
    if (!url) return;

    const bounds = fractionToBounds(preset.chat, area);
    this.chatWindow = new BaseWindow({
      ...bounds, frame: false, alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#18181b', title: 'Chat — Shaurya',
    });
    this.chatWindow.setAlwaysOnTop(true, 'screen-saver');

    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.chatWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    this.chatWindow.on('resize', () => {
      const [w, h] = this.chatWindow.getContentSize();
      view.setBounds({ x: 0, y: 0, width: w, height: h });
    });
    this.chatWindow.on('closed', () => { this.chatWindow = null; });
    view.webContents.loadURL(url);
  }

  applyLayout(layoutId) {
    const preset = LAYOUTS.find((l) => l.id === layoutId);
    if (!preset) throw new Error(`unknown layout "${layoutId}"`);
    this.settings.set('gaming.streamLayout', layoutId);

    if (this.window && !this.window.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      this.window.setBounds(fractionToBounds(preset.player, area));
      if (this.chatWindow && !this.chatWindow.isDestroyed()) {
        if (preset.chat) this.chatWindow.setBounds(fractionToBounds(preset.chat, area));
        else this.chatWindow.close();
      } else if (preset.chat && this.current) {
        this._openChat(this.current, preset, area);
      }
    }

    this.emit('changed', this.state());
    return this.state();
  }

  close() {
    if (this.chatWindow && !this.chatWindow.isDestroyed()) this.chatWindow.close();
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
    this.chatWindow = null;
    this.current = null;
    this.emit('changed', this.state());
    return this.state();
  }

  state() {
    return {
      open: Boolean(this.window && !this.window.isDestroyed()),
      current: this.current,
      saved: this.saved(),
      layouts: LAYOUTS,
      activeLayout: this.settings.get('gaming.streamLayout') || 'solo',
    };
  }

  dispose() {
    this.close();
  }
}

/** Fractions of the work area -> integer pixel bounds. */
function fractionToBounds(frac, area) {
  return {
    x: Math.round(area.x + frac.x * area.width),
    y: Math.round(area.y + frac.y * area.height),
    width: Math.round(frac.w * area.width),
    height: Math.round(frac.h * area.height),
  };
}

module.exports = { StreamService, LAYOUTS, fractionToBounds };
