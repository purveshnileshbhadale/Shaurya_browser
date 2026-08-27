'use strict';
/**
 * Native window chrome.
 *
 * The system paints the window buttons, and we only get to choose their
 * colours. Two things here have visible consequences and no runtime signal
 * when they are wrong: a glyph colour with no contrast against its own
 * background (an invisible close button), and an overlay that is re-applied
 * on a theme change (or is not, leaving pale buttons on a dark window).
 */
const test = require('node:test');
const assert = require('node:assert');

/** Load the module with Electron's `nativeTheme` stubbed. */
function load({ systemDark = false } = {}) {
  const modulePath = require.resolve('../src/main/window/platform-chrome');
  const electronPath = require.resolve('electron');
  const realElectron = require.cache[electronPath];

  delete require.cache[modulePath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { nativeTheme: { shouldUseDarkColors: systemDark } },
  };

  const chrome = require(modulePath);

  if (realElectron) require.cache[electronPath] = realElectron;
  else delete require.cache[electronPath];
  delete require.cache[modulePath];

  return chrome;
}

// ---- glyph contrast -------------------------------------------------------

test('the glyph colour always has usable contrast against its background', () => {
  const { readableOn } = load();

  assert.equal(readableOn('#FFFFFF'), '#202124', 'dark glyphs on white');
  assert.equal(readableOn('#000000'), '#E8EAED', 'light glyphs on black');

  // The case a naive channel average gets wrong: mid-green is perceptually
  // bright because the eye is most sensitive to green, so black is correct
  // even though (r+g+b)/3 is only 0.5.
  assert.equal(readableOn('#00FF00'), '#202124',
    'mid-green reads as bright; light glyphs on it would be unreadable');

  // And the converse: mid-blue is perceptually dark despite the same average.
  assert.equal(readableOn('#0000FF'), '#E8EAED');
});

test('a malformed colour degrades to dark glyphs rather than throwing', () => {
  const { readableOn } = load();
  // "undefined" is nine characters long, so a length check would let it
  // through to parseInt and yield NaN — which fails every comparison and
  // silently returns the *light* glyph, the wrong one for a light bar.
  assert.equal(readableOn(undefined), '#202124');
  assert.equal(readableOn('#abc'), '#202124');
  assert.equal(readableOn('rebeccapurple'), '#202124');
});

// ---- colour resolution ----------------------------------------------------

test('private and Ghost windows get their own chrome, whatever the theme', () => {
  const { chromeColors } = load();

  const priv = chromeColors({ dark: false, incognito: true });
  assert.equal(priv.dark, true, 'a private window is dark even in a light theme');
  assert.equal(priv.background, '#1B1230');

  const ghost = chromeColors({ dark: false, mode: 'ghost' });
  assert.equal(ghost.dark, true);
  assert.notEqual(ghost.background, priv.background,
    'the two states must be told apart at a glance, not merely both be dark');
});

test('incognito wins over the active mode', () => {
  const { chromeColors } = load();
  // Both are "distinct window" signals; the private one is the one a user
  // must not misread, so it takes the outer branch.
  const both = chromeColors({ dark: true, incognito: true, mode: 'ghost' });
  assert.equal(both.background, '#1B1230');
});

test('ordinary windows pick a glyph colour that suits their own background', () => {
  const { chromeColors, readableOn } = load();
  for (const dark of [true, false]) {
    const colors = chromeColors({ dark });
    assert.equal(colors.symbol, readableOn(colors.background),
      'the two are chosen together or the buttons vanish into the bar');
  }
});

test('"system" theme follows the OS, and an explicit theme does not', () => {
  assert.equal(load({ systemDark: true }).isDark('system'), true);
  assert.equal(load({ systemDark: false }).isDark('system'), false);
  assert.equal(load({ systemDark: true }).isDark('light'), false);
  assert.equal(load({ systemDark: false }).isDark('dark'), true);
  // Undefined is the pre-settings state during first boot.
  assert.equal(load({ systemDark: true }).isDark(undefined), true);
});

// ---- the overlay descriptor ----------------------------------------------

test('the overlay descriptor carries the colours the window was resolved with', () => {
  const { chromeColors, overlayFor } = load();
  const colors = chromeColors({ dark: true });
  const overlay = overlayFor(colors);

  assert.equal(overlay.color, colors.background);
  assert.equal(overlay.symbolColor, colors.symbol);
  assert.equal(overlay.height, 44, 'must match the toolbar row or the seam shows');
});

test('re-applying colours calls setTitleBarOverlay, which is the whole point', () => {
  const { chromeColors, applyColors } = load();
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    const applied = [];
    const win = {
      isDestroyed: () => false,
      setTitleBarOverlay: (o) => applied.push(o),
      setBackgroundColor: () => { throw new Error('not on win32'); },
    };

    const light = chromeColors({ dark: false });
    const dark = chromeColors({ dark: true });
    assert.equal(applyColors(win, light), true);
    assert.equal(applyColors(win, dark), true);

    assert.equal(applied.length, 2);
    assert.notEqual(applied[0].color, applied[1].color,
      'a theme change must actually move the native buttons, not just our CSS');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('a window without an overlay reports failure instead of throwing', () => {
  const { chromeColors, applyColors } = load();
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    // An app-mode (PWA) window keeps its native frame, so Electron throws.
    const framed = {
      isDestroyed: () => false,
      setTitleBarOverlay: () => { throw new Error('window does not have an overlay'); },
    };
    assert.equal(applyColors(framed, chromeColors({ dark: true })), false);
    assert.equal(applyColors(null, chromeColors({ dark: true })), false);
    assert.equal(applyColors({ isDestroyed: () => true }, chromeColors({})), false);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

// ---- what the renderer is told -------------------------------------------

test('a framed window reports no backdrop, so the renderer stays opaque', () => {
  const { backdropFor } = load();
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    assert.equal(backdropFor({ transparentBackdrop: true }), 'mica');
    // Translucent surfaces over an opaque window frame look like a bug.
    assert.equal(backdropFor({ transparentBackdrop: false }), 'none');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('only Windows reserves horizontal room for system buttons', () => {
  const { overlayWidth } = load();
  const original = process.platform;

  try {
    for (const [platform, expected] of [['win32', 140], ['darwin', 0], ['linux', 0]]) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      assert.equal(overlayWidth(), expected,
        `${platform}: padding the toolbar on a platform with no overlay is dead space`);
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

test('Mica needs a transparent window background or it never shows', () => {
  const { chromeColors, windowOptions } = load();
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  try {
    const colors = chromeColors({ dark: true });
    const translucent = windowOptions(colors, { transparentBackdrop: true });
    assert.equal(translucent.backgroundMaterial, 'mica');
    assert.equal(translucent.backgroundColor, '#00000000',
      'an opaque backing paints over the material and the effect is invisible');
    assert.deepEqual(translucent.titleBarOverlay, { color: colors.background, symbolColor: colors.symbol, height: 44 });

    const opaque = windowOptions(colors, { transparentBackdrop: false });
    assert.equal(opaque.backgroundMaterial, undefined);
    assert.equal(opaque.backgroundColor, colors.background);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});
