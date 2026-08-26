'use strict';
/**
 * Service container.
 *
 * Constructs every subsystem once, in dependency order, and hands the whole
 * container to the window layer. Services never reach for each other through
 * globals — everything arrives as a constructor argument, which is what
 * makes the Feature Store able to tear a subsystem down without leaving
 * dangling references behind.
 */
const { app, nativeTheme } = require('electron');

const { SettingsService } = require('./services/settings');
const { FeatureStore } = require('./services/feature-store');
const { ProfileService } = require('./services/profiles');
const { AdblockService } = require('./services/adblock');
const { PrivacyService } = require('./services/privacy');
const { PermissionService } = require('./services/permissions');
const { VpnService } = require('./services/vpn');
const { VaultService } = require('./services/passwords/vault');
const { AutofillService } = require('./services/passwords/autofill');
const { HistoryService } = require('./services/history');
const { BookmarkService } = require('./services/bookmarks');
const { DownloadService } = require('./services/downloads');
const { SessionService } = require('./services/sessions');
const { ExtensionService } = require('./services/extensions');
const { ScreenshotService } = require('./services/screenshot');
const { ReaderService } = require('./services/reader');
const { PwaService } = require('./services/pwa');
const { SearchService } = require('./services/search');
const { ShortcutService } = require('./services/shortcuts');
const { AiService } = require('./services/ai');
const { NotesService } = require('./services/ai/notes');
const { HttpClientService } = require('./services/devtools/http-client');
const { WebSocketInspector } = require('./services/devtools/websocket-inspector');
const { LocalServerService } = require('./services/devtools/local-servers');
const { CorsService } = require('./services/devtools/cors');
const { MarkdownService } = require('./services/devtools/markdown');
const { JsonViewerService } = require('./services/devtools/json-viewer');
const { ColorService } = require('./services/devtools/color');
const { ResponsiveService } = require('./services/devtools/responsive');
const { ToolsService } = require('./services/devtools/tools');
const { SyncService } = require('./services/sync/engine');
const { ContentBridge } = require('./services/content-bridge');
const { WindowManager } = require('./window/window-manager');
const { IpcRouter } = require('./ipc/router');
const { registerHandlers } = require('./ipc/register');
const protocolService = require('./services/protocol');
const { createLogger } = require('./util/logger');

const log = createLogger('boot');

/**
 * @returns {Promise<object>} the fully wired container
 */
