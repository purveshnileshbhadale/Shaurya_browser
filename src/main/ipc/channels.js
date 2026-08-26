'use strict';
/**
 * The single source of truth for the main<->renderer contract.
 *
 * Both the preload bridge and the IPC router import this list. A channel
 * that is not named here cannot be invoked from a renderer at all, which
 * keeps the attack surface of a compromised web renderer to exactly this
 * enumeration rather than "any string the page can guess".
 */

/** Request/response channels (renderer -> main, awaits a result). */
const INVOKE = [
  // --- shell & window ---------------------------------------------------
  'shell.bootstrap',          // initial state dump for a fresh chrome renderer
  'window.minimize', 'window.maximize', 'window.close', 'window.state',
  'window.newWindow', 'window.newIncognitoWindow',

  // --- tabs -------------------------------------------------------------
  'tabs.list', 'tabs.create', 'tabs.close', 'tabs.activate', 'tabs.reorder',
  'tabs.navigate', 'tabs.goBack', 'tabs.goForward', 'tabs.reload',
  'tabs.stop', 'tabs.duplicate', 'tabs.mute', 'tabs.pin', 'tabs.hibernate',
  'tabs.wake', 'tabs.move', 'tabs.zoom', 'tabs.captureThumbnail',
  'tabs.findInPage', 'tabs.stopFind',

  // --- tab groups / workspaces -----------------------------------------
  'groups.list', 'groups.create', 'groups.update', 'groups.remove',
  'groups.assign', 'groups.toggleCollapse',
  'workspaces.list', 'workspaces.create', 'workspaces.switch', 'workspaces.remove',

  // --- layout -----------------------------------------------------------
  'layout.get', 'layout.setTabOrientation', 'layout.setSidebarWidth',
  'layout.splitWith', 'layout.unsplit', 'layout.setSplitRatio',
  'layout.setPanel', 'layout.setPanelWidth', 'layout.chromeMetrics',
  'layout.setResponsiveMode',

  // --- omnibox / search / navigation ------------------------------------
  'omnibox.suggest', 'omnibox.resolve',

  // --- history & bookmarks ---------------------------------------------
  'history.query', 'history.remove', 'history.clear',
  'bookmarks.list', 'bookmarks.add', 'bookmarks.remove', 'bookmarks.update',
  'bookmarks.folders', 'bookmarks.gitCard',

  // --- downloads --------------------------------------------------------
  'downloads.list', 'downloads.cancel', 'downloads.reveal', 'downloads.clear',

  // --- settings & feature store ----------------------------------------
  'settings.get', 'settings.set', 'settings.reset', 'settings.export',
  'features.list', 'features.toggle',
  'onboarding.state', 'onboarding.complete',

  // --- profiles ---------------------------------------------------------
  'profiles.list', 'profiles.create', 'profiles.remove', 'profiles.switch',
  'profiles.update',

  // --- privacy ----------------------------------------------------------
  'adblock.stats', 'adblock.siteSetting', 'adblock.setSiteSetting',
  'adblock.lists', 'adblock.updateLists', 'adblock.setListEnabled',
  'permissions.forSite', 'permissions.set', 'permissions.pending',
  'permissions.respond',
  'privacy.siteInfo', 'privacy.clearSiteData', 'privacy.allowInsecure',

  // --- vpn --------------------------------------------------------------
  'vpn.status', 'vpn.connect', 'vpn.disconnect', 'vpn.regions',
  'vpn.setKillSwitch', 'vpn.usage',

  // --- passwords --------------------------------------------------------
  'vault.status', 'vault.create', 'vault.unlock', 'vault.lock',
  'vault.list', 'vault.add', 'vault.update', 'vault.remove', 'vault.reveal',
  'vault.generate', 'vault.breachCheck', 'vault.autofillCandidates',
  'vault.fill', 'vault.confirmSave', 'vault.declineSave',

  // --- AI ---------------------------------------------------------------
  'ai.providers', 'ai.chat', 'ai.cancel', 'ai.summarize', 'ai.translate',
  'ai.compareTabs', 'ai.draftReply', 'ai.research', 'ai.confirmAction',
  'ai.pageContext', 'ai.grantMultiTab',
  'notes.generate', 'notes.list', 'notes.get', 'notes.remove', 'notes.export',
  'notes.update',

  // --- developer suite --------------------------------------------------
  'devtools.open', 'devtools.toggle',
  'http.send', 'http.collections', 'http.saveRequest', 'http.deleteRequest',
  'http.cancel',
  'ws.connect', 'ws.disconnect', 'ws.send', 'ws.sockets', 'ws.frames',
  'localservers.list', 'localservers.start', 'localservers.stop',
  'localservers.scanPorts',
  'cors.status', 'cors.setEnabled',
  'tools.regex', 'tools.encode', 'tools.decode', 'tools.jwt', 'tools.hash',
  'colorpicker.start', 'colorpicker.contrast',
  'extensions.list', 'extensions.load', 'extensions.remove',
  'extensions.reload', 'extensions.setDevMode', 'extensions.lint',
  'extensions.openStore',

  // --- sessions & PWA ---------------------------------------------------
  'sessions.list', 'sessions.save', 'sessions.restore', 'sessions.remove',
  'pwa.installable', 'pwa.install', 'pwa.list', 'pwa.launch', 'pwa.uninstall',

  // --- capture / reader / media ----------------------------------------
  'capture.region', 'capture.visible', 'capture.fullPage', 'capture.save',
  'capture.copy',
  'reader.toggle', 'reader.state',
  'media.pictureInPicture',

  // --- sync -------------------------------------------------------------
  'sync.status', 'sync.enroll', 'sync.pair', 'sync.now', 'sync.disable',
  'sync.recoveryKey',

  // --- shortcuts --------------------------------------------------------
  'shortcuts.list', 'shortcuts.set', 'shortcuts.reset',

  // --- command palette --------------------------------------------------
  'palette.search', 'palette.run',
];

/** Fire-and-forget channels (renderer -> main, no result). */
const SEND = [
  'ui.ready', 'ui.contextMenu', 'ui.dragTab', 'ui.focusAddressBar',
  'ui.log', 'internal.pageEvent',
];

/** Push channels (main -> renderer). */
const EVENTS = [
  'tabs:changed', 'tabs:activated', 'tabs:navigation', 'tabs:title',
  'tabs:favicon', 'tabs:loading', 'tabs:audio', 'tabs:find',
  'groups:changed', 'workspaces:changed', 'layout:changed',
  'settings:changed', 'features:changed', 'profiles:changed',
  'adblock:count', 'adblock:lists',
  'permissions:prompt', 'permissions:changed',
  'vpn:status', 'vault:status', 'downloads:changed',
  'ai:stream', 'ai:done', 'ai:error', 'ai:confirm', 'notes:changed',
  'http:progress', 'ws:frame', 'ws:status',
  'localservers:changed', 'extensions:changed', 'sync:status',
  'capture:result', 'colorpicker:sample', 'reader:state',
  'palette:open', 'shortcut:invoked', 'toast', 'pwa:installable',
];

module.exports = { INVOKE, SEND, EVENTS };
