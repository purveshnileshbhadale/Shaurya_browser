'use strict';
/**
 * Screen colour picker with a WCAG contrast checker (spec §5).
 *
 * Sampling is done in the main process from a `capturePage()` bitmap rather
 * than by injecting a script: a page cannot be trusted to report its own
 * pixels honestly, and this way the picker works over canvas, video, images
 * and cross-origin iframes alike.
 */
const EventEmitter = require('node:events');
const { createLogger } = require('../../util/logger');

const log = createLogger('color');

class ColorService extends EventEmitter {
  constructor(features) {
    super();
    this.features = features;
    /** Colours the user has picked this session, newest first. */
    this.history = [];
  }

  _check() {
    if (!this.features.enabled('colorTools')) {
      throw new Error('Colour tools are turned off in the Feature Store');
    }
  }

  /**
   * Sample the pixel at a point in the page's viewport.
   *
   * @param {object} tab
   * @param {{x:number, y:number}} point   CSS pixels, viewport-relative
   */
  async sample(tab, { x, y }) {
    this._check();
    if (!tab?.webContents) throw new Error('no page to sample');

    // Capture a 1px rect rather than the whole page: on a 4K display a full
    // capture is ~30 MB and the user is dragging the cursor continuously.
    const image = await tab.webContents.capturePage({
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      width: 1,
      height: 1,
    });
    if (image.isEmpty()) throw new Error('nothing to sample at that point');

    // Electron bitmaps are BGRA.
    const [b, g, r, a] = image.toBitmap();
    const color = this.describe({ r, g, b, a: a / 255 });

    this.history.unshift({ ...color, at: Date.now() });
    this.history = this.history.slice(0, 24);
    this.emit('sample', color);
    return color;
  }

  /** Every representation of one colour, so the panel can offer them all. */
  describe({ r, g, b, a = 1 }) {
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    const { h, s, l } = rgbToHsl(r, g, b);
    return {
      rgb: { r, g, b, a },
      hex: a < 1 ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex,
      hexShort: hex,
      rgbString: a < 1 ? `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})` : `rgb(${r}, ${g}, ${b})`,
      hsl: { h, s, l },
      hslString: `hsl(${h} ${s}% ${l}%)`,
      luminance: relativeLuminance(r, g, b),
      // Which of black or white reads better on this colour.
      readableOn: contrast({ r, g, b }, { r: 0, g: 0, b: 0 })
        >= contrast({ r, g, b }, { r: 255, g: 255, b: 255 }) ? '#000000' : '#ffffff',
    };
  }

  /**
   * WCAG 2.1 contrast between two colours, with pass/fail for each level.
   *
   * The thresholds are the ones that actually matter in review: 4.5:1 for
   * body text (AA), 3:1 for large text and UI components, 7:1 for AAA.
   */
  contrast({ foreground, background }) {
    this._check();
    const fg = parseColor(foreground);
    const bg = parseColor(background);
    if (!fg || !bg) throw new Error('could not parse those colours');

    const ratio = contrast(fg, bg);
    const rounded = Math.round(ratio * 100) / 100;

    return {
      foreground: this.describe(fg),
      background: this.describe(bg),
      ratio: rounded,
      levels: {
        'AA normal text': { threshold: 4.5, pass: ratio >= 4.5 },
        'AA large text': { threshold: 3, pass: ratio >= 3 },
        'AA UI components': { threshold: 3, pass: ratio >= 3 },
        'AAA normal text': { threshold: 7, pass: ratio >= 7 },
        'AAA large text': { threshold: 4.5, pass: ratio >= 4.5 },
      },
      // The most useful single line for a designer.
      verdict: ratio >= 7 ? 'Passes AAA'
        : ratio >= 4.5 ? 'Passes AA for body text'
          : ratio >= 3 ? 'Passes AA for large text only'
            : 'Fails WCAG AA',
      // How much the foreground must move to reach AA, if it does not.
      suggestion: ratio >= 4.5 ? null : suggestAccessible(fg, bg),
    };
  }

  clearHistory() {
    this.history = [];
    return true;
  }
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

/** WCAG relative luminance, with the sRGB gamma expansion. */
function relativeLuminance(r, g, b) {
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = relativeLuminance(a.r, a.g, a.b);
  const lb = relativeLuminance(b.r, b.g, b.b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0));
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/**
 * Nudge the foreground's lightness until it clears 4.5:1, keeping its hue
 * and saturation — a designer wants "the same colour, legible", not a
 * different one.
 */
function suggestAccessible(fg, bg) {
  const { h, s, l } = rgbToHsl(fg.r, fg.g, fg.b);
  const bgLuminance = relativeLuminance(bg.r, bg.g, bg.b);
  // Move away from the background: darken on light backgrounds, lighten on
  // dark ones.
  const direction = bgLuminance > 0.5 ? -1 : 1;

  for (let step = 1; step <= 100; step++) {
    const nextL = Math.min(100, Math.max(0, l + direction * step));
    const candidate = hslToRgb(h, s, nextL);
    if (contrast(candidate, bg) >= 4.5) {
      const hex = '#' + [candidate.r, candidate.g, candidate.b]
        .map((v) => v.toString(16).padStart(2, '0')).join('');
      return {
        hex,
        hsl: { h, s, l: nextL },
        ratio: Math.round(contrast(candidate, bg) * 100) / 100,
        note: `Same hue, lightness ${l}% → ${nextL}%`,
      };
    }
    if (nextL === 0 || nextL === 100) break;
  }
  return null;
}

/** Accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and `hsl()`. */
function parseColor(input) {
  if (input && typeof input === 'object' && 'r' in input) return input;
  const s = String(input || '').trim().toLowerCase();

  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    return {
      r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
      a: m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4])) : 1,
    };
  }

  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const rgb = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
    return {
      ...rgb,
      a: m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : Number(m[4])) : 1,
    };
  }

  return null;
}

module.exports = {
  ColorService, relativeLuminance, contrast, rgbToHsl, hslToRgb, parseColor,
};
