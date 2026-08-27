'use strict';
/**
 * Native window chrome, per platform.
 *
 * Each desktop OS draws its window controls differently and gives an app a
 * different amount of rope. Getting this right is most of what separates a
 * browser that feels native from an Electron app wearing a costume:
 *
 * - **Windows** hands us `titleBarOverlay`, which draws the *real* system
 *   minimise/maximise/close over our chrome. That is what keeps Snap Layouts
 *   (hovering maximise), the Alt-Space system menu and the double-click-to-
 *   maximise target working. The catch is that its colours are ours to
 *   supply, and they must be kept in step with the theme — otherwise the
 *   buttons sit in a rectangle of the old background and the seam is
 *   obvious.
 * - **macOS** gives real traffic lights via `hiddenInset`, positioned to line
 *   up with the sidebar's first row.
 * - **Linux** has no overlay API at all, so the chrome draws its own.
 *
 * The colours live here rather than in the renderer because the *system*
 * paints them; the renderer's CSS never sees these pixels.
 */
const { nativeTheme } = require('electron');

const { createLogger } = require('../util/logger');

const log = createLogger('chrome');

/**
 * Backdrop material on Windows 11.
 *
 * `mica` tints the desktop wallpaper through the window and is what Windows
 * 11's own apps use for a top-level window — it makes an app feel part of the
 * OS rather than pasted onto it. It requires build 22621+; Electron ignores
 * the option on anything older, so no version gate is needed here.
 *
 * Deliberately not `acrylic`: acrylic blurs whatever is *behind* the window,
 * which is expensive to composite and actively unhelpful for a browser, where
 * the content area is opaque anyway and the effect only shows through the
 * chrome.
 */
const WINDOWS_MATERIAL = 'mica';

/**
 * The two glyph colours.
 *
 * Not pure black and white: at the small size the system draws these, full
 * contrast reads as harsh, and both values match the chrome's own foreground
 * tokens so the native buttons sit in the same family as ours.
 */
const DARK_GLYPH = '#202124';
const LIGHT_GLYPH = '#E8EAED';

/**
 * Resolve the chrome colours for a window.
 *
 * @param {object} params
 * @param {boolean} params.dark      is the resolved theme dark?
 * @param {boolean} params.incognito
 * @param {string} [params.mode]     active mode id, for its own chrome
 * @param {string} [params.accent]
 */
function chromeColors({ dark, incognito, mode, accent } = {}) {
  // A private window is visually distinct at the OS level too, not just
  // inside our own chrome — the point is that it is unmistakable from across
  // a room (spec §3).
  if (incognito) {
    return { background: '#1B1230', symbol: '#E8EAED', dark: true };
  }

  // Ghost Mode gets the same treatment for the same reason (spec §7).
  if (mode === 'ghost') {
    return { background: '#0B0D10', symbol: '#E2E8F0', dark: true };
  }

  const background = dark ? '#14161A' : '#F6F7F9';
  return {
    background,
    // The system draws the glyphs; we choose their colour, and a wrong choice
    // here is an accessibility failure rather than a cosmetic one — the close
    // button becomes invisible.
    symbol: readableOn(background),
    dark,
    accent,
  };
}

/**
 * Window construction options for this platform.
 *
 * @param {ReturnType<typeof chromeColors>} colors
 * @param {object} [options]
 * @param {boolean} [options.transparentBackdrop] allow the Mica material through
 */
function windowOptions(colors, { transparentBackdrop = true } = {}) {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
      // Vibrancy is macOS's equivalent of Mica. `under-window` is the one
      // that samples the desktop rather than the window's own content.
      vibrancy: 'under-window',
      visualEffectState: 'followWindow',
    };
  }

  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: overlayFor(colors),
      // Mica needs the window's own background to be transparent, or it
      // paints over the material and the effect is invisible.
      ...(transparentBackdrop
        ? { backgroundMaterial: WINDOWS_MATERIAL, backgroundColor: '#00000000' }
        : { backgroundColor: colors.background }),
      // Windows 11 rounds top-level windows automatically; this only asks it
      // not to make an exception for a frameless one.
      roundedCorners: true,
    };
  }

  // Linux: no overlay API, so the chrome draws its own controls.
  return { frame: false, backgroundColor: colors.background };
}

