'use strict';
/**
 * Responsive design mode with device presets and network throttling
 * (spec §5).
 *
 * Resizing the view alone is not enough to reproduce a phone: a real device
 * also reports a different user agent, device pixel ratio, touch support and
 * `navigator.maxTouchPoints`. Sites branch on all of those, so this drives
 * Chromium's own device-emulation and network-emulation domains rather than
 * just changing the pane geometry.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../../util/logger');

const log = createLogger('responsive');

/**
 * Built-in presets. Dimensions are CSS pixels, which is what a page sees —
 * not the marketing resolution.
 */
const DEVICES = [
  { id: 'responsive', name: 'Responsive', width: 800, height: 600, dpr: 1, touch: false, mobile: false },

  { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, dpr: 2, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'iphone-15', name: 'iPhone 15', width: 393, height: 852, dpr: 3, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'iphone-15-pro-max', name: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'pixel-8', name: 'Pixel 8', width: 412, height: 915, dpr: 2.625, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { id: 'galaxy-s23', name: 'Galaxy S23', width: 360, height: 780, dpr: 3, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },

  { id: 'ipad-mini', name: 'iPad mini', width: 768, height: 1024, dpr: 2, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { id: 'ipad-pro', name: 'iPad Pro 11"', width: 834, height: 1194, dpr: 2, touch: true, mobile: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },

  { id: 'laptop', name: 'Laptop', width: 1366, height: 768, dpr: 1, touch: false, mobile: false },
  { id: 'laptop-hidpi', name: 'Laptop HiDPI', width: 1440, height: 900, dpr: 2, touch: false, mobile: false },
  { id: 'desktop', name: 'Desktop 1080p', width: 1920, height: 1080, dpr: 1, touch: false, mobile: false },
  { id: 'desktop-4k', name: 'Desktop 4K', width: 2560, height: 1440, dpr: 2, touch: false, mobile: false },
];

/**
 * Network profiles. Latency is round-trip; throughput is bytes/second, which
 * is what the CDP `Network.emulateNetworkConditions` command expects.
 */
const NETWORK_PROFILES = [
  { id: 'none', name: 'No throttling', offline: false, latency: 0, download: -1, upload: -1 },
  { id: 'fast-4g', name: 'Fast 4G', offline: false, latency: 40, download: 9000 * 1024 / 8, upload: 3000 * 1024 / 8 },
  { id: 'slow-4g', name: 'Slow 4G', offline: false, latency: 150, download: 1600 * 1024 / 8, upload: 750 * 1024 / 8 },
  { id: 'fast-3g', name: 'Fast 3G', offline: false, latency: 275, download: 1500 * 1024 / 8, upload: 675 * 1024 / 8 },
  { id: 'slow-3g', name: 'Slow 3G', offline: false, latency: 400, download: 500 * 1024 / 8, upload: 500 * 1024 / 8 },
  { id: '2g', name: 'Regular 2G', offline: false, latency: 800, download: 250 * 1024 / 8, upload: 50 * 1024 / 8 },
  { id: 'offline', name: 'Offline', offline: true, latency: 0, download: 0, upload: 0 },
];

/** CPU slowdown multipliers, which matter as much as bandwidth on mobile. */
const CPU_PROFILES = [
  { id: 'none', name: 'No throttling', rate: 1 },
  { id: '4x', name: '4× slowdown (mid-tier mobile)', rate: 4 },
  { id: '6x', name: '6× slowdown (low-end mobile)', rate: 6 },
  { id: '20x', name: '20× slowdown', rate: 20 },
];

class ResponsiveService extends EventEmitter {
  constructor(settings, features) {
    super();
    this.settings = settings;
    this.features = features;
    /** tabId -> { device, network, cpu } */
    this._active = new Map();
  }

  _check() {
    if (!this.features.enabled('responsiveMode')) {
      throw new Error('Responsive design mode is turned off in the Feature Store');
    }
  }

  devices() {
    const custom = this.settings.get('devtools.responsivePresets') || [];
    return [...DEVICES, ...custom.map((d) => ({ ...d, custom: true }))];
  }

  networkProfiles() {
    return NETWORK_PROFILES;
  }

  cpuProfiles() {
    return CPU_PROFILES;
  }

  addPreset(device) {
    const custom = [...(this.settings.get('devtools.responsivePresets') || [])];
    custom.push({ ...device, id: device.id || `custom-${Date.now()}` });
    this.settings.set('devtools.responsivePresets', custom);
    return this.devices();
  }

  /**
   * Enter responsive mode for a tab.
   *
   * @param {object} tab
   * @param {{deviceId?:string, width?:number, height?:number, dpr?:number,
   *          rotate?:boolean, network?:string, cpu?:string}} opts
   */
  async enable(tab, opts = {}) {
    this._check();
    const wc = tab?.webContents;
    if (!wc) throw new Error('no page');

    const preset = this.devices().find((d) => d.id === opts.deviceId) || DEVICES[0];
    const rotated = Boolean(opts.rotate);
    const device = {
      ...preset,
      width: opts.width || (rotated ? preset.height : preset.width),
      height: opts.height || (rotated ? preset.width : preset.height),
      dpr: opts.dpr || preset.dpr,
      rotated,
    };

    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (err) {
        throw new Error(`could not attach the emulator: ${err.message}`);
      }
    }

    // Device metrics: the geometry, pixel ratio and mobile flag a page reads.
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: Boolean(device.mobile),
      screenWidth: device.width,
      screenHeight: device.height,
    });

    // Touch emulation, including maxTouchPoints — feature detection for
    // touch is the most common branch a responsive site takes.
    await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: Boolean(device.touch),
      maxTouchPoints: device.touch ? 5 : 0,
    });
    await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
      enabled: Boolean(device.touch),
      configuration: device.mobile ? 'mobile' : 'desktop',
    });

    if (device.ua) {
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: device.ua,
        platform: /iPhone|iPad/.test(device.ua) ? 'iPhone' : 'Linux armv8l',
      });
    }

    const network = await this.setNetwork(tab, opts.network || 'none');
    const cpu = await this.setCpu(tab, opts.cpu || 'none');

    this._active.set(tab.id, { device, network, cpu });
    this.emit('changed', { tabId: tab.id, device, network, cpu });
    log.info(`responsive mode: ${device.name} ${device.width}×${device.height} @${device.dpr}x`);
    return { device, network, cpu };
  }

  async setNetwork(tab, profileId) {
    const wc = tab?.webContents;
    const profile = NETWORK_PROFILES.find((p) => p.id === profileId) || NETWORK_PROFILES[0];
    if (!wc?.debugger.isAttached()) return profile;

    await wc.debugger.sendCommand('Network.enable').catch(() => {});
    await wc.debugger.sendCommand('Network.emulateNetworkConditions', {
      offline: profile.offline,
      latency: profile.latency,
      downloadThroughput: profile.download,
      uploadThroughput: profile.upload,
    });

    const state = this._active.get(tab.id);
    if (state) state.network = profile;
    return profile;
  }

  async setCpu(tab, profileId) {
    const wc = tab?.webContents;
    const profile = CPU_PROFILES.find((p) => p.id === profileId) || CPU_PROFILES[0];
    if (!wc?.debugger.isAttached()) return profile;

    await wc.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: profile.rate });

    const state = this._active.get(tab.id);
    if (state) state.cpu = profile;
    return profile;
  }

  /** Leave responsive mode and clear every override. */
  async disable(tab) {
    const wc = tab?.webContents;
    this._active.delete(tab?.id);
    if (!wc?.debugger.isAttached()) return true;

    // Clearing each override individually, and tolerating failures, matters:
    // a half-cleared emulation leaves the page stuck at phone width with no
    // visible reason why.
    for (const [command, params] of [
      ['Emulation.clearDeviceMetricsOverride', {}],
      ['Emulation.setTouchEmulationEnabled', { enabled: false }],
      ['Emulation.setEmitTouchEventsForMouse', { enabled: false }],
      ['Emulation.setUserAgentOverride', { userAgent: '' }],
      ['Emulation.setCPUThrottlingRate', { rate: 1 }],
      ['Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }],
    ]) {
      await wc.debugger.sendCommand(command, params).catch((err) =>
        log.debug(`${command} failed: ${err.message}`));
    }

    try {
      wc.debugger.detach();
    } catch { /* already detached */ }

    this.emit('changed', { tabId: tab.id, device: null });
    return true;
  }

  state(tabId) {
    return this._active.get(tabId) || null;
  }
}

module.exports = { ResponsiveService, DEVICES, NETWORK_PROFILES, CPU_PROFILES };