async function bootstrap() {
  const t0 = Date.now();
  const container = { shuttingDown: false };

  // ---- foundation ------------------------------------------------------
  container.settings = new SettingsService();
  container.features = new FeatureStore(container.settings);
  container.ipc = new IpcRouter();
  container.content = new ContentBridge();
  container.profiles = new ProfileService(container.settings, container.features);

  // ---- privacy ---------------------------------------------------------
  container.adblock = new AdblockService(container.settings, container.features);
  container.privacy = new PrivacyService(container.settings, container.features);
  container.permissions = new PermissionService(container.settings, container.features);
  container.vpn = new VpnService(container.settings, container.features);
  container.vault = new VaultService(container.settings, container.features);
  container.autofill = new AutofillService(container.vault, container.content, container.features);

  // ---- data ------------------------------------------------------------
  container.history = new HistoryService(container.settings, container.features);
  container.bookmarks = new BookmarkService(container.settings, container.features);
  container.downloads = new DownloadService(container.settings);
  container.search = new SearchService(container.settings, container.history, container.bookmarks);

  // ---- features --------------------------------------------------------
  container.extensions = new ExtensionService(container.settings, container.features, container.profiles);
  container.screenshot = new ScreenshotService(container.content, container.features);
  container.reader = new ReaderService(container.content, container.features);
  container.pwa = new PwaService(container.settings, container.features);
  container.shortcuts = new ShortcutService(container.settings);

  container.ai = new AiService(container.settings, container.features, container.content, container.vault);
  container.notes = new NotesService(container.settings, container.features, container.ai);

  container.http = new HttpClientService(container.settings, container.features);
  container.ws = new WebSocketInspector(container.features);
  container.localServers = new LocalServerService(container.features);
  container.cors = new CorsService(container.settings, container.features, container.profiles);
  container.markdown = new MarkdownService(container.features);
  container.jsonViewer = new JsonViewerService(container.settings, container.features);
  container.color = new ColorService(container.features);
  container.responsive = new ResponsiveService(container.settings, container.features);
  container.tools = new ToolsService();

  container.sync = new SyncService(container.settings, container.features, {
    bookmarks: container.bookmarks,
    history: container.history,
    vault: container.vault,
    notes: container.notes,
    http: container.http,
    extensions: container.extensions,
  });

  // ---- windows ---------------------------------------------------------
  container.windowManager = new WindowManager(container);
  container.sessions = new SessionService({
    settings: container.settings,
    features: container.features,
    windowManager: container.windowManager,
  });

  // ---- protocol & session wiring --------------------------------------
  // The chrome renderer loads from the default session, so that one needs
  // the handler too.
  protocolService.installHandler(container);

  // Every profile session — including incognito contexts created later —
  // gets the same protections attached, in a fixed order. The `aether://`
  // handler goes on first: a page that cannot load has nothing to protect.
  container.profiles.addConfigurator((sess, profile) => {
    protocolService.installHandler(container, sess);
    container.adblock.attach(sess, (wcId) => resolvePageUrl(container, wcId));
    container.privacy.attach(sess, profile);
    container.permissions.attach(sess, profile);
    container.cors.attach(sess, profile);
    container.vpn.attach(sess, profile);
    container.downloads.attach(sess, profile);
    container.jsonViewer.attach(sess, profile);
    container.extensions.attach(sess, profile);
  });
  // Materialise the default profile now so the first tab is protected.
  container.profiles.sessionFor(container.profiles.activeId);

  // ---- IPC -------------------------------------------------------------
  container.content.install();
  registerHandlers(container);
  container.ipc.install();

  const missing = container.ipc.missing();
  if (missing.length) {
    // A declared-but-unimplemented channel is a wiring bug, and it is much
    // cheaper to see it at boot than as a silent failure in the UI.
    log.warn(`${missing.length} declared channel(s) have no handler: ${missing.join(', ')}`);
  }

  // ---- background work -------------------------------------------------
  await container.adblock.init();
  container.extensions.init().catch((err) => log.warn(`extensions: ${err.message}`));
  container.shortcuts.init();
  container.sessions.startAutoSave();
  if (container.features.enabled('sync')) {
    container.sync.start().catch((err) => log.warn(`sync: ${err.message}`));
  }
  if (container.settings.get('vpn.autoConnect') && container.features.enabled('vpn')) {
    container.vpn.connect().catch((err) => log.warn(`vpn autoconnect: ${err.message}`));
  }

  wireCrossServiceEvents(container);

  // ---- theming ---------------------------------------------------------
  applyTheme(container);
  container.settings.on('changed', ({ path }) => {
    if (path.startsWith('appearance.')) applyTheme(container);
    container.windowManager.broadcast('settings:changed', {
      path, value: container.settings.get(path === '*' ? null : path),
    });
  });
  nativeTheme.on('updated', () => {
    container.windowManager.broadcast('settings:changed', { path: 'appearance.theme', value: container.settings.get('appearance.theme') });
  });

  container.shutdown = () => shutdown(container);

  log.info(`bootstrap complete in ${Date.now() - t0}ms`);
  return container;
}

/**
 * Did this failure follow an HTTPS-only upgrade? If so the user deserves the
 * security explanation, not a generic "could not connect".
 */
