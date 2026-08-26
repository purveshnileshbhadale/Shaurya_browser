'use strict';
/**
 * Hardware overlay, screenshot gallery and gamepad bindings (spec §4).
 *
 * The overlay is a click-through always-on-top window. `setIgnoreMouseEvents`
 * is what makes it usable: without it, a readout sitting over a game would
 * swallow every click that landed on it, which is unusable in exactly the
 * situation it exists for.
 *
 * It cannot be drawn *inside* an exclusive-fullscreen game — that needs a
 * DirectX/Vulkan present hook, which is a driver-level concern no browser can
 * reach. It works over borderless-windowed, which is what most people play
 * in and what every streaming setup requires anyway. The panel says so.
 */
const EventEmitter = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const { BaseWindow, WebContentsView, screen, shell } = require('electron');

const paths = require('../../util/paths');
const { createLogger } = require('../../util/logger');

const log = createLogger('overlay');

const POSITIONS = {
  'top-left': { x: 0.01, y: 0.03 },
  'top-right': { x: 0.99, y: 0.03 },
  'bottom-left': { x: 0.01, y: 0.97 },
  'bottom-right': { x: 0.99, y: 0.97 },
};

/**
 * Default gamepad map, using the W3C Standard Gamepad indices so it is the
 * same on an Xbox pad, a DualSense and a Switch Pro controller.
 */
const DEFAULT_BINDINGS = {
  button0: 'activate',        // A / Cross
  button1: 'back',            // B / Circle
  button2: 'palette',         // X / Square
  button3: 'reload',          // Y / Triangle
  button4: 'tabPrev',         // LB
  button5: 'tabNext',         // RB
  button6: 'zoomOut',         // LT
  button7: 'zoomIn',          // RT
  button8: 'closeTab',        // Back / Share
  button9: 'newTab',          // Start / Options
  button12: 'scrollUp',       // D-pad up
  button13: 'scrollDown',
  button14: 'focusPrev',
  button15: 'focusNext',
  axis1: 'scroll',            // left stick Y
  axis2: 'pointerX',          // right stick X
  axis3: 'pointerY',
};

const COMMANDS = [
  { id: 'activate', name: 'Activate / click' },
  { id: 'back', name: 'Back' },
  { id: 'forward', name: 'Forward' },
  { id: 'reload', name: 'Reload' },
  { id: 'palette', name: 'Command palette' },
  { id: 'tabNext', name: 'Next tab' },
  { id: 'tabPrev', name: 'Previous tab' },
  { id: 'newTab', name: 'New tab' },
  { id: 'closeTab', name: 'Close tab' },
  { id: 'scrollUp', name: 'Scroll up' },
  { id: 'scrollDown', name: 'Scroll down' },
  { id: 'focusNext', name: 'Focus next link' },
  { id: 'focusPrev', name: 'Focus previous link' },
  { id: 'zoomIn', name: 'Zoom in' },
  { id: 'zoomOut', name: 'Zoom out' },
  { id: 'turbo', name: 'Toggle Turbo' },
  { id: 'clip', name: 'Save clip' },
  { id: 'none', name: '— unbound —' },
];

class OverlayService extends EventEmitter {
  constructor({ settings, features, performance }) {
    super();
    this.settings = settings;
    this.features = features;
    this.performance = performance;

    this.window = null;
    this.view = null;
    this._unsubscribe = null;
  }

  // == Hardware overlay ==================================================

  config() {
    return this.settings.get('gaming.overlay');
  }

