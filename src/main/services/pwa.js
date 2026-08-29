'use strict';
/**
 * Progressive Web App install and app-window mode (spec §5).
 *
 * Installing a PWA in Shaurya means three things: remembering the site as an
 * app, giving it a window without browser chrome, and registering it with
 * the OS so it appears in the launcher/dock like any other application.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, nativeImage, shell } = require('electron');
const { JsonStore } = require('../util/json-store');
const paths = require('../util/paths');
const { uid } = require('../util/id');
const { request } = require('../util/net');
const { createLogger } = require('../util/logger');

const log = createLogger('pwa');

class PwaService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    this.store = new JsonStore(paths.userData('pwa.json'), { apps: [] });
    /** tabId -> manifest discovered on that page */
    this._candidates = new Map();
  }

  /**
   * Read a page's web app manifest, if it declares one.
   * @returns {Promise<object|null>}
   */
  async detect(tab) {
    if (!this.features.enabled('pwa')) return null;
    if (!tab?.webContents || !/^https:/.test(tab.url || '')) return null;

    try {
      const href = await tab.webContents.executeJavaScript(
        `(() => { const l = document.querySelector('link[rel="manifest"]');
                  return l ? l.href : null; })()`,
        true
      );
      if (!href) {
        this._candidates.delete(tab.id);
        return null;
      }

      const res = await request(href, { timeout: 8000, limit: 512 * 1024 });
      if (res.status !== 200) return null;
      const manifest = JSON.parse(res.body.toString('utf8'));

      const candidate = {
        tabId: tab.id,
        manifestUrl: href,
        name: manifest.name || manifest.short_name || tab.title,
        shortName: manifest.short_name || manifest.name || tab.title,
        startUrl: new URL(manifest.start_url || tab.url, href).toString(),
        scope: manifest.scope ? new URL(manifest.scope, href).toString() : null,
        display: manifest.display || 'standalone',
        themeColor: manifest.theme_color || null,
        backgroundColor: manifest.background_color || null,
        icons: (manifest.icons || []).map((i) => ({
          src: new URL(i.src, href).toString(),
          sizes: i.sizes,
          type: i.type,
        })),
        origin: new URL(tab.url).origin,
      };
      this._candidates.set(tab.id, candidate);
      this.emit('installable', candidate);
      return candidate;
    } catch (err) {
      log.debug(`manifest detection failed for ${tab.url}: ${err.message}`);
      return null;
    }
  }

  /** Is the current tab installable, and is it already installed? */
  installable(tab) {
    const candidate = this._candidates.get(tab?.id);
    if (!candidate) return { installable: false, installed: false };
    const installed = this.store.data.apps.some((a) => a.startUrl === candidate.startUrl);
    return { installable: !installed, installed, candidate };
  }

  /** Install the detected app for a tab. */
  async install(tab) {
    if (!this.features.enabled('pwa')) {
      throw new Error('PWA install is turned off in the Feature Store');
    }
    const candidate = this._candidates.get(tab?.id) || await this.detect(tab);
    if (!candidate) throw new Error('this page does not declare a web app manifest');

    const iconPath = await this._cacheIcon(candidate);
    const record = {
      id: uid('pwa_'),
      name: candidate.name,
      shortName: candidate.shortName,
      startUrl: candidate.startUrl,
      scope: candidate.scope,
      display: candidate.display,
      themeColor: candidate.themeColor,
      icon: iconPath,
      origin: candidate.origin,
      installedAt: Date.now(),
    };
    this.store.data.apps.push(record);
    this.store.save();

    await this._registerWithOs(record).catch((err) =>
      log.warn(`OS registration skipped: ${err.message}`));

    this.emit('changed', this.list());
    log.info(`installed PWA "${record.name}"`);
    return record;
  }

  async _cacheIcon(candidate) {
    // Prefer a 192px+ PNG, which is what desktop launchers want.
    const sorted = candidate.icons
      .map((i) => ({ ...i, size: Math.max(...String(i.sizes || '0').split(/[x\s]/).map(Number).filter(Number.isFinite), 0) }))
      .sort((a, b) => b.size - a.size);
    const best = sorted.find((i) => i.size >= 192) || sorted[0];
    if (!best) return null;

    try {
      const res = await request(best.src, { timeout: 8000, limit: 4 * 1024 * 1024 });
      if (res.status !== 200) return null;
      const dir = paths.userDataDir('pwa-icons');
      const file = path.join(dir, `${Buffer.from(candidate.startUrl).toString('base64url').slice(0, 40)}.png`);
      const image = nativeImage.createFromBuffer(res.body);
      if (image.isEmpty()) return null;
      await fs.writeFile(file, image.toPNG());
      return file;
    } catch (err) {
      log.debug(`icon cache failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Put the app where the OS expects to find it.
   *
   * Linux gets a .desktop entry; macOS and Windows would need a bundle or
   * shortcut, which requires packaging steps outside a dev checkout, so we
   * record the intent and let the packaged build finish the job.
   */
  async _registerWithOs(record) {
    if (process.platform !== 'linux') {
      log.debug(`OS shortcut for ${record.name} is created by the packaged installer`);
      return;
    }
    const dir = path.join(app.getPath('home'), '.local', 'share', 'applications');
    await fs.mkdir(dir, { recursive: true });
    const exec = process.execPath;
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${record.name}`,
      `Exec="${exec}" --app="${record.startUrl}"`,
      record.icon ? `Icon=${record.icon}` : '',
      'Terminal=false',
      'Categories=Network;WebBrowser;',
      `StartupWMClass=shaurya-${record.id}`,
    ].filter(Boolean).join('\n');
    await fs.writeFile(path.join(dir, `shaurya-${record.id}.desktop`), entry + '\n');
  }

  list() {
    return this.store.data.apps.map((a) => ({ ...a }));
  }

  get(id) {
    return this.store.data.apps.find((a) => a.id === id) || null;
  }

  async uninstall(id) {
    const idx = this.store.data.apps.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    const [record] = this.store.data.apps.splice(idx, 1);
    this.store.save();

    if (process.platform === 'linux') {
      const file = path.join(app.getPath('home'), '.local', 'share', 'applications', `shaurya-${id}.desktop`);
      await fs.rm(file, { force: true }).catch(() => {});
    }
    if (record.icon) await fs.rm(record.icon, { force: true }).catch(() => {});

    this.emit('changed', this.list());
    return true;
  }

  /** Does a URL belong inside an installed app's scope? */
  appForUrl(url) {
    return this.store.data.apps.find((a) => {
      if (!a.scope) return url.startsWith(new URL(a.startUrl).origin);
      return url.startsWith(a.scope);
    }) || null;
  }

  forget(tabId) {
    this._candidates.delete(tabId);
  }
}

module.exports = { PwaService };