function wasHttpsUpgrade(container, url) {
  if (!container.privacy.enabled('httpsOnly')) return false;
  if (!String(url).startsWith('https://')) return false;
  try {
    return !container.privacy.httpsExceptions.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Which page does a WebContents id belong to? Used by the request filter. */
function resolvePageUrl(container, webContentsId) {
  const found = container.windowManager?.locateTab(webContentsId);
  return found?.tab?.url;
}

function applyTheme(container) {
  const theme = container.settings.get('appearance.theme');
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
}

/**
 * Connections between services that would otherwise require them to know
 * about each other. Keeping them here means each service stays testable in
 * isolation.
 */
function wireCrossServiceEvents(container) {
  const { windowManager, adblock, history, features, vpn, vault, sync, notes,
    downloads, extensions, permissions, ws, localServers, ai } = container;

  // Blocked-count badge.
  adblock.on('count', (stats) => windowManager.broadcast('adblock:count', stats));
  adblock.on('lists', (lists) => windowManager.broadcast('adblock:lists', lists));

  // A failed navigation gets an interstitial that explains itself, rather
  // than Chromium's default blank error page. The HTTPS-only case is the one
  // that matters: the user must make an explicit choice to continue over
  // plaintext instead of being silently downgraded.
  windowManager.on('load-failed', ({ window, tabId, code, description, url }) => {
    const tab = window?.tabs.get(tabId);
    if (!tab) return;
    // Chromium already renders its own page for these; ours would flicker.
    if (code === -3 /* ERR_ABORTED */) return;

    const kind = wasHttpsUpgrade(container, url) ? 'https-only'
      : code === -105 /* ERR_NAME_NOT_RESOLVED */ ? 'dns'
        : 'network';

    tab.navigate(require('./services/protocol').errorUrl({
      code, description, url, kind,
    })).catch(() => {});
  });

  // History recording, skipping private windows entirely.
  windowManager.on('navigation', ({ window, tabId, url, phase }) => {
    if (phase !== 'commit') return;
    const tab = window.tabs.get(tabId);
    adblock.resetTab(tab?.webContents?.id);
    history.record({ url, title: tab?.title, incognito: window.incognito });
  });

  // Turning a feature off must actually release its resources.
  features.on('toggled', ({ id, enabled }) => {
    windowManager.broadcast('features:changed', features.list());
    if (id === 'vpn' && !enabled) vpn.disconnect().catch(() => {});
    if (id === 'sync' && !enabled) sync.stop();
    if (id === 'sync' && enabled) sync.start().catch(() => {});
    if (id === 'passwords' && !enabled) vault.lock();
    if (id === 'localServers' && !enabled) localServers.stopAll().catch(() => {});
    if (id === 'wsInspector' && !enabled) ws.disconnectAll();
    if (id === 'extensionDev' && !enabled) extensions.stopWatching();
    if (id === 'ai' && !enabled) ai.cancelAll();
    if (id === 'adblock') adblock.engine._cache.clear();
  });

  vpn.on('status', (s) => windowManager.broadcast('vpn:status', s));
  vault.on('status', (s) => windowManager.broadcast('vault:status', s));
  sync.on('status', (s) => windowManager.broadcast('sync:status', s));
  notes.on('changed', (n) => windowManager.broadcast('notes:changed', n));
  downloads.on('changed', (d) => windowManager.broadcast('downloads:changed', d));
  extensions.on('changed', (e) => windowManager.broadcast('extensions:changed', e));
  permissions.on('prompt', (p) => {
    const win = windowManager.fromWebContents(p.webContents) || windowManager.focused();
    win?.send('permissions:prompt', p.payload);
  });
  permissions.on('changed', () => windowManager.broadcast('permissions:changed', null));
  ws.on('frame', (f) => windowManager.broadcast('ws:frame', f));
  ws.on('status', (s) => windowManager.broadcast('ws:status', s));
  localServers.on('changed', (l) => windowManager.broadcast('localservers:changed', l));

  // The AI panel streams tokens straight to the window that asked.
  ai.on('stream', ({ windowId, ...rest }) => {
    const win = windowManager.get(windowId);
    win ? win.send('ai:stream', rest) : windowManager.broadcast('ai:stream', rest);
  });
  ai.on('done', ({ windowId, ...rest }) => {
    const win = windowManager.get(windowId);
    win ? win.send('ai:done', rest) : windowManager.broadcast('ai:done', rest);
  });
  ai.on('error', ({ windowId, ...rest }) => {
    const win = windowManager.get(windowId);
    win ? win.send('ai:error', rest) : windowManager.broadcast('ai:error', rest);
  });
  // Any action with a real-world effect pauses for explicit approval.
  ai.on('confirm', ({ windowId, ...rest }) => {
    const win = windowManager.get(windowId) || windowManager.focused();
    win?.send('ai:confirm', rest);
  });

  // Page-scoped requests from the content preload.
  container.content.handle('cosmetic', ({ url }) => adblock.cosmeticFor(url));
  container.content.on('gesture', ({ direction }, { sender }) => {
    const found = windowManager.locateTab(sender.id);
    if (!found) return;
    if (direction === 'back') found.tab.goBack();
    else found.tab.goForward();
  });
  container.content.on('zoom', ({ level }, { sender }) => {
    const found = windowManager.locateTab(sender.id);
    if (found) found.tab.zoom = level;
  });
}

async function shutdown(container) {
  log.info('shutting down');
  container.sessions.stopAutoSave();
  container.sessions.snapshotLast();

  // Flush every store before the process goes away.
  for (const key of ['settings', 'history', 'bookmarks', 'sessions', 'notes', 'http', 'vault']) {
    try {
      container[key]?.flush?.();
    } catch (err) {
      log.warn(`flush ${key}: ${err.message}`);
    }
  }

  await Promise.allSettled([
    container.vpn.disconnect({ reason: 'shutdown' }),
    container.localServers.stopAll(),
    container.profiles.clearOnExit(),
    container.sync.flush(),
  ]);

  container.ws.disconnectAll();
  container.adblock.dispose();
  container.extensions.stopWatching();
  container.vault.lock();
  log.info('shutdown complete');
}

module.exports = { bootstrap };