  show() {
    if (!this.features.enabled('hardwareOverlay')) throw new Error('the overlay is off');
    if (this.window && !this.window.isDestroyed()) return this.state();

    const area = screen.getPrimaryDisplay().workArea;
    const cfg = this.config();
    const width = Math.round(230 * (cfg.scale || 1));
    const height = Math.round(112 * (cfg.scale || 1));
    const anchor = POSITIONS[cfg.position] || POSITIONS['top-right'];

    this.window = new BaseWindow({
      width,
      height,
      x: Math.round(area.x + anchor.x * area.width - (anchor.x > 0.5 ? width + 12 : -12)),
      y: Math.round(area.y + anchor.y * area.height - (anchor.y > 0.5 ? height + 12 : -12)),
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,          // must never steal focus from the game
      skipTaskbar: true,
      hasShadow: false,
    });

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through: the whole point of an overlay is that it is not in the way.
    this.window.setIgnoreMouseEvents(true, { forward: true });

    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../../../preload/overlay.js'),
        sandbox: false,
        contextIsolation: true,
      },
    });
    this.window.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width, height });
    this.view.setBackgroundColor('#00000000');
    this.view.webContents.loadURL('aether://hud');

    // Feed it real numbers from the performance sampler.
    this.performance.start();
    const onMetrics = (metrics) => {
      if (!this.view || this.view.webContents.isDestroyed()) return;
      this.view.webContents.send('hud:metrics', {
        ...metrics,
        show: this.config().metrics,
        opacity: this.config().opacity,
      });
    };
    this.performance.on('metrics', onMetrics);
    this._unsubscribe = () => this.performance.off('metrics', onMetrics);

    this.window.on('closed', () => {
      this._unsubscribe?.();
      this._unsubscribe = null;
      this.window = null;
      this.view = null;
      this.emit('changed', this.state());
    });

    log.info('hardware overlay shown');
    this.emit('changed', this.state());
    return this.state();
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
    this.view = null;
    this.emit('changed', this.state());
    return this.state();
  }

  toggle() {
    return this.window ? this.hide() : this.show();
  }

  update(patch) {
    const cfg = { ...this.config(), ...patch };
    this.settings.set('gaming.overlay', cfg);
    if (this.window) { this.hide(); this.show(); }
    return this.state();
  }

  state() {
    return {
      visible: Boolean(this.window && !this.window.isDestroyed()),
      config: this.config(),
      positions: Object.keys(POSITIONS),
      note: 'Draws over borderless-windowed games. Exclusive fullscreen needs a '
        + 'graphics-API hook, which is outside what a browser can do.',
    };
  }

  // == Gamepad bindings ==================================================

  bindings() {
    const stored = this.settings.get('gaming.gamepadBindings') || {};
    return {
      bindings: { ...DEFAULT_BINDINGS, ...stored },
      defaults: DEFAULT_BINDINGS,
      commands: COMMANDS,
      customised: Object.keys(stored).length,
    };
  }

  bind(input, command) {
    if (!COMMANDS.some((c) => c.id === command)) throw new Error(`unknown command "${command}"`);
    const stored = { ...(this.settings.get('gaming.gamepadBindings') || {}) };
    if (command === 'none') delete stored[input];
    else stored[input] = command;
    this.settings.set('gaming.gamepadBindings', stored);
    this.emit('bindings', this.bindings());
    return this.bindings();
  }

  resetBindings() {
    this.settings.set('gaming.gamepadBindings', {});
    this.emit('bindings', this.bindings());
    return this.bindings();
  }

  dispose() {
    this.hide();
  }
}

// ===========================================================================
// Screenshot gallery
// ===========================================================================

/**
 * Captures and clips, organised by the game they came from.
 *
 * "By game" is inferred from the window title at capture time, which is the
 * only signal available without a platform integration — and it is a good
 * one, because game windows are named after the game. Files are grouped
 * under a folder per title, so the organisation survives outside Aether too.
 */
class GalleryService extends EventEmitter {
  constructor({ settings, features }) {
    super();
    this.settings = settings;
    this.features = features;
  }

  async root() {
    const dir = this.settings.get('gaming.recorder.directory')
      || paths.userDataDir('captures');
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Sanitise a window title into a folder name. */
  static folderFor(title) {
    const clean = String(title || 'Unsorted')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return clean.slice(0, 60) || 'Unsorted';
  }

  async list() {
    if (!this.features.enabled('shotGallery')) throw new Error('the gallery is off');

    const root = await this.root();
    const groups = [];

    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return { groups: [] }; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      // eslint-disable-next-line no-await-in-loop
      const files = await fs.readdir(dir).catch(() => []);

      const items = [];
      for (const file of files) {
        if (!/\.(png|jpe?g|webm|mp4)$/i.test(file)) continue;
        // eslint-disable-next-line no-await-in-loop
        const stat = await fs.stat(path.join(dir, file)).catch(() => null);
        if (!stat) continue;
        items.push({
          name: file,
          path: path.join(dir, file),
          bytes: stat.size,
          at: stat.mtimeMs,
          kind: /\.(webm|mp4)$/i.test(file) ? 'video' : 'image',
        });
      }
      if (items.length) {
        items.sort((a, b) => b.at - a.at);
        groups.push({ game: entry.name, items, count: items.length });
      }
    }

    groups.sort((a, b) => (b.items[0]?.at || 0) - (a.items[0]?.at || 0));
    return { groups, root };
  }

  /** File a capture under its game folder. */
  async file(sourcePath, windowTitle) {
    const root = await this.root();
    const folder = path.join(root, GalleryService.folderFor(windowTitle));
    await fs.mkdir(folder, { recursive: true });

    const target = path.join(folder, path.basename(sourcePath));
    await fs.rename(sourcePath, target).catch(async () => {
      // Cross-device rename fails; fall back to copy-then-remove.
      await fs.copyFile(sourcePath, target);
      await fs.unlink(sourcePath).catch(() => {});
    });

    this.emit('changed');
    return { path: target, game: GalleryService.folderFor(windowTitle) };
  }

  async remove(filePath) {
    const root = await this.root();
    // Never delete outside the gallery root, whatever the renderer sends.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(root))) {
      throw new Error('refusing to delete a file outside the gallery');
    }
    await fs.unlink(resolved);
    this.emit('changed');
    return { removed: resolved };
  }

  async reveal(filePath) {
    shell.showItemInFolder(filePath);
    return { revealed: filePath };
  }
}

module.exports = {
  OverlayService, GalleryService, DEFAULT_BINDINGS, COMMANDS, POSITIONS,
};
