'use strict';
/**
 * Screenshot capture: visible area, selected region, and scrolling full-page
 * (spec §2).
 *
 * Full-page capture is the interesting one. Chromium can only rasterise what
 * is composited, so a page taller than the viewport has to be captured in
 * strips. The tricky parts — lazy-loaded images that never load off-screen,
 * sticky headers repeating in every strip, smooth-scroll blurring the seams
 * — are handled by pausing the page's scroll behaviour and neutralising
 * fixed positioning for the duration (see `capture` in the content preload).
 */
const EventEmitter = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage, clipboard, dialog, app } = require('electron');
const { createLogger } = require('../util/logger');

const log = createLogger('screenshot');

/** Let the page settle after each scroll step before rasterising. */
const SETTLE_MS = 120;
/** Guard against pathological infinite-scroll pages. */
const MAX_STRIPS = 40;

class ScreenshotService extends EventEmitter {
  constructor(content, features) {
    super();
    this.content = content;
    this.features = features;
  }

  _check() {
    if (!this.features.enabled('screenshot')) {
      throw new Error('Screenshot capture is turned off in the Feature Store');
    }
  }

  /** Just what is on screen. */
  async visible(tab) {
    this._check();
    const image = await tab.webContents.capturePage();
    return this._result(image, tab);
  }

  /**
   * A user-selected rectangle, in CSS pixels relative to the page viewport.
   * @param {{x:number,y:number,width:number,height:number}} rect
   */
  async region(tab, rect) {
    this._check();
    if (!rect || rect.width < 1 || rect.height < 1) throw new Error('empty selection');
    const image = await tab.webContents.capturePage({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    return this._result(image, tab);
  }

  /**
   * Scrolling capture of the whole document, stitched into one image.
   */
  async fullPage(tab) {
    this._check();
    const wc = tab.webContents;

    const geo = await this.content.command(wc, 'capture.begin');
    if (!geo || !geo.height) throw new Error('could not measure the page');

    try {
      const viewport = geo.viewport;
      const total = Math.min(geo.height, viewport * MAX_STRIPS);
      const steps = Math.ceil(total / viewport);

      /** @type {Array<{image:Electron.NativeImage, y:number}>} */
      const strips = [];

      for (let i = 0; i < steps; i++) {
        const targetY = i * viewport;
        const actualY = await this.content.command(wc, 'capture.scroll', { y: targetY });
        // Give lazy-loaded images and scroll-triggered animations a chance.
        await delay(SETTLE_MS);
        const image = await wc.capturePage();
        strips.push({ image, y: actualY });

        // A page that refuses to scroll further is at its true bottom, even
        // if scrollHeight claimed otherwise (infinite scroll, sticky footer).
        if (i > 0 && actualY === strips[i - 1].y) break;
      }

      const stitched = await this._stitch(strips, geo);
      return this._result(stitched, tab);
    } finally {
      // Always restore the page, even if capture threw halfway.
      await this.content.command(wc, 'capture.end').catch(() => {});
    }
  }

  /**
   * Compose strips into one tall image.
   *
   * Done with a canvas in an offscreen context rather than pixel-poking in
   * Node: `nativeImage` has no compositing API, and re-encoding each strip
   * to PNG and back would be both slower and lossy in memory terms.
   */
  async _stitch(strips, geo) {
    if (strips.length === 1) return strips[0].image;

    const scale = geo.dpr || 1;
    const width = Math.round(geo.width * scale);
    const lastY = strips[strips.length - 1].y;
    const height = Math.round((lastY + geo.viewport) * scale);

    // Build the composite as a raw BGRA buffer, which is what nativeImage
    // consumes directly.
    const bytesPerPixel = 4;
    const out = Buffer.alloc(width * height * bytesPerPixel);

    for (const strip of strips) {
      const bitmap = strip.image.toBitmap();
      const size = strip.image.getSize();
      const stripWidth = Math.min(size.width, width);
      const destY = Math.round(strip.y * scale);

      for (let row = 0; row < size.height; row++) {
        const targetRow = destY + row;
        if (targetRow < 0 || targetRow >= height) continue;
        const srcOffset = row * size.width * bytesPerPixel;
        const dstOffset = targetRow * width * bytesPerPixel;
        bitmap.copy(out, dstOffset, srcOffset, srcOffset + stripWidth * bytesPerPixel);
      }
    }

    return nativeImage.createFromBitmap(out, { width, height, scaleFactor: scale });
  }

  _result(image, tab) {
    if (!image || image.isEmpty()) throw new Error('capture produced an empty image');
    const size = image.getSize();
    return {
      dataUrl: image.toDataURL(),
      width: size.width,
      height: size.height,
      // Suggested filename from the page, sanitised for the filesystem.
      suggestedName: suggestName(tab),
      capturedAt: Date.now(),
    };
  }

  /**
   * Persist an image the user has annotated. The renderer sends back a data
   * URL because annotation happens on a canvas in the overlay.
   */
  async save({ dataUrl, suggestedName }) {
    this._check();
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('nothing to save');

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save screenshot',
      defaultPath: path.join(app.getPath('pictures'), suggestedName || 'shaurya-capture.png'),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { saved: false };

    await fs.writeFile(filePath, image.toPNG());
    log.info(`saved capture to ${filePath}`);
    return { saved: true, path: filePath };
  }

  copy({ dataUrl }) {
    this._check();
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('nothing to copy');
    clipboard.writeImage(image);
    return { copied: true };
  }
}

function suggestName(tab) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let host = 'page';
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch { /* internal page */ }
  return `shaurya-${host}-${stamp}.png`.replace(/[^\w.-]/g, '_');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ScreenshotService };
