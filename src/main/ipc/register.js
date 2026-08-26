'use strict';
/**
 * Wires every declared IPC channel to a service method.
 *
 * This is the one place that knows both the channel vocabulary and the
 * service layer, which keeps services free of Electron concerns and lets
 * `router.missing()` report at boot if a channel was declared and never
 * implemented.
 *
 * Handlers receive `(payload, ctx)` where `ctx.sender` is the calling
 * renderer. Anything window-scoped resolves the window from the sender
 * rather than trusting a windowId in the payload — a compromised chrome
 * renderer should not be able to drive another window.
 */
const { shell, dialog, app } = require('electron');
const layoutEngine = require('../window/layout');
const { createLogger } = require('../util/logger');

const log = createLogger('handlers');

function registerHandlers(c) {
  const { ipc, windowManager } = c;

  /** The window that owns the calling renderer. */
  const win = (ctx) => windowManager.fromWebContents(ctx?.sender) || windowManager.focused();
  /** The active tab of that window. */
  const activeTab = (ctx) => win(ctx)?.tabs.active || null;
  /** A specific tab, defaulting to the active one. */
  const tabOf = (ctx, id) => (id ? win(ctx)?.tabs.get(id) : activeTab(ctx));

  // =========================================================================
  // Shell & window
  // =========================================================================

  ipc.handle('shell.bootstrap', async (_p, ctx) => {
    const w = win(ctx);
    return {
      window: w?.state() ?? null,
      tabs: w?.tabs.snapshot() ?? null,
      layout: w ? layoutEngine.chromeMetrics(w.layout) : null,
      settings: c.settings.get(),
      features: c.features.list(),
      footprint: c.features.footprint(),
      modes: c.modes.snapshot(),
      profiles: c.profiles.list(),
      shortcuts: c.shortcuts.list(),
      vault: c.vault.status(),
      vpn: c.vpn.status(),
      sync: c.sync.status(),
      adblock: c.adblock.statsForTab(activeTab(ctx)?.webContents?.id),
      onboarding: c.settings.get('onboarding'),
      version: {
        aether: app.getVersion(),
        chromium: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
      },
    };
  });

  ipc.handleAll('window', {
    minimize: (_p, ctx) => { win(ctx)?.win.minimize(); return true; },
    maximize: (_p, ctx) => {
      const w = win(ctx);
      if (!w) return false;
      if (w.win.isMaximized()) w.win.unmaximize(); else w.win.maximize();
      return w.state();
    },
    close: (_p, ctx) => { win(ctx)?.close(); return true; },
    state: (_p, ctx) => win(ctx)?.state() ?? null,
    newWindow: () => windowManager.create().id,
    newIncognitoWindow: () => windowManager.create({ incognito: true }).id,
  });

  // =========================================================================
  // Tabs
  // =========================================================================

  ipc.handleAll('tabs', {
    list: (_p, ctx) => win(ctx)?.tabs.snapshot() ?? null,
    create: (p, ctx) => win(ctx)?.tabs.create(p || {}).toJSON(),
    close: (p, ctx) => win(ctx)?.tabs.close(p.id),
    activate: (p, ctx) => win(ctx)?.tabs.activate(p.id),
    reorder: (p, ctx) => win(ctx)?.tabs.reorder(p.ids),
    move: (p, ctx) => win(ctx)?.tabs.move(p.id, p.index),
    duplicate: (p, ctx) => win(ctx)?.tabs.duplicate(p.id)?.toJSON(),
    pin: (p, ctx) => win(ctx)?.tabs.setPinned(p.id, p.pinned),
    hibernate: (p, ctx) => win(ctx)?.tabs.hibernateNow(p.id),
    wake: (p, ctx) => tabOf(ctx, p.id)?.wake(),
    mute: (p, ctx) => { tabOf(ctx, p.id)?.setMuted(p.muted); return true; },
    zoom: (p, ctx) => { tabOf(ctx, p.id)?.setZoom(p.level); return true; },

    navigate: async (p, ctx) => {
      const tab = tabOf(ctx, p.id);
      if (!tab) throw new Error('no tab');
      const resolved = p.raw ? c.search.resolve(p.raw) : { url: p.url };
      await tab.navigate(resolved.url);
      return resolved;
    },
    goBack: (p, ctx) => { tabOf(ctx, p.id)?.goBack(); return true; },
    goForward: (p, ctx) => { tabOf(ctx, p.id)?.goForward(); return true; },
    reload: (p, ctx) => { tabOf(ctx, p.id)?.reload({ ignoreCache: p?.hard }); return true; },
    stop: (p, ctx) => { tabOf(ctx, p.id)?.stop(); return true; },

    captureThumbnail: async (p, ctx) => {
      const tab = tabOf(ctx, p.id);
      if (!tab?.webContents) return null;
      const image = await tab.webContents.capturePage();
      return image.isEmpty() ? null : image.resize({ width: 320 }).toDataURL();
    },
    findInPage: (p, ctx) => {
      const tab = tabOf(ctx, p.id);
      if (!tab?.webContents || !p.text) return 0;
      return tab.webContents.findInPage(p.text, {
        forward: p.forward !== false,
        findNext: Boolean(p.findNext),
        matchCase: Boolean(p.matchCase),
      });
    },
    stopFind: (p, ctx) => {
      tabOf(ctx, p.id)?.webContents?.stopFindInPage(p?.keepSelection ? 'keepSelection' : 'clearSelection');
      return true;
    },
  });

  // =========================================================================
  // Groups & workspaces
  // =========================================================================

  ipc.handleAll('groups', {
    list: (_p, ctx) => win(ctx)?.tabs.groupList() ?? [],
    create: (p, ctx) => win(ctx)?.tabs.createGroup(p || {}),
    update: (p, ctx) => win(ctx)?.tabs.updateGroup(p.id, p.patch),
    remove: (p, ctx) => win(ctx)?.tabs.removeGroup(p.id, { closeTabs: p.closeTabs }),
    assign: (p, ctx) => win(ctx)?.tabs.assignToGroup(p.tabId, p.groupId),
    toggleCollapse: (p, ctx) => win(ctx)?.tabs.toggleGroupCollapse(p.id),
  });

  ipc.handleAll('workspaces', {
    list: (_p, ctx) => win(ctx)?.tabs.workspaceList() ?? [],
    create: (p, ctx) => win(ctx)?.tabs.createWorkspace(p || {}),
    switch: (p, ctx) => win(ctx)?.tabs.switchWorkspace(p.id ?? null),
    remove: (p, ctx) => win(ctx)?.tabs.removeWorkspace(p.id),
  });

  // =========================================================================
  // Layout
  // =========================================================================

  ipc.handleAll('layout', {
    get: (_p, ctx) => {
      const w = win(ctx);
      return w ? layoutEngine.chromeMetrics(w.layout) : null;
    },
    chromeMetrics: (_p, ctx) => {
      const w = win(ctx);
      return w ? layoutEngine.chromeMetrics(w.layout) : null;
    },
    setTabOrientation: (p, ctx) => win(ctx)?.setTabOrientation(p.orientation),
    setSidebarWidth: (p, ctx) => win(ctx)?.setSidebarWidth(p.width, { collapsed: p.collapsed }),
    splitWith: (p, ctx) => win(ctx)?.splitWith(p.tabId, { ratio: p.ratio }),
    unsplit: (_p, ctx) => win(ctx)?.unsplit(),
    setSplitRatio: (p, ctx) => win(ctx)?.setSplitRatio(p.ratio),
    setPanel: (p, ctx) => win(ctx)?.setPanel(p.kind, { width: p.width }),
    setPanelWidth: (p, ctx) => win(ctx)?.setPanelWidth(p.width),
    setResponsiveMode: async (p, ctx) => {
      const w = win(ctx);
      const tab = activeTab(ctx);
      if (!w || !tab) throw new Error('no tab');
      if (!p.deviceId) {
        await c.responsive.disable(tab);
        return w.setResponsive(null);
      }
      const applied = await c.responsive.enable(tab, p);
      return w.setResponsive({
        width: applied.device.width,
        height: applied.device.height,
        scale: p.scale || 1,
      });
    },
  });

  // =========================================================================
  // Omnibox, history, bookmarks, downloads
  // =========================================================================

  ipc.handleAll('omnibox', {
    suggest: (p, ctx) => c.search.suggest({
      query: p.query,
      openTabs: win(ctx)?.tabs.list().map((t) => t.toJSON()) ?? [],
    }),
    resolve: (p) => c.search.resolve(p.input),
  });

  ipc.handleAll('history', {
    query: (p) => c.history.query(p || {}),
    remove: (p) => c.history.remove(p.urls),
    clear: (p) => c.history.clear(p || {}),
  });

  ipc.handleAll('bookmarks', {
    list: (p) => c.bookmarks.list(p || {}),
    add: (p, ctx) => {
      const tab = activeTab(ctx);
      return c.bookmarks.add({
        url: p?.url || tab?.url,
        title: p?.title || tab?.title,
        folderId: p?.folderId,
        tags: p?.tags,
      });
    },
    remove: (p) => c.bookmarks.remove(p.id),
    update: (p) => c.bookmarks.update(p.id, p.patch),
    folders: () => c.bookmarks.folders(),
    gitCard: (p) => c.bookmarks.gitCard(p.url, { token: p.token }),
  });

  ipc.handleAll('downloads', {
    list: () => c.downloads.list(),
    cancel: (p) => c.downloads.cancel(p.id),
    reveal: (p) => c.downloads.reveal(p.id),
    clear: (p) => c.downloads.clear(p || {}),
  });

  // =========================================================================
  // Settings, features, onboarding, profiles
  // =========================================================================

  ipc.handleAll('settings', {
    get: (p) => c.settings.get(p?.path),
    set: (p) => {
      if (p.entries) {
        c.settings.patch(p.entries);
        return c.settings.get();
      }
      return c.settings.set(p.path, p.value);
    },
    reset: (p) => { c.settings.reset(p?.section); return c.settings.get(); },
    export: () => ({
      settings: c.settings.get(),
      bookmarks: c.bookmarks.exportAll(),
      sessions: c.sessions.exportAll(),
      exportedAt: new Date().toISOString(),
      note: 'Passwords are not included; export them from the vault separately.',
    }),
  });

  ipc.handleAll('features', {
    list: () => ({ features: c.features.list(), footprint: c.features.footprint() }),
    toggle: (p) => {
      c.features.toggle(p.id, p.enabled);
      return { features: c.features.list(), footprint: c.features.footprint() };
    },
  });

  // The switcher itself (spec §2) and the custom-mode builder (spec §5).
  ipc.handleAll('modes', {
    list: () => c.modes.snapshot(),
    active: () => c.modes.active(),
    activate: (p) => c.modes.activate(p.id),
    create: (p) => { c.modes.create(p || {}); return c.modes.snapshot(); },
    update: (p) => { c.modes.update(p.id, p.patch || {}); return c.modes.snapshot(); },
    remove: (p) => c.modes.remove(p.id),
    duplicate: (p) => { c.modes.duplicate(p.id, p.name); return c.modes.snapshot(); },
    resetOverrides: (p) => c.modes.resetOverrides(p?.id),
  });

  ipc.handleAll('onboarding', {
    state: () => c.settings.get('onboarding'),
    complete: (p) => {
      c.settings.set('onboarding', { completed: true, version: 2, choices: p?.choices || {} });
      // Onboarding choices are the user's first configuration pass.
      if (p?.choices) {
        // The mode goes first: it supplies the overlay that the explicit
        // feature choices below are then layered on top of, so a user who
        // picks "gaming" and then unticks the recorder gets both.
        if (p.choices.mode) {
          try { c.modes.activate(p.choices.mode); } catch (err) { log.debug(err.message); }
        }
        for (const [id, enabled] of Object.entries(p.choices.features || {})) {
          try { c.features.toggle(id, enabled); } catch (err) { log.debug(err.message); }
        }
        if (p.choices.searchEngine) c.settings.set('search.engine', p.choices.searchEngine);
        if (p.choices.theme) c.settings.set('appearance.theme', p.choices.theme);
        if (p.choices.accent) c.settings.set('appearance.accent', p.choices.accent);
      }
      return c.settings.get('onboarding');
    },
  });

  // =========================================================================
  // Gaming (spec §4)
  // =========================================================================

  ipc.handleAll('perf', {
    metrics: () => c.performance.metrics(),
    tabUsage: () => c.performance.tabUsage(),
    turbo: (p) => c.performance.setTurbo(p?.on, {
      deps: { extensions: c.extensions, sync: c.sync },
    }),
    lowLatency: (p) => c.performance.setLowLatency(p?.on),
    setTabCap: (p) => c.performance.setTabCap(p.tabId || p.host, p),
    clearTabCap: (p) => c.performance.clearTabCap(p.tabId || p.host),
    overlay: () => c.overlay.state(),
  });

  ipc.handleAll('overlay', {
    state: () => c.overlay.state(),
    toggle: () => c.overlay.toggle(),
    update: (p) => c.overlay.update(p || {}),
  });

  ipc.handleAll('gamepad', {
    state: () => c.overlay.bindings(),
    bind: (p) => c.overlay.bind(p.input, p.command),
    reset: () => c.overlay.resetBindings(),
  });

  ipc.handleAll('recorder', {
    state: () => c.recorder.state(),
    start: (p) => c.recorder.start(p || {}),
    stop: () => c.recorder.stop(),
    clip: (p) => c.recorder.clip(p || {}),
    setReplaySeconds: (p) => c.recorder.setReplaySeconds(p.seconds),
    list: () => c.gallery.list(),
    reveal: (p) => c.gallery.reveal(p.path),
  });

  ipc.handleAll('gallery', {
    list: () => c.gallery.list(),
    remove: (p) => c.gallery.remove(p.path),
    reveal: (p) => c.gallery.reveal(p.path),
  });

  ipc.handleAll('stream', {
    list: () => c.streams.state(),
    open: (p) => c.streams.open(p || {}),
    close: () => c.streams.close(),
    add: (p) => c.streams.add(p),
    remove: (p) => c.streams.remove(p),
  });

  ipc.handleAll('games', {
    library: () => c.gameFeeds.steamLibrary(),
    presence: () => c.gameFeeds.presence(),
    feeds: () => c.gameFeeds.snapshot(),
    addFeed: (p) => c.gameFeeds.addFeed(p.url),
    removeFeed: (p) => c.gameFeeds.removeFeed(p.url),
    refresh: () => c.gameFeeds.refreshPatchNotes(),
  });

  ipc.handleAll('deals', {
    list: () => c.deals.watchlist(),
    search: (p) => c.deals.search(p.query),
    watch: (p) => c.deals.watch(p),
    unwatch: (p) => c.deals.unwatch(p.gameId),
    refresh: () => c.deals.refresh(),
  });

  ipc.handleAll('ping', {
    regions: () => c.ping.state(),
    test: (p) => c.ping.testAll(p || {}),
    watch: (p) => c.ping.startWatch(p.regionId),
    stopWatch: () => c.ping.stopWatch(),
    addRegion: (p) => c.ping.addRegion(p),
    removeRegion: (p) => c.ping.removeRegion(p.id),
  });

  // =========================================================================
  // Programmer depth (spec §3)
  // =========================================================================

  ipc.handleAll('terminal', {
    // The profile is resolved from the calling window rather than trusted
    // from the payload, so the dev-profile restriction cannot be bypassed by
    // naming a different profile id.
    open: (p, ctx) => c.terminal.open({
      profileId: win(ctx)?.profileId, cwd: p?.cwd,
    }),
    write: (p) => c.terminal.write(p.id, p.data),
    signal: (p) => c.terminal.signal(p.id, p.signal),
    close: (p) => c.terminal.close(p.id),
    list: () => c.terminal.list(),
    scrollback: (p) => ({ text: c.terminal.scrollback(p.id) }),
  });

  ipc.handleAll('db', {
    drivers: () => c.db.drivers(),
    connect: (p) => c.db.connect(p),
    query: (p) => c.db.query(p.id, p.sql),
    schema: (p) => c.db.schema(p.id),
    close: (p) => c.db.close(p.id),
    list: () => c.db.list(),
  });

  ipc.handleAll('graphql', {
    state: () => c.graphql.state(),
    addEndpoint: (p) => c.graphql.addEndpoint(p),
    removeEndpoint: (p) => c.graphql.removeEndpoint(p.url),
    introspect: (p, ctx) => c.graphql.introspect(p.url, { ...p, profileId: win(ctx)?.profileId }),
    execute: (p, ctx) => c.graphql.execute({ ...p, profileId: win(ctx)?.profileId }),
    clearHistory: () => c.graphql.clearHistory(),
  });

  ipc.handleAll('docker', {
    available: (p) => c.docker.available(p || {}),
    containers: (p) => c.docker.containers(p || {}),
    logs: (p) => c.docker.logs(p.id, p),
  });

  ipc.handleAll('snippets', {
    list: (p) => c.snippets.list(p || {}),
    save: (p) => c.snippets.save(p),
    remove: (p) => c.snippets.remove(p.id),
    resolve: (p) => c.snippets.resolve(p.id, p.values),
  });

  ipc.handleAll('mocks', {
    list: () => c.mocking.rules(),
    save: (p) => c.mocking.save(p),
    remove: (p) => c.mocking.remove(p.id),
    toggle: (p) => c.mocking.toggle(p.id, p.enabled),
  });

  ipc.handleAll('depwatch', {
    analyse: (p) => c.depwatch.analyse(p.filename, p.text),
  });

  // =========================================================================
  // Creator (spec §5)
  // =========================================================================

  ipc.handleAll('creator', {
    state: () => c.creator.snapshot(),
    search: (p) => c.creator.search(p || {}),
    sources: () => c.creator.assetSources(),
    saveKit: (p) => c.creator.saveBrandKit(p),
    removeKit: (p) => c.creator.removeBrandKit(p.id),
    applyValue: (p, ctx) => c.creator.applyBrandValue(activeTab(ctx), p.value),
    thumbnails: () => c.creator.thumbnailComparison(),
    setThumbnail: (p) => c.creator.setThumbnailSlot(p.index, p.path),
    scripts: () => c.creator.scripts(),
    saveScript: (p) => c.creator.saveScript(p),
    removeScript: (p) => c.creator.removeScript(p.id),
    schedule: (p) => c.creator.schedule(p),
    unschedule: (p) => c.creator.unschedule(p.id),
    analytics: () => c.creator.analytics(),
    focusCanvas: () => c.creator.focusCanvas(),
    setFocusCanvas: (p) => c.creator.setFocusCanvas(p.active),
  });

  // =========================================================================
  // Student (spec §6)
  // =========================================================================

  ipc.handleAll('student', {
    library: () => c.student.library(),
    capture: (_p, ctx) => c.student.captureSource(activeTab(ctx)),
    updateSource: (p) => c.student.updateSource(p.id, p.patch),
    removeSource: (p) => c.student.removeSource(p.id),
    cite: (p) => c.student.cite(p.id, p.style),
    exportBibliography: (p) => c.student.exportBibliography(p?.style, p?.ids),

    timer: () => c.student.timerState(),
    startTimer: (p) => c.student.startTimer(p || {}),
    stopTimer: () => c.student.stopTimer(),
    blockList: () => ({ hosts: c.student.blockList(), presets: c.student.timerPresets() }),
    setBlockList: (p) => c.student.setBlockList(p.hosts),
    setSiteLimit: (p) => c.student.setSiteLimit(p.host, p.minutes),

    decks: () => c.student.decks(),
    generateDeck: (p, ctx) => c.student.generateDeck({ ...p, tab: p?.text ? null : activeTab(ctx) }),
    removeDeck: (p) => c.student.removeDeck(p.id),
    reviewCard: (p) => c.student.reviewCard(p.deckId, p.cardId, p.correct),

    annotations: (p) => ({ annotations: c.student.annotations(p.docKey) }),
    addAnnotation: (p) => c.student.addAnnotation(p.docKey, p.annotation),
    removeAnnotation: (p) => c.student.removeAnnotation(p.docKey, p.id),
    searchNotes: (p) => ({ hits: c.student.searchNotes(p.query) }),
    storeOcr: (p) => c.student.storeOcr(p.docKey, p.page, p.text),
    ocrStatus: () => c.student.ocrStatus(),

    deadlines: () => c.student.deadlines(),
    importFeed: (p) => c.student.importFeed(p.url),
    removeFeed: (p) => c.student.removeFeed(p.url),
    room: () => c.student.studyRoom(),
    setRoom: (p) => c.student.setStudyRoom(p),
  });

  // =========================================================================
  // Ghost (spec §7)
  // =========================================================================

  ipc.handleAll('ghost', {
    status: () => c.ghost.status(),
    torAvailable: (p) => c.ghost.torAvailable(p || {}),
    routeTor: async (p, ctx) => {
      const window = win(ctx);
      const session = c.profiles.sessionFor(window?.profileId);
      return c.ghost.routeThroughTor(session, p || {});
    },
    verifyTor: async (_p, ctx) => {
      const session = c.profiles.sessionFor(win(ctx)?.profileId);
      return c.ghost.verifyTor(session);
    },
    dohProviders: () => c.ghost.dohProviders(),
    setDoh: (p) => c.ghost.setDoh(p),
    stripFile: (p) => c.ghost.stripFile(p.path),
    shredFile: (p) => c.ghost.shredFile(p.path, p),
    shredderCaveat: () => c.ghost.shredderCaveat(),
    breachReport: () => c.ghost.breachReport(),
    runBreachScan: () => c.ghost.runBreachScan(),
    // Scoped from the calling window: "this window" must mean the one the
    // user pressed the key in, never one named in a payload.
    panic: (p, ctx) => c.ghost.panic({ scope: p?.scope, windowId: win(ctx)?.id }),
  });

  ipc.handleAll('profiles', {
    list: () => c.profiles.list(),
    create: (p) => c.profiles.create(p || {}),
    remove: (p) => c.profiles.remove(p.id),
    switch: (p) => c.profiles.switch(p.id),
    update: (p) => c.profiles.update(p.id, p.patch),
  });

  // =========================================================================
  // Privacy
  // =========================================================================

  ipc.handleAll('adblock', {
    stats: (_p, ctx) => c.adblock.statsForTab(activeTab(ctx)?.webContents?.id),
    siteSetting: (p, ctx) => c.adblock.siteSetting(p?.host || hostOf(activeTab(ctx)?.url)),
    setSiteSetting: (p, ctx) => {
      const host = p.host || hostOf(activeTab(ctx)?.url);
      const result = c.adblock.setSiteSetting(host, p.enabled);
      activeTab(ctx)?.reload();
      return result;
    },
    lists: () => c.adblock.lists(),
    updateLists: (p) => c.adblock.updateLists(p || {}),
    setListEnabled: (p) => c.adblock.setListEnabled(p.id, p.enabled),
  });

  ipc.handleAll('permissions', {
    forSite: (p, ctx) => c.permissions.forSite(p?.url || activeTab(ctx)?.url || ''),
    set: (p) => c.permissions.set(p.origin, p.permission, p.value),
    pending: () => c.permissions.pending(),
    respond: (p) => c.permissions.respond(p.id, p.decision, { remember: p.remember }),
  });

  ipc.handleAll('privacy', {
    siteInfo: (p, ctx) => {
      const url = p?.url || activeTab(ctx)?.url || '';
      return {
        ...c.privacy.siteInfo(url),
        adblock: c.adblock.siteSetting(hostOf(url)),
        blocked: c.adblock.statsForTab(activeTab(ctx)?.webContents?.id),
        permissions: c.permissions.forSite(url),
      };
    },
    /**
     * The user chose to proceed over plaintext from the HTTPS-only
     * interstitial. Recorded per host so the decision is explicit and
     * inspectable, never a silent downgrade.
     */
    allowInsecure: (p, ctx) => {
      const target = p?.url || activeTab(ctx)?.url || '';
      const host = hostOf(target);
      if (!host) throw new Error('no host to allow');
      c.privacy.allowInsecure(host, { remember: Boolean(p?.remember) });
      return { host, remembered: Boolean(p?.remember) };
    },

    clearSiteData: async (p, ctx) => {
      const url = p?.url || activeTab(ctx)?.url;
      const origin = new URL(url).origin;
      const sess = c.profiles.sessionFor(activeTab(ctx)?.profileId);
      await sess.clearStorageData({ origin });
      c.permissions.clearSite(origin);
      activeTab(ctx)?.reload();
      return { cleared: origin };
    },
  });

  // =========================================================================
  // VPN
  // =========================================================================

  ipc.handleAll('vpn', {
    status: () => c.vpn.status(),
    connect: (p) => c.vpn.connect(p || {}),
    disconnect: () => c.vpn.disconnect(),
    regions: () => c.vpn.regions(),
    setKillSwitch: (p) => c.vpn.setKillSwitch(p.enabled),
    usage: () => c.vpn.usage(),
  });

  // =========================================================================
  // Password vault
  // =========================================================================

  ipc.handleAll('vault', {
    status: () => c.vault.status(),
    create: (p) => c.vault.create(p),
    unlock: (p) => c.vault.unlock(p),
    lock: () => c.vault.lock(),
    list: () => c.vault.list(),
    add: (p) => c.vault.add(p),
    update: (p) => c.vault.update(p.id, p.patch),
    remove: (p) => c.vault.remove(p.id),
    reveal: (p) => c.vault.reveal(p.id),
    generate: (p) => c.vault.generate(p || {}),
    breachCheck: (p) => c.vault.breachCheck(p || {}),
    /** Fill a chosen credential into the page that asked for it. */
    fill: (p, ctx) => c.autofill.fill(activeTab(ctx)?.webContents, p.id, {
      expectedOrigin: p.origin,
    }),
    confirmSave: (p) => c.autofill.confirmSave(p),
    declineSave: (p) => { c.autofill.declineSave(p); return true; },

    autofillCandidates: (p, ctx) => {
      const url = p?.url || activeTab(ctx)?.url || '';
      try {
        return c.vault.candidatesFor(new URL(url).origin);
      } catch {
        return [];
      }
    },
  });

  // =========================================================================
  // AI & notes
  // =========================================================================

  ipc.handleAll('ai', {
    providers: () => c.ai.providers(),
    chat: (p, ctx) => c.ai.chat({ ...p, windowId: win(ctx)?.id }),
    cancel: (p) => c.ai.cancel(p.requestId),
    summarize: (p, ctx) => c.ai.summarize({ ...p, windowId: win(ctx)?.id }),
    translate: (p, ctx) => c.ai.translate({ ...p, windowId: win(ctx)?.id }),
    compareTabs: (p, ctx) => c.ai.compareTabs({ ...p, windowId: win(ctx)?.id }),
    draftReply: (p, ctx) => c.ai.draftReply({ ...p, windowId: win(ctx)?.id }),
    research: (p, ctx) => c.ai.research({ ...p, windowId: win(ctx)?.id }),
    confirmAction: (p) => c.ai.confirmAction(p),
    pageContext: (p, ctx) => c.ai.pageContext({ ...p, windowId: win(ctx)?.id }),
    grantMultiTab: (p, ctx) => c.ai.grantMultiTab({ windowId: win(ctx)?.id, granted: p.granted }),
  });

  ipc.handleAll('notes', {
    generate: (p, ctx) => c.notes.generate({ ...p, window: win(ctx), windowId: win(ctx)?.id }),
    list: (p) => c.notes.list(p || {}),
    get: (p) => c.notes.get(p.id),
    update: (p) => c.notes.update(p.id, p.patch),
    remove: (p) => c.notes.remove(p.id),
    export: (p) => c.notes.export(p),
  });

  // =========================================================================
  // Developer suite
  // =========================================================================

  ipc.handleAll('devtools', {
    open: (p, ctx) => {
      const tab = tabOf(ctx, p?.tabId);
      if (!tab?.webContents) throw new Error('no tab');
      tab.webContents.openDevTools({ mode: p?.mode || 'right' });
      return true;
    },
    toggle: (p, ctx) => {
      const tab = tabOf(ctx, p?.tabId);
      if (!tab?.webContents) throw new Error('no tab');
      if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools();
      else tab.webContents.openDevTools({ mode: p?.mode || 'right' });
      return tab.webContents.isDevToolsOpened();
    },
  });

  ipc.handleAll('http', {
    send: (p, ctx) => c.http.send({
      ...p,
      session: c.profiles.sessionFor(activeTab(ctx)?.profileId || c.profiles.activeId),
    }),
    collections: () => c.http.collections(),
    saveRequest: (p) => c.http.saveRequest(p),
    deleteRequest: (p) => c.http.deleteRequest(p),
    cancel: (p) => c.http.cancel(p.requestId),
  });

  ipc.handleAll('ws', {
    connect: (p) => c.ws.connect(p),
    disconnect: (p) => c.ws.disconnect(p.socketId),
    send: (p) => c.ws.send(p),
    sockets: (p, ctx) => {
      // Attaching the observer here means opening the panel starts capture.
      if (p?.observe !== false) {
        try { c.ws.observe(activeTab(ctx)); } catch (err) { log.debug(err.message); }
      }
      return c.ws.list();
    },
    frames: (p) => c.ws.frames(p.socketId, p),
  });

  ipc.handleAll('localservers', {
    list: () => c.localServers.list(),
    start: async (p) => {
      let root = p?.root;
      if (!root) {
        const picked = await dialog.showOpenDialog({
          title: 'Choose a folder to serve',
          properties: ['openDirectory'],
        });
        if (picked.canceled || !picked.filePaths.length) return null;
        root = picked.filePaths[0];
      }
      return c.localServers.start({ ...p, root });
    },
    stop: (p) => c.localServers.stop(p.id),
    scanPorts: (p) => c.localServers.scanPorts(p || {}),
  });

  ipc.handleAll('cors', {
    status: () => c.cors.status(),
    setEnabled: (p) => c.cors.setEnabled(p),
  });

  ipc.handleAll('tools', {
    regex: (p) => c.tools.regex(p),
    encode: (p) => c.tools.encode(p),
    decode: (p) => c.tools.decode(p),
    jwt: (p) => c.tools.jwt(p),
    hash: (p) => c.tools.hash(p),
  });

  ipc.handleAll('colorpicker', {
    start: (p, ctx) => c.color.sample(activeTab(ctx), p),
    contrast: (p) => c.color.contrast(p),
  });

  ipc.handleAll('extensions', {
    list: () => c.extensions.list(),
    load: async (p) => {
      let dir = p?.path;
      if (!dir) {
        const picked = await dialog.showOpenDialog({
          title: 'Load unpacked extension',
          properties: ['openDirectory'],
        });
        if (picked.canceled || !picked.filePaths.length) return null;
        dir = picked.filePaths[0];
      }
      return c.extensions.load({ path: dir, allowFileAccess: p?.allowFileAccess });
    },
    remove: (p) => c.extensions.remove(p.id),
    reload: (p) => c.extensions.reload(p.id),
    setDevMode: (p) => c.extensions.setDevMode(p.enabled),
    lint: (p) => c.extensions.lint(p.path),
    openStore: (_p, ctx) => {
      win(ctx)?.tabs.create({ url: c.extensions.openStore() });
      return true;
    },
  });

  // =========================================================================
  // Sessions & PWA
  // =========================================================================

  ipc.handleAll('sessions', {
    list: () => c.sessions.list(),
    save: (p, ctx) => c.sessions.save({ name: p.name, windowId: p.allWindows ? null : win(ctx)?.id }),
    restore: (p) => c.sessions.restore(p),
    remove: (p) => c.sessions.remove(p.id),
  });

  ipc.handleAll('pwa', {
    installable: (_p, ctx) => c.pwa.installable(activeTab(ctx)),
    install: (_p, ctx) => c.pwa.install(activeTab(ctx)),
    list: () => c.pwa.list(),
    launch: (p) => {
      const record = c.pwa.get(p.id);
      if (!record) throw new Error('no such app');
      const w = windowManager.create({ url: record.startUrl, appMode: record.id });
      return w.id;
    },
    uninstall: (p) => c.pwa.uninstall(p.id),
  });

  // =========================================================================
  // Capture, reader, media
  // =========================================================================

  ipc.handleAll('capture', {
    visible: (_p, ctx) => c.screenshot.visible(activeTab(ctx)),
    region: (p, ctx) => c.screenshot.region(activeTab(ctx), p.rect),
    fullPage: (_p, ctx) => c.screenshot.fullPage(activeTab(ctx)),
    save: (p) => c.screenshot.save(p),
    copy: (p) => c.screenshot.copy(p),
  });

  ipc.handleAll('reader', {
    toggle: (_p, ctx) => c.reader.toggle(activeTab(ctx)),
    state: (_p, ctx) => c.reader.state(activeTab(ctx)),
  });

  ipc.handleAll('media', {
    pictureInPicture: (_p, ctx) => {
      const tab = activeTab(ctx);
      if (!tab?.webContents) throw new Error('no tab');
      return c.content.command(tab.webContents, 'media.pip');
    },
  });

  // =========================================================================
  // Sync & shortcuts
  // =========================================================================

  ipc.handleAll('sync', {
    status: () => c.sync.status(),
    enroll: (p) => c.sync.enroll(p),
    pair: (p) => c.sync.pair(p),
    now: () => c.sync.syncNow(),
    disable: () => c.sync.disable(),
    recoveryKey: () => ({ phrase: c.sync.recoveryKey() }),
  });

  ipc.handleAll('shortcuts', {
    list: () => ({ commands: c.shortcuts.list(), conflicts: c.shortcuts.conflicts() }),
    set: (p) => c.shortcuts.set(p.id, p.accelerator),
    reset: (p) => c.shortcuts.reset(p?.id),
  });

  // =========================================================================
  // Command palette
  // =========================================================================

  ipc.handleAll('palette', {
    search: (p, ctx) => buildPaletteResults(c, win(ctx), p?.query || ''),
    run: (p, ctx) => runPaletteCommand(c, win(ctx), p),
  });

  // =========================================================================
  // Fire-and-forget
  // =========================================================================

  ipc.handle('ui.ready', (_p, ctx) => {
    ipc.trust(ctx.sender);
  });
  ipc.handle('ui.log', (p) => log.debug(`[ui] ${p?.message}`));
  ipc.handle('ui.focusAddressBar', (_p, ctx) => win(ctx)?.send('shortcut:invoked', { id: 'nav.focusAddress' }));
  ipc.handle('ui.contextMenu', (p, ctx) => win(ctx)?.send('toast', { message: 'context menu', payload: p }));
  ipc.handle('ui.dragTab', (p, ctx) => win(ctx)?.tabs.move(p.id, p.index));
  ipc.handle('internal.pageEvent', (p, ctx) => {
    // Internal pages report navigation intents (e.g. speed-dial clicks).
    if (p?.type === 'navigate' && p.url) {
      win(ctx)?.tabs.active?.navigate(p.url);
    }
  });

  log.info('all IPC handlers registered');
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

/**
 * The palette searches five sources at once (spec §2): open tabs, history,
 * bookmarks, settings and installed extensions, plus every command.
 */
function buildPaletteResults(c, window, query) {
  const q = query.trim().toLowerCase();
  const results = [];

  // --- commands ---
  for (const command of c.shortcuts.list()) {
    const score = fuzzyScore(command.label.toLowerCase(), q);
    if (q && score <= 0) continue;
    results.push({
      kind: 'command',
      id: command.id,
      title: command.label,
      subtitle: command.group,
      accelerator: command.accelerator,
      score: score + 40,
      icon: 'command',
    });
  }

  // --- open tabs ---
  for (const tab of window?.tabs.list() || []) {
    const hay = `${tab.title} ${tab.url}`.toLowerCase();
    const score = fuzzyScore(hay, q);
    if (q && score <= 0) continue;
    results.push({
      kind: 'tab',
      id: tab.id,
      title: tab.title || tab.url,
      subtitle: tab.hibernated ? 'Suspended tab' : 'Open tab',
      score: score + 60,
      icon: 'tab',
      favicon: tab.favicon,
    });
  }

  // --- bookmarks ---
  if (q) {
    for (const b of c.bookmarks.list()) {
      const score = fuzzyScore(`${b.title} ${b.url}`.toLowerCase(), q);
      if (score <= 0) continue;
      results.push({
        kind: 'bookmark', id: b.id, title: b.title, subtitle: b.url,
        url: b.url, score: score + 30, icon: 'star',
      });
    }

    // --- history ---
    for (const h of c.history.query({ query: q, limit: 10 })) {
      results.push({
        kind: 'history', title: h.title, subtitle: h.url, url: h.url,
        score: 20 + Math.min(40, h.score / 10), icon: 'clock',
      });
    }

    // --- settings ---
    for (const entry of settingsIndex()) {
      const score = fuzzyScore(entry.label.toLowerCase(), q);
      if (score <= 0) continue;
      results.push({
        kind: 'setting', id: entry.path, title: entry.label,
        subtitle: `Settings › ${entry.section}`, score: score + 25, icon: 'sliders',
      });
    }

    // --- extensions ---
    for (const ext of c.extensions.list()) {
      const score = fuzzyScore(String(ext.name || '').toLowerCase(), q);
      if (score <= 0) continue;
      results.push({
        kind: 'extension', id: ext.id, title: ext.name,
        subtitle: `Extension ${ext.version || ''}`.trim(), score: score + 15, icon: 'puzzle',
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 24);
}

function runPaletteCommand(c, window, { kind, id, url }) {
  switch (kind) {
    case 'tab':
      window?.tabs.activate(id);
      return { activated: id };
    case 'bookmark':
    case 'history':
      window?.tabs.create({ url });
      return { opened: url };
    case 'setting':
      window?.tabs.create({ url: `aether://settings/#${id}` });
      return { opened: id };
    case 'extension':
      window?.tabs.create({ url: 'aether://settings/#extensions' });
      return { opened: id };
    case 'command':
      window?.send('shortcut:invoked', { id });
      return { invoked: id };
    default:
      throw new Error(`unknown palette result kind "${kind}"`);
  }
}

/** Searchable settings, so the palette can jump straight to one. */
function settingsIndex() {
  return [
    { path: 'appearance', section: 'Appearance', label: 'Theme and accent colour' },
    { path: 'appearance.tabOrientation', section: 'Appearance', label: 'Vertical or horizontal tabs' },
    { path: 'startPage', section: 'Start page', label: 'Start page and widgets' },
    { path: 'search', section: 'Search', label: 'Default search engine' },
    { path: 'privacy', section: 'Privacy', label: 'Ad and tracker blocking' },
    { path: 'privacy.httpsOnly', section: 'Privacy', label: 'HTTPS-only mode' },
    { path: 'privacy.fingerprintResistance', section: 'Privacy', label: 'Fingerprinting resistance' },
    { path: 'vpn', section: 'VPN', label: 'VPN and kill switch' },
    { path: 'passwords', section: 'Passwords', label: 'Password vault' },
    { path: 'ai', section: 'AI', label: 'AI assistant and models' },
    { path: 'ai.multiTabContext', section: 'AI', label: 'Multi-tab context' },
    { path: 'devtools', section: 'Developer', label: 'Developer tools' },
    { path: 'devtools.cors', section: 'Developer', label: 'CORS development toggle' },
    { path: 'tabs', section: 'Tabs', label: 'Tab hibernation' },
    { path: 'sync', section: 'Sync', label: 'Encrypted sync' },
    { path: 'features', section: 'Feature Store', label: 'Feature Store' },
    { path: 'shortcuts', section: 'Shortcuts', label: 'Keyboard shortcuts' },
    { path: 'profiles', section: 'Profiles', label: 'Profiles' },
    { path: 'extensions', section: 'Extensions', label: 'Extensions' },
  ];
}

/**
 * Subsequence fuzzy match, scoring consecutive runs and word-start hits
 * higher — "cmp" should rank "Command palette" above "Compare tabs".
 */
function fuzzyScore(haystack, needle) {
  if (!needle) return 1;
  if (!haystack) return 0;
  if (haystack.includes(needle)) {
    return 100 - haystack.indexOf(needle);
  }

  let score = 0;
  let hi = 0;
  let streak = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi);
    if (found < 0) return 0;
    // A match at a word boundary is a strong signal of intent.
    const atWordStart = found === 0 || /[\s\-_/.]/.test(haystack[found - 1]);
    streak = found === hi ? streak + 1 : 0;
    score += 1 + streak * 2 + (atWordStart ? 5 : 0);
    hi = found + 1;
  }
  return score;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

module.exports = { registerHandlers, fuzzyScore, buildPaletteResults };
