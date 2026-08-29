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
const { ModeService } = require('./services/modes');
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
const { MediaService } = require('./services/media');
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
const { TerminalService } = require('./services/devtools/terminal');
const { DatabaseService } = require('./services/devtools/db');
const { GraphQLService } = require('./services/devtools/graphql');
const { DockerService } = require('./services/devtools/docker');
const { SnippetService } = require('./services/devtools/snippets');
const { MockingService } = require('./services/devtools/mocking');
const { DepWatchService } = require('./services/devtools/depwatch');
const { PerformanceService } = require('./services/gaming/performance');
const { RecorderService } = require('./services/gaming/recorder');
const { StreamService } = require('./services/gaming/streams');
const { GameFeedsService } = require('./services/gaming/feeds');
const { DealsService } = require('./services/gaming/deals');
const { PingService } = require('./services/gaming/ping');
const { OverlayService, GalleryService } = require('./services/gaming/overlay');
const { CreatorService } = require('./services/creator');
const { StudentService } = require('./services/student');
const { GhostService } = require('./services/ghost');
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
  // Constructed immediately after the Feature Store because it installs the
  // overlay resolver; every `features.enabled()` call below this line is
  // already mode-aware.
  container.modes = new ModeService(container.settings, container.features);
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
  container.media = new MediaService(container);

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

  // ---- programmer depth (spec §3) --------------------------------------
  container.terminal = new TerminalService(container);
  container.db = new DatabaseService(container);
  container.graphql = new GraphQLService({ http: container.http, features: container.features });
  container.docker = new DockerService(container);
  container.snippets = new SnippetService(container);
  container.mocking = new MockingService(container);
  container.depwatch = new DepWatchService(container);

  // ---- gaming (spec §4) ------------------------------------------------
  container.performance = new PerformanceService(container);
  container.recorder = new RecorderService(container);
  container.streams = new StreamService(container);
  container.gameFeeds = new GameFeedsService(container);
  container.deals = new DealsService(container);
  container.ping = new PingService(container);
  container.overlay = new OverlayService({
    settings: container.settings,
    features: container.features,
    performance: container.performance,
  });
  container.gallery = new GalleryService(container);

  // ---- creator, student, ghost (spec §5-§7) ----------------------------
  container.creator = new CreatorService(container);
  container.student = new StudentService({
    settings: container.settings,
    features: container.features,
    ai: container.ai,
    content: container.content,
  });
  container.ghost = new GhostService({
    settings: container.settings,
    features: container.features,
    modes: container.modes,
    vault: container.vault,
    breach: require('./services/passwords/breach'),
  });

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
  // gets the same protections attached, in a fixed order. The `shaurya://`
  // handler goes on first: a page that cannot load has nothing to protect.
  container.profiles.addConfigurator((sess, profile) => {
    protocolService.installHandler(container, sess);
    container.adblock.attach(sess, (wcId) => resolvePageUrl(container, wcId));
    container.privacy.attach(sess, profile);
    container.permissions.attach(sess, profile);
    container.cors.attach(sess, profile);
    container.mocking.attach(sess, profile);
    container.student.attach(sess);
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
  startModeWork(container);

  // ---- modes -----------------------------------------------------------
  // A mode switch is a chrome-level event: it changes what the toolbar
  // offers and how the window looks, and never touches the tab set. That is
  // why "no restart, no lost tabs" needs no special handling here — there is
  // simply nothing in this path that could lose one.
  // Services that own OS-level resources need the window manager, which is
  // constructed after them to keep the dependency graph acyclic.
  container.performance.attach(container.windowManager);
  container.ghost.attach(container.windowManager);
  container.ghost.applyStoredDoh();
  container.media.attach(container.windowManager);

  // Hibernation and Turbo ask one question — "is this tab protected?" — and
  // the media registry answers it. Wired per window as they are created so
  // neither the tab manager nor the performance service needs to know that a
  // media service exists.
  const wireMediaProtection = (win) => {
    win.tabs.isProtected = (tabId) => container.media.isProtected(tabId);
    win.tabs.on('closed', ({ id }) => container.media.clear(id));
  };
  for (const win of container.windowManager.list()) wireMediaProtection(win);
  container.windowManager.on('created', wireMediaProtection);

  container.modes.on('changed', (snapshot) => {
    applyTheme(container);
    // Re-tint the *native* window controls. `titleBarOverlay` is a
    // construction option on Windows, so without this a window created in
    // light mode keeps light system buttons forever — three pale buttons in
    // a pale rectangle at the corner of a dark window.
    for (const win of container.windowManager.list()) win.refreshChrome();
    // Arm or release the mode's background work. Doing this from the mode
    // event rather than from each service means a new mode gets correct
    // lifecycle behaviour without touching any of them.
    startModeWork(container);
    container.windowManager.broadcast('modes:changed', snapshot);
    // Feature visibility moved, so the Feature Store screen must repaint too.
    container.windowManager.broadcast('features:changed', {
      features: container.features.list(),
      footprint: container.features.footprint(),
    });
  });

  // ---- theming ---------------------------------------------------------
  applyTheme(container);
  container.settings.on('changed', ({ path }) => {
    if (path.startsWith('appearance.')) {
      applyTheme(container);
      for (const win of container.windowManager.list()) win.refreshChrome();
    }
    container.windowManager.broadcast('settings:changed', {
      path, value: container.settings.get(path === '*' ? null : path),
    });
  });
  nativeTheme.on('updated', () => {
    container.windowManager.broadcast('settings:changed', { path: 'appearance.theme', value: container.settings.get('appearance.theme') });
    // The OS theme moved under us — most often because the user is on the
    // "system" setting and dusk arrived. The native controls have to follow.
    for (const win of container.windowManager.list()) win.refreshChrome();
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

/**
 * Start (or stop) the background work each feature implies.
 *
 * Called at boot and on every mode change. Every branch is `enabled()`-gated
 * rather than mode-gated, so a user who turns one of these on inside a
 * custom mode gets the same behaviour as the built-in that ships it — which
 * is the whole point of the Feature Store being the source of truth.
 */
function startModeWork(container) {
  const on = (id) => container.features.enabled(id);

  if (on('hardwareOverlay') || on('tabLimits')) container.performance.start();
  else container.performance.stop();

  if (on('gameFeeds')) container.gameFeeds.start(); else container.gameFeeds.dispose();
  if (on('deals')) container.deals.start(); else container.deals.dispose();
  if (on('docker')) container.docker.start(); else container.docker.stop();
  if (on('breachMonitor')) container.ghost.startMonitor(); else container.ghost.stopMonitor();

  // Closing a stream player or overlay when its feature goes off matters:
  // an always-on-top window that outlives the mode that opened it is very
  // hard for a user to explain, and slightly hard to get rid of.
  if (!on('streamPlayer')) container.streams.close();
  if (!on('hardwareOverlay')) container.overlay.hide();
  if (!on('recorder')) container.recorder.dispose();
  if (!on('terminal')) container.terminal.disposeAll();
}

/**
 * The native theme follows the *resolved* appearance, so a mode that asks for
 * a dark chrome also darkens native surfaces (menus, scrollbars, the title
 * bar overlay) rather than leaving a light frame around a dark window.
 */
function applyTheme(container) {
  const theme = container.modes
    ? container.modes.appearanceFor().theme
    : container.settings.get('appearance.theme');
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

  // --- mode-scoped services -------------------------------------------
  const { performance, recorder, streams, gameFeeds, deals, ping, overlay,
    creator, student, ghost, docker, mocking, snippets, graphql, terminal } = container;

  // A page reports its own frame rate — the only honest source, since the
  // main process cannot see a renderer's vsync. Attributed to the tab that
  // sent it rather than to anything in the payload, so one page cannot post
  // frame stats on another's behalf.
  container.content.on('frameStats', (payload, { sender }) => {
    const found = windowManager.locateTab(sender?.id);
    if (found?.tab) performance.recordFrameStats(found.tab.id, payload);
  });

  // --- background play ---------------------------------------------------
  // A page announced (or withdrew) its media. Attributed to the sending tab,
  // never to anything in the payload, so one page cannot claim to be another.
  container.content.on('media.state', (payload, { sender }) => {
    const found = windowManager.locateTab(sender?.id);
    if (!found?.tab) return;
    if (payload) container.media.report(found.tab.id, payload);
    else container.media.clear(found.tab.id);
  });

  container.media.on('changed', (snapshot) => {
    windowManager.broadcast('media:changed', snapshot);
  });

  // A tab that navigates away has left its media behind, whatever the old
  // page last reported. Without this, closing a video and opening a text
  // article would leave a phantom track in the now-playing list.
  windowManager.on('navigation', ({ tabId, phase }) => {
    if (phase === 'commit') container.media.clear(tabId);
  });

  // Turning background play off mid-session must release the wake lock and
  // the media keys immediately, not at the next track change.
  features.on('toggled', ({ id }) => {
    if (id === 'backgroundPlay') container.media.refresh();
  });

  // Sampling is off until something needs it, so an ordinary browsing
  // session never runs the rAF loop at all.
  performance.on('metrics', (m) => windowManager.broadcast('perf:metrics', m));
  performance.on('tabUsage', (rows) => windowManager.broadcast('perf:tabUsage', rows));
  performance.on('turbo', (s) => windowManager.broadcast('perf:turbo', s));
  performance.on('capEnforced', (info) => windowManager.broadcast('toast', {
    tone: 'warn',
    message: `A tab was put to sleep for exceeding its ${info.reason} cap.`,
  }));

  recorder.on('state', (s) => windowManager.broadcast('recorder:state', s));
  recorder.on('clip', (file) => {
    windowManager.broadcast('recorder:clip', file);
    // File the clip under the game it came from, so the gallery is organised
    // without the user doing anything.
    container.gallery.file(file.path, windowManager.focused()?.title).catch(() => {});
  });
  recorder.on('saved', (file) => windowManager.broadcast('recorder:clip', file));

  streams.on('changed', (s) => windowManager.broadcast('stream:changed', s));
  gameFeeds.on('changed', (s) => windowManager.broadcast('games:changed', s));
  gameFeeds.on('presence', (p) => windowManager.broadcast('games:changed', { presence: p }));
  deals.on('changed', (s) => windowManager.broadcast('deals:changed', s));
  deals.on('hits', (hits) => {
    for (const hit of hits) {
      windowManager.broadcast('toast', {
        tone: 'success',
        message: hit.reason === 'target'
          ? `${hit.title} hit your target price: $${hit.price} at ${hit.store}.`
          : `${hit.title} dropped to $${hit.price} at ${hit.store}.`,
      });
    }
  });
  ping.on('sample', (s) => windowManager.broadcast('perf:metrics', { ping: s }));
  overlay.on('changed', (s) => windowManager.broadcast('perf:turbo', { overlay: s }));

  creator.on('changed', (s) => windowManager.broadcast('creator:changed', s));
  creator.on('scripts', (s) => windowManager.broadcast('creator:changed', { scripts: s }));
  creator.on('focusCanvas', (s) => windowManager.broadcast('creator:changed', { focusCanvas: s }));

  student.on('timer', (s) => windowManager.broadcast('student:timer', s));
  student.on('phase', ({ phase }) => windowManager.broadcast('toast', {
    tone: 'info',
    message: phase === 'focus' ? 'Back to it — focus block started.' : 'Break time.',
  }));
  student.on('changed', (s) => windowManager.broadcast('student:changed', s));
  student.on('decks', (d) => windowManager.broadcast('student:changed', { decks: d }));
  student.on('deadlines', (d) => windowManager.broadcast('student:changed', { deadlines: d }));

  ghost.on('changed', (s) => windowManager.broadcast('ghost:changed', s));
  ghost.on('breach', (r) => windowManager.broadcast('ghost:changed', { breach: r }));
  ghost.on('stripped', (info) => windowManager.broadcast('toast', {
    tone: 'success',
    message: `Removed ${info.removed.length} metadata block(s) from the download.`,
  }));

  docker.on('changed', (s) => windowManager.broadcast('devtools:changed', { docker: s }));
  mocking.on('changed', (rules) => windowManager.broadcast('devtools:changed', { mocks: rules }));
  snippets.on('changed', (s) => windowManager.broadcast('devtools:changed', { snippets: s }));
  graphql.on('changed', (s) => windowManager.broadcast('devtools:changed', { graphql: s }));
  terminal.on('data', (chunk) => windowManager.broadcast('terminal:data', chunk));
  terminal.on('exit', (info) => windowManager.broadcast('terminal:data', {
    ...info, stream: 'system', text: `\n[process exited with code ${info.code}]\n`,
  }));

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