/**
 * Which backdrop material this window actually got, as a name the renderer's
 * CSS can key off.
 *
 * The renderer has to know, because a translucent window needs *its own*
 * surfaces to be translucent too — an opaque toolbar painted over Mica hides
 * the material completely, and the effect silently does nothing.
 *
 * @param {object} [options]
 * @param {boolean} [options.transparentBackdrop]
 * @returns {'mica'|'vibrancy'|'none'}
 */
function backdropFor({ transparentBackdrop = true } = {}) {
  if (!transparentBackdrop) return 'none';
  if (process.platform === 'win32') return WINDOWS_MATERIAL;
  if (process.platform === 'darwin') return 'vibrancy';
  return 'none';
}

/**
 * How much horizontal room the system's own window buttons take.
 *
 * Windows draws minimise/maximise/close into the overlay region at the
 * inline-end of our chrome; anything the renderer paints there is covered by
 * buttons it does not own. macOS's traffic lights sit at the inline-start and
 * are handled by `trafficLightPosition` plus the sidebar's own padding.
 */
function overlayWidth() {
  return process.platform === 'win32' ? 140 : 0;
}

/** The overlay descriptor Windows wants. Height matches the toolbar row. */
function overlayFor(colors, height = 44) {
  return { color: colors.background, symbolColor: colors.symbol, height };
}

/**
 * Re-tint the native controls after a theme or mode change.
 *
 * This is the part that is easy to miss and immediately visible when missed:
 * `titleBarOverlay` is a *construction* option, so a window created in light
 * mode keeps light window buttons forever unless something re-applies them.
 * Switching to Gamer Mode would leave three system buttons sitting in a pale
 * rectangle at the top-right of a dark window.
 *
 * @param {Electron.BaseWindow} win
 * @param {ReturnType<typeof chromeColors>} colors
 */
function applyColors(win, colors) {
  if (!win || win.isDestroyed()) return false;

  if (process.platform === 'win32') {
    try {
      win.setTitleBarOverlay(overlayFor(colors));
    } catch (err) {
      // Throws when the window was not created with an overlay — an app-mode
      // (PWA) window, for instance, which keeps its native frame.
      log.debug(`title bar overlay not applicable: ${err.message}`);
      return false;
    }
  }

  // Every platform still wants the backing colour right, or a resize flashes
  // the old one before the renderer repaints.
  try {
    if (process.platform !== 'win32') win.setBackgroundColor(colors.background);
  } catch { /* window going away */ }

  return true;
}

/**
 * Pick a readable glyph colour for a background.
 *
 * WCAG relative luminance rather than a naive average: the eye is far more
 * sensitive to green than to blue, and averaging the channels picks white
 * text on mid-greens where black is clearly correct.
 */
function readableOn(hex) {
  const value = /^#?([0-9a-f]{6})$/i.exec(String(hex))?.[1];
  // A length check is not enough: "undefined" is nine characters and parses
  // to NaN, which compares false against every threshold and would hand back
  // light glyphs for a light bar without a word of complaint.
  if (!value) return DARK_GLYPH;

  const channel = (offset) => {
    const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };

  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // 0.179 is the crossover where white and black have equal contrast against
  // the background, so either side of it picks the better of the two.
  return luminance > 0.179 ? DARK_GLYPH : LIGHT_GLYPH;
}

/** Is the resolved theme dark right now? */
function isDark(themeSetting) {
  if (themeSetting === 'dark') return true;
  if (themeSetting === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

module.exports = {
  chromeColors, windowOptions, applyColors, overlayFor, readableOn, isDark,
  backdropFor, overlayWidth, WINDOWS_MATERIAL,
};
