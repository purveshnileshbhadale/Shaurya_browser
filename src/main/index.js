'use strict';
/**
 * Shaurya — application entry point.
 *
 * Order matters here in ways Electron enforces:
 *   1. Command-line switches and privileged scheme registration must happen
 *      before the app is ready — after that, Chromium has already read them.
 *   2. Services are constructed before any window, so the first tab that
 *      loads already has ad blocking, HTTPS-only and permissions attached.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const { registerScheme } = require('./services/protocol');
const { createLogger } = require('./util/logger');

const log = createLogger('app');

// ---------------------------------------------------------------------------
// Pre-ready configuration
// ---------------------------------------------------------------------------

// One instance owns the profile directory; a second launch focuses the first.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !process.env.SHAURYA_ALLOW_MULTI) {
  log.info('another instance is already running; exiting');
  app.quit();
  process.exit(0);
}

registerScheme();

// Chromium feature flags. These are the ones that change user-visible
// behaviour; nothing here weakens the sandbox.
app.commandLine.appendSwitch('enable-features', [
  'PlatformHEVCDecoderSupport',   // hardware video where available
  'CanvasOopRasterization',
  'BackForwardCache',             // instant back/forward
].join(','));
app.commandLine.appendSwitch('disable-features', [
  'OutOfBlinkCors',
  // Chromium's own ad-privacy stack duplicates work we do at the network
  // layer, and Topics is itself a tracking surface (spec §3).
  'PrivacySandboxSettings4', 'BrowsingTopics', 'InterestFeedContentSuggestions',
  'AttributionReportingCrossAppWeb',
].join(','));

// Smooth scrolling and 60fps compositing on Linux/X11 without a compositor.
app.commandLine.appendSwitch('enable-smooth-scrolling');

// Running as root (containers, CI) refuses to start without this. It is a
// deliberate escape hatch for automation only — never taken on a real
// desktop session, where the sandbox stays fully on.
if (process.getuid && process.getuid() === 0 && process.env.SHAURYA_ALLOW_ROOT === '1') {
  log.warn('running as root: disabling the Chromium sandbox (automation only)');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

app.setAppUserModelId('dev.shaurya.browser');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let container = null;

app.whenReady().then(async () => {
  const { bootstrap } = require('./bootstrap');
  container = await bootstrap();

  const { windowManager, settings, sessions } = container;

  // Restore the previous session when asked to, otherwise a fresh window.
  const restored = await sessions.restoreLastSession();
  if (!restored) {
    windowManager.create({ url: process.argv.find((a) => /^https?:\/\//.test(a)) });
  }

  app.on('activate', () => {
    // macOS: clicking the dock icon with no windows opens one.
    if (windowManager.count() === 0) windowManager.create();
  });

  log.info(`Shaurya ready — Chromium ${process.versions.chrome}, Electron ${process.versions.electron}`);
});

app.on('second-instance', (_event, argv) => {
  if (!container) return;
  const url = argv.find((a) => /^https?:\/\//.test(a));
  const win = container.windowManager.focused();
  if (win) {
    win.focus();
    if (url) win.tabs.create({ url });
  } else {
    container.windowManager.create({ url });
  }
});

app.on('window-all-closed', () => {
  // macOS convention is to stay resident; every other platform quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (!container || container.shuttingDown) return;
  event.preventDefault();
  container.shuttingDown = true;
  try {
    await container.shutdown();
  } catch (err) {
    log.error(`shutdown error: ${err.message}`);
  }
  app.exit(0);
});

// A crash in one service must not take the browser down silently.
process.on('uncaughtException', (err) => {
  log.error(`uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${reason?.stack || reason}`);
});
