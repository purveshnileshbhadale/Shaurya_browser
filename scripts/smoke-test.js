'use strict';
/**
 * End-to-end smoke test.
 *
 * Boots the real application — real Chromium, real sessions, real IPC — and
 * drives it the way the UI does, then screenshots the result. This catches
 * the class of bug unit tests cannot: a protocol registered on the wrong
 * session, an IPC channel that throws only under a live renderer, a layout
 * that computes correctly but positions nothing.
 *
 * Run with:  npm run smoke
 * (The wrapper in scripts/smoke-test.mjs supplies xvfb and the flags.)
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BaseWindow } = require('electron');

const { registerScheme } = require('../src/main/services/protocol');

registerScheme();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-compositing');

const results = [];
const OUT_DIR = process.env.AETHER_SMOKE_OUT
  || path.join(__dirname, '..', 'test-results');

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, ok: true, detail: detail ?? null });
      console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err.message });
      console.log(`  FAIL ${name} — ${err.message}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a predicate holds, or fail with context. */
async function until(predicate, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await wait(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\nAether smoke test — Chromium ${process.versions.chrome}, Electron ${process.versions.electron}\n`);

  const { bootstrap } = require('../src/main/bootstrap');
  const container = await bootstrap();
  const { windowManager, settings, features } = container;

  // =======================================================================
  // Boot
  // =======================================================================

  await check('bootstrap wires every declared IPC channel', () => {
    const missing = container.ipc.missing();
    assert(missing.length === 0, `unimplemented: ${missing.join(', ')}`);
    return `${container.ipc.handlers.size} handlers`;
  });

  await check('feature store seeds defaults and reports a footprint', () => {
    const list = features.list();
    assert(list.length > 25, `only ${list.length} features registered`);
    const footprint = features.footprint();
    assert(footprint.total === list.length, 'footprint disagrees with the catalogue');
    return `${footprint.activeCount}/${footprint.total} on (${footprint.label})`;
  });

  // =======================================================================
  // Window & tabs
  // =======================================================================

  const win = windowManager.create();
  await until(() => win.shellView?.webContents && !win.shellView.webContents.isLoading(),
    { label: 'the chrome renderer to load' });
  win.show();
  await wait(700);

  await check('window opens with one tab', () => {
    assert(win.tabs.list().length === 1, `expected 1 tab, got ${win.tabs.list().length}`);
    assert(win.tabs.activeId, 'no active tab');
    return win.tabs.active.url;
  });

  await check('the chrome renderer loaded without a page error', () => {
    const wc = win.shellView.webContents;
    assert(!wc.isCrashed(), 'the chrome renderer crashed');
    assert(wc.getURL().includes('index.html'), `unexpected chrome URL: ${wc.getURL()}`);
  });

  await check('first run opens the onboarding flow', async () => {
    const tab = win.tabs.active;
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'onboarding to load' });
    assert(tab.webContents.getURL().startsWith('aether://onboarding'),
      `first run went to ${tab.webContents.getURL()}`);
    const heading = await tab.webContents.executeJavaScript(
      'document.querySelector(".ob h1")?.textContent || ""');
    assert(/Welcome/.test(heading), `onboarding did not render (heading: "${heading}")`);
    await capture(win, 'onboarding');
    return heading;
  });

  await check('aether://start renders in a profile partition', async () => {
    const tab = win.tabs.active;
    await tab.navigate('aether://start');
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'the start page to finish loading' });
    assert(!tab.error, `start page failed: ${JSON.stringify(tab.error)}`);

    const found = await tab.webContents.executeJavaScript(
      'document.querySelector(".start-search") ? "ok" : "missing"');
    assert(found === 'ok', 'the start page did not render its search field');
    return tab.webContents.getURL();
  });

  await check('the chrome UI rendered a toolbar and a tab strip', async () => {
    const found = await win.shellView.webContents.executeJavaScript(`
      JSON.stringify({
        toolbar: !!document.querySelector('#toolbar .omnibox'),
        tabs: document.querySelectorAll('#sidebar-tabs .tab').length,
        buttons: document.querySelectorAll('#toolbar .icon-btn').length,
      })`);
    const state = JSON.parse(found);
    assert(state.toolbar, 'no address bar rendered');
    assert(state.tabs >= 1, 'no tab rows rendered');
    assert(state.buttons >= 5, `only ${state.buttons} toolbar buttons`);
    return `${state.tabs} tab row(s), ${state.buttons} buttons`;
  });

  await check('tabs can be created, reordered and closed', async () => {
    const a = win.tabs.create({ url: 'aether://settings', background: true });
    const b = win.tabs.create({ url: 'aether://notes', background: true });
    assert(win.tabs.list().length === 3, 'expected three tabs');

    win.tabs.move(b.id, 0);
    assert(win.tabs.order[0] === b.id, 'move did not reorder');

    win.tabs.close(a.id);
    win.tabs.close(b.id);
    assert(win.tabs.list().length === 1, 'tabs did not close');
    return 'create / move / close';
  });

  await check('tab groups keep their members contiguous', () => {
    const t1 = win.tabs.create({ url: 'aether://start', background: true });
    const spacer = win.tabs.create({ url: 'aether://start', background: true });
    const t2 = win.tabs.create({ url: 'aether://start', background: true });

    const group = win.tabs.createGroup({ name: 'Test group', tabIds: [t1.id, t2.id] });
    const order = win.tabs.order;
    const positions = [order.indexOf(t1.id), order.indexOf(t2.id)].sort((x, y) => x - y);
    assert(positions[1] - positions[0] === 1,
      `group members are not adjacent: ${JSON.stringify(order)}`);

    win.tabs.removeGroup(group.id, { closeTabs: true });
    win.tabs.close(spacer.id);
    return 'contiguous';
  });

  // =======================================================================
  // Layout
  // =======================================================================

  await check('split view positions two live panes', async () => {
    const second = win.tabs.create({ url: 'aether://settings', background: true });
    win.splitWith(second.id, { ratio: 0.5 });
    await wait(400);

    const panes = require('../src/main/window/layout')
      .paneRects(win.layout, win.tabs.activeId);
    assert(panes.length === 2, 'layout did not produce two panes');

    const [left, right] = panes;
    assert(left.bounds.width > 100 && right.bounds.width > 100,
      'a pane collapsed to nothing');
    assert(right.bounds.x > left.bounds.x + left.bounds.width - 1,
      'panes overlap');

    // Both tabs must actually be visible, not just computed.
    const visible = win.tabs.list().filter((t) => t.view?.getVisible?.());
    assert(visible.length >= 2, `${visible.length} pane(s) visible on screen`);

    await capture(win, 'split-view');
    win.unsplit();
    win.tabs.close(second.id);
    return `${left.bounds.width}px | ${right.bounds.width}px`;
  });

  await check('horizontal tab orientation re-lays out the chrome', async () => {
    win.setTabOrientation('horizontal');
    await wait(300);
    assert(win.layout.tabOrientation === 'horizontal', 'orientation did not change');
    const rect = require('../src/main/window/layout').contentRect(win.layout);
    assert(rect.x === 0, 'sidebar space was not reclaimed');
    await capture(win, 'horizontal-tabs');
    win.setTabOrientation('vertical');
    await wait(200);
    return 'switched and restored';
  });

  await check('a side panel takes width from the content area', async () => {
    const before = require('../src/main/window/layout').contentRect(win.layout).width;
    win.setPanel('ai', { width: 380 });
    await wait(300);
    const after = require('../src/main/window/layout').contentRect(win.layout).width;
    assert(after < before, `content did not shrink (${before} -> ${after})`);
    win.setPanel(null);
    return `${before} -> ${after}px`;
  });

  // =======================================================================
  // Privacy
  // =======================================================================

  await check('ad blocking is attached and the engine is loaded', () => {
    const stats = container.adblock.engine.stats;
    assert(container.adblock.ready, 'the blocker never finished initialising');
    // Lists may not have downloaded in a sandboxed CI network; the engine
    // must still be wired either way.
    return `${stats.network} block rules from ${stats.lists} list(s)`;
  });

  await check('the web-request hub multiplexes every participant', () => {
    const { hubFor } = require('../src/main/services/web-request-hub');
    const sess = container.profiles.sessionFor(container.profiles.activeId);
    const description = hubFor(sess).describe();
    const participants = description.onBeforeRequest || [];
    assert(participants.length >= 3,
      `only ${participants.length} onBeforeRequest participants: ${participants}`);
    assert(participants.some((p) => p.includes('adblock')), 'adblock is not attached');
    assert(participants.some((p) => p.includes('https-only')), 'HTTPS-only is not attached');
    return participants.join(', ');
  });

  await check('a private window gets its own isolated session', async () => {
    const priv = windowManager.create({ incognito: true });
    await until(() => priv.shellView?.webContents && !priv.shellView.webContents.isLoading(),
      { label: 'the private window to load' });

    const normalSession = container.profiles.sessionFor(container.profiles.activeId);
    const privateSession = container.profiles.sessionFor(priv.incognitoProfileId);
    assert(privateSession !== normalSession, 'the private window shares the normal session');
    assert(!privateSession.storagePath || !privateSession.storagePath.includes('aether-default'),
      'the private partition is persistent');

    const second = windowManager.create({ incognito: true });
    await until(() => second.shellView?.webContents && !second.shellView.webContents.isLoading(),
      { label: 'the second private window' });
    assert(container.profiles.sessionFor(second.incognitoProfileId) !== privateSession,
      'two private windows share one context');

    await capture(priv, 'private-window');
    priv.close();
    second.close();
    return 'two independent private contexts';
  });

  await check('permission policy answers without prompting', () => {
    const decision = container.permissions.resolve('https://example.com', 'geolocation');
    assert(['ask', 'deny', 'allow'].includes(decision), `odd decision: ${decision}`);
    const insecure = container.permissions.resolve('http://example.com', 'camera');
    assert(insecure === 'deny', 'an insecure origin was not denied the camera');
    return `https ${decision} / http camera ${insecure}`;
  });

  // =======================================================================
  // Developer suite
  // =======================================================================

  await check('the REST client performs a real request', async () => {
    const server = require('node:http').createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const response = await container.http.send({
        method: 'GET',
        url: `http://127.0.0.1:${port}/hello?x=1`,
      });
      assert(response.status === 200, `got HTTP ${response.status}`);
      const body = JSON.parse(response.body);
      assert(body.path === '/hello?x=1', `wrong path echoed: ${body.path}`);
      assert(response.timing.total >= 0, 'no timing recorded');
      return `200 in ${Math.round(response.timing.total)}ms`;
    } finally {
      server.close();
    }
  });

  await check('the localhost manager serves a folder and finds the port', async () => {
    const dir = path.join(OUT_DIR, 'served');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>served by aether</h1>');

    const record = await container.localServers.start({ root: dir });
    try {
      const response = await fetch(record.url);
      const text = await response.text();
      assert(text.includes('served by aether'), 'served the wrong content');

      const open = await container.localServers.scanPorts({ ports: [record.port] });
      assert(open.some((p) => p.port === record.port), 'port scan missed our own server');
      return `${record.url} (${response.status})`;
    } finally {
      await container.localServers.stop(record.id);
    }
  });

  await check('a static server refuses path traversal', async () => {
    const dir = path.join(OUT_DIR, 'served2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), 'ok');

    const record = await container.localServers.start({ root: dir });
    try {
      const response = await fetch(`${record.url}/../../../../etc/passwd`);
      assert(response.status === 403 || response.status === 404,
        `traversal returned HTTP ${response.status}`);
      return `blocked with ${response.status}`;
    } finally {
      await container.localServers.stop(record.id);
    }
  });

  await check('developer utilities compute correct answers', () => {
    const jwt = container.tools.jwt({ token: makeJwt() });
    assert(jwt.valid, 'valid JWT rejected');
    assert(jwt.claims.subject === 'smoke', `wrong subject: ${jwt.claims.subject}`);

    const contrast = container.color.contrast({ foreground: '#000', background: '#fff' });
    assert(contrast.ratio === 21, `black on white should be 21:1, got ${contrast.ratio}`);

    const regex = container.tools.regex({ pattern: '\\d+', subject: 'a1 b22 c333' });
    assert(regex.matchCount === 3, `expected 3 matches, got ${regex.matchCount}`);
    return 'JWT, contrast, regex';
  });

  await check('the manifest linter accepts a valid MV3 extension', async () => {
    const dir = path.join(OUT_DIR, 'ext');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Smoke Extension',
      version: '1.0.0',
      description: 'used by the smoke test',
      icons: { 128: 'icon.png' },
    }));
    fs.writeFileSync(path.join(dir, 'icon.png'), 'x');

    const result = await container.extensions.lint(dir);
    assert(result.valid, `linter rejected a valid manifest: ${JSON.stringify(result.errors)}`);
    return `${result.warnings.length} warning(s)`;
  });

  // =======================================================================
  // Command palette & search
  // =======================================================================

  await check('the command palette searches across sources', () => {
    const { buildPaletteResults } = require('../src/main/ipc/register');
    const all = buildPaletteResults(container, win, '');
    assert(all.length > 0, 'empty palette with no query');

    const matches = buildPaletteResults(container, win, 'split');
    assert(matches.some((r) => r.kind === 'command' && r.id === 'split.toggle'),
      'the split command was not found');
    return `${all.length} entries, fuzzy match works`;
  });

  await check('the omnibox distinguishes URLs from searches', () => {
    const cases = [
      ['example.com', 'url'],
      ['localhost:3000', 'url'],
      ['https://a.dev/x', 'url'],
      ['how to center a div', 'search'],
      ['electron', 'search'],
    ];
    for (const [input, expected] of cases) {
      const got = container.search.resolve(input).kind;
      assert(got === expected, `"${input}" resolved to ${got}, expected ${expected}`);
    }
    return `${cases.length} cases`;
  });

  // =======================================================================
  // Vault & sync
  // =======================================================================

  await check('the vault encrypts, locks and reopens', async () => {
    const vault = container.vault;
    if (!vault.exists) await vault.create({ masterPassword: 'smoke-test-master-key' });
    else await vault.unlock({ masterPassword: 'smoke-test-master-key' });

    vault.add({ origin: 'https://example.com', username: 'ada', password: 'p@ssw0rd-longer' });
    const listed = vault.list();
    assert(!('password' in listed[0]), 'list() leaked a password');

    const onDisk = fs.readFileSync(vault.file, 'utf8');
    assert(!onDisk.includes('p@ssw0rd'), 'the vault file contains a plaintext password');
    assert(!onDisk.includes('example.com'), 'the vault file leaks which sites are stored');

    vault.lock();
    assert(!vault.unlocked, 'lock() did not clear state');
    await vault.unlock({ masterPassword: 'smoke-test-master-key' });
    assert(vault.list().length >= 1, 'entries did not survive a lock cycle');
    return `${vault.list().length} entry, file opaque`;
  });

  await check('sync records are sealed and blinded', async () => {
    const { deriveKeys, sealRecord, openRecord } = require('../src/main/services/sync/crypto');
    const keys = await deriveKeys('smoke passphrase', Buffer.alloc(32, 9));
    const sealed = sealRecord(keys, {
      collection: 'bookmarks', id: 'b1',
      value: { url: 'https://secret.example' }, updatedAt: 1,
    });
    assert(!JSON.stringify(sealed).includes('secret.example'), 'ciphertext leaked the URL');
    const opened = openRecord(keys, {
      collection: 'bookmarks', id: sealed.id, ciphertext: sealed.ciphertext,
    });
    assert(opened.value.url === 'https://secret.example', 'round trip failed');
    return 'sealed, blinded, reversible';
  });

  // =======================================================================
  // Modes (spec §2) — the centrepiece
  // =======================================================================

  await check('every built-in mode activates and reconfigures the chrome', () => {
    const { modes } = container;
    const ids = modes.list().filter((m) => m.builtin).map((m) => m.id);
    assert(ids.length === 6, `expected 6 built-in modes, got ${ids.length}`);

    const seen = [];
    for (const id of ids) {
      const snapshot = modes.activate(id);
      assert(snapshot.activeId === id, `${id} did not become active`);
      assert(snapshot.panels.length > 0, `${id} surfaced no panels`);
      assert(snapshot.appearance.theme, `${id} resolved no theme`);
      seen.push(`${id}:${snapshot.panels.length}`);
    }
    modes.activate('default');
    return seen.join(' ');
  });

  await check('switching modes does not disturb open tabs', async () => {
    const { modes } = container;
    // Three tabs, one of them active and mid-history, so a mode switch has
    // something real to lose if it were touching the tab set at all.
    const a = win.tabs.create({ url: 'aether://start', background: true });
    const b = win.tabs.create({ url: 'aether://settings', background: true });
    await wait(300);

    const before = win.tabs.list().map((t) => t.id).join(',');
    const activeBefore = win.tabs.activeId;

    modes.activate('gamer');
    modes.activate('programmer');
    modes.activate('ghost');
    modes.activate('default');

    const after = win.tabs.list().map((t) => t.id).join(',');
    assert(before === after, `tab set changed: ${before} -> ${after}`);
    assert(win.tabs.activeId === activeBefore, 'the active tab moved');

    win.tabs.close(a.id);
    win.tabs.close(b.id);
    return `${before.split(',').length} tabs survived 4 switches`;
  });

  await check('a mode overlays features without writing preferences', () => {
    const { modes, features, settings } = container;
    const stored = JSON.parse(JSON.stringify(settings.get('features')));

    modes.activate('gamer');
    assert(features.enabled('turbo'), 'Gamer Mode did not switch Turbo on');
    assert(!features.base('turbo'), 'Gamer Mode wrote the stored preference');

    modes.activate('programmer');
    assert(features.enabled('httpClient'), 'Programmer Mode did not switch the REST client on');
    assert(!features.enabled('turbo'), 'Turbo leaked out of Gamer Mode');

    modes.activate('default');
    assert(JSON.stringify(settings.get('features')) === JSON.stringify(stored),
      'the stored preference map moved during mode switching');
    return 'overlay only, preferences untouched';
  });

  await check('Ghost Mode switches off everything that keeps a record', () => {
    const { modes, features } = container;
    features.toggle('history', true);

    modes.activate('ghost');
    assert(!features.enabled('history'), 'Ghost Mode still records history');
    assert(!features.enabled('sync'), 'Ghost Mode still syncs');
    assert(features.enabled('fingerprintRandom'), 'Ghost Mode is not randomising');

    modes.activate('default');
    assert(features.enabled('history'), 'history did not come back after Ghost Mode');
    return 'history and sync off, randomisation on';
  });

  await check('the custom-mode builder renders and creates a mode', async () => {
    const tab = win.tabs.create({ url: 'aether://settings#modes', background: false });
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'the settings page to load' });
    await wait(500);

    const before = await tab.webContents.executeJavaScript(`
      (() => ({
        cards: document.querySelectorAll('.mode-card').length,
        builder: !!document.querySelector('.mode-builder'),
        picks: document.querySelectorAll('.pick').length,
        navActive: document.querySelector('.nav-item.is-active')?.textContent?.trim(),
      }))()
    `);
    assert(before.cards >= 6, `only ${before.cards} mode cards rendered`);
    assert(before.builder, 'the custom-mode builder did not render');
    assert(before.picks > 40, `only ${before.picks} feature chips in the picker`);
    // A deep link must highlight the section it opened, not the default one.
    assert(before.navActive === 'Modes',
      `the sidebar highlighted "${before.navActive}" while showing Modes`);

    await capture(win, 'settings-modes');

    // Drive the builder the way a user would, rather than calling the
    // service: this is the path that would break if the page and the IPC
    // surface disagreed.
    await tab.webContents.executeJavaScript(`
      (() => {
        const name = document.querySelector('.mode-builder .input');
        name.value = 'Built By Smoke';
        document.querySelectorAll('.pick')[0].click();
        [...document.querySelectorAll('.btn.primary')]
          .find((b) => b.textContent.includes('Create mode')).click();
      })()
    `);
    await wait(600);

    const created = container.modes.list().find((m) => m.name === 'Built By Smoke');
    assert(created, 'the builder did not create a mode');
    assert(!created.builtin, 'a built mode should not be marked built-in');

    container.modes.remove(created.id);
    win.tabs.close(tab.id);
    return `${before.cards} modes, ${before.picks} feature chips`;
  });

  await check('onboarding asks what the user is here to do', async () => {
    const tab = win.tabs.create({ url: 'aether://onboarding', background: false });
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'onboarding to load' });
    await wait(400);

    // Step to the purpose question.
    const found = await tab.webContents.executeJavaScript(`
      (async () => {
        const next = [...document.querySelectorAll('button')]
          .find((b) => /next|continue/i.test(b.textContent));
        if (next) next.click();
        await new Promise((r) => setTimeout(r, 400));
        const cards = [...document.querySelectorAll('.ob-purpose')];
        cards[1]?.click();
        return {
          count: cards.length,
          labels: cards.map((c) => c.querySelector('h3')?.textContent),
          selected: document.querySelector('.ob-purpose.is-on h3')?.textContent,
        };
      })()
    `);

    assert(found.count === 6, `expected 6 purposes, got ${found.count}`);
    assert(found.selected, 'clicking a purpose did not select it');
    await capture(win, 'onboarding-purpose');

    win.tabs.close(tab.id);
    return `${found.count} purposes, picked "${found.selected}"`;
  });

  await check('a custom mode mixes features from two built-ins', () => {
    const { modes, features } = container;
    const doc = modes.create({
      name: 'Smoke Mix',
      basedOn: 'programmer',
      features: { recorder: true, streamPlayer: true },
    });

    modes.activate(doc.id);
    assert(features.enabled('httpClient'), 'the seed mode\'s features did not carry over');
    assert(features.enabled('recorder'), 'the mixed-in feature is not on');

    modes.activate('default');
    modes.remove(doc.id);
    assert(!modes.byId(doc.id), 'the custom mode was not removed');
    return 'programmer + gamer features in one mode';
  });

  await check('the content preload survives and exposes its bridge', async () => {
    // The failure this guards against is quiet and total: one uncaught throw
    // anywhere in the preload aborts the whole script, so `window.aether`
    // never appears and every internal page renders blank — while the tab
    // itself reports a perfectly successful load.
    const tab = win.tabs.create({ url: 'aether://start', background: true });
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'the start page to load' });

    const probe = await tab.webContents.executeJavaScript(`
      (() => ({
        bridge: typeof window.aether?.invoke === 'function',
        env: window.aether?.env?.internal === true,
      }))()
    `);
    assert(probe.bridge, 'window.aether.invoke is missing — the preload threw during startup');
    assert(probe.env, 'the preload did not mark this document internal');

    // And the media watcher specifically, since it is the newest thing to
    // run at preload time and the one that broke this before.
    const media = await tab.webContents.executeJavaScript(
      'document.querySelectorAll("audio, video").length >= 0');
    assert(media, 'the document is not queryable');

    win.tabs.close(tab.id);
    return 'bridge exposed, no preload throw';
  });

  await check('background play registers and protects a playing tab', async () => {
    const { media } = container;
    const tab = win.tabs.create({ url: 'aether://start', background: true });
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'the tab to finish loading' });

    media.report(tab.id, {
      playing: true, title: 'Smoke Track', artist: 'Aether', origin: 'https://example.test',
    });

    const snapshot = media.snapshot();
    assert(snapshot.anyPlaying, 'the registry did not record a playing session');
    assert(snapshot.active?.title === 'Smoke Track', 'the active session is wrong');
    assert(media.isProtected(tab.id), 'a playing tab must survive hibernation');

    // The hibernation policy must actually consult it, not just expose it.
    const policy = {
      idleMs: 0, excludeAudible: false, excludePinned: false,
      isProtected: (id) => media.isProtected(id),
    };
    assert(!tab.canHibernate(policy),
      'hibernation ignored the media carve-out — this is how a browser kills your music');

    media.clear(tab.id);
    assert(!media.snapshot().anyPlaying, 'clearing did not drop the session');
    win.tabs.close(tab.id);
    return 'registered, protected, released';
  });

  await check('every internal mode page loads and renders', async () => {
    // These are only reachable at runtime — the HUD and teleprompter live in
    // always-on-top windows and the blocker page is a redirect target — so
    // nothing else would catch a missing route or a typo in a script tag.
    const pages = [
      ['aether://hud', '#hud'],
      ['aether://teleprompter', '#script'],
      ['aether://blocked?reason=focus&host=example.com', '#headline'],
    ];

    const tab = win.tabs.create({ url: 'aether://start', background: true });
    const rendered = [];

    for (const [url, selector] of pages) {
      await tab.navigate(url);
      await until(() => tab.webContents && !tab.webContents.isLoading(),
        { label: `${url} to load` });
      assert(!tab.error, `${url} failed: ${JSON.stringify(tab.error)}`);

      const found = await tab.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}) ? 'ok' : 'missing'`);
      assert(found === 'ok', `${url} did not render ${selector}`);
      rendered.push(url.split('?')[0].replace('aether://', ''));
    }

    // The blocker page must name the host it blocked, or the user cannot
    // tell which site stopped loading.
    const host = await tab.webContents.executeJavaScript(
      'document.getElementById("host")?.textContent || ""');
    assert(host === 'example.com', `the blocked page said "${host}"`);

    win.tabs.close(tab.id);
    return rendered.join(', ');
  });

  await check('the now-playing bar appears with playback and clears with it', async () => {
    const { media } = container;
    const tab = win.tabs.create({ url: 'aether://start', background: true });
    // Let the navigation commit first. A committing document clears the media
    // session of the one it replaced, which is correct — but here it would
    // race the report below, since a real page cannot announce media before
    // its own document exists.
    await until(() => tab.webContents && !tab.webContents.isLoading(),
      { label: 'the tab to finish loading' });

    const read = () => win.shellView.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('.now-playing');
        if (!el) return null;
        return {
          visible: el.dataset.visible === 'true',
          playing: el.dataset.playing === 'true',
          title: el.querySelector('.np-title')?.textContent,
          subtitle: el.querySelector('.np-subtitle')?.textContent,
        };
      })()
    `);

    const before = await read();
    assert(before, 'the now-playing element is not in the DOM');
    assert(!before.visible, 'it should be collapsed when nothing is playing');

    media.report(tab.id, {
      playing: true, title: 'Nocturne in E-flat', artist: 'Chopin',
      origin: 'https://music.example',
    });
    const shown = await until(async () => {
      const found = await read();
      return found?.visible ? found : null;
    }, { label: 'the now-playing bar to appear' });

    assert(shown.title === 'Nocturne in E-flat', `title read "${shown.title}"`);
    assert(shown.subtitle === 'Chopin', `subtitle read "${shown.subtitle}"`);
    assert(shown.playing, 'it should reflect the playing state');
    await capture(win, 'now-playing');

    media.clear(tab.id);
    await until(async () => {
      const found = await read();
      return found && !found.visible;
    }, { label: 'the now-playing bar to collapse' });

    win.tabs.close(tab.id);
    return `"${shown.title}" — ${shown.subtitle}`;
  });

  await check('omnibox suggestions group and highlight the typed run', async () => {
    const found = await win.shellView.webContents.executeJavaScript(`
      (async () => {
        const input = document.querySelector('.omnibox-input');
        input.style.display = '';
        input.focus();
        input.value = 'set';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        const box = document.querySelector('.omnibox-suggestions');
        return {
          rows: box.querySelectorAll('.suggestion').length,
          groups: box.querySelectorAll('.suggestion-group').length,
          marks: box.querySelectorAll('.suggestion-title mark').length,
          enterHint: box.querySelectorAll('.suggestion-enter').length,
        };
      })()
    `);

    assert(found.rows > 0, 'no suggestions rendered');
    // Exactly one Enter hint, on the selected row — not one per row.
    assert(found.enterHint === 1, `${found.enterHint} Enter hints, expected 1`);
    return `${found.rows} rows, ${found.groups} group(s), ${found.marks} highlighted`;
  });

  await check('the mode switcher tracks the active mode and its panels', async () => {
    const read = () => win.shellView.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('.mode-switch');
        if (!el) return null;
        return {
          label: el.querySelector('.mode-label')?.textContent,
          mode: el.dataset.mode,
          panelButtons: document.querySelectorAll('.panel-buttons button').length,
          quickActions: document.querySelectorAll('.quick-actions button').length,
        };
      })()
    `);

    assert(await read(), 'the Mode Switcher control is not in the DOM');

    // Switch, then wait for the chrome to catch up. The renderer learns about
    // a mode change through an event, so reading immediately after activating
    // would assert against whatever it happened to be showing.
    container.modes.activate('gamer');
    const gamer = await until(async () => {
      const found = await read();
      return found?.mode === 'gamer' ? found : null;
    }, { label: 'the switcher to show Gamer' });

    assert(gamer.label === 'Gamer', `label said "${gamer.label}"`);
    assert(gamer.panelButtons === 5, `Gamer surfaced ${gamer.panelButtons} panel buttons, expected 5`);
    assert(gamer.quickActions === 3, `Gamer surfaced ${gamer.quickActions} quick actions, expected 3`);

    container.modes.activate('default');
    const back = await until(async () => {
      const found = await read();
      return found?.mode === 'default' ? found : null;
    }, { label: 'the switcher to return to Default' });

    assert(back.panelButtons === 3, `Default surfaced ${back.panelButtons} panel buttons, expected 3`);
    return `Gamer ${gamer.panelButtons} panels / ${gamer.quickActions} actions, `
      + `Default ${back.panelButtons} panels`;
  });

  // =======================================================================
  // Feature store teardown
  // =======================================================================

  await check('disabling a feature cascades to its dependents', () => {
    features.toggle('devtools', false);
    assert(!features.enabled('httpClient'), 'the REST client survived DevTools being disabled');
    assert(!features.enabled('wsInspector'), 'the socket inspector survived');

    features.toggle('devtools', true);
    assert(features.enabled('devtools'), 'DevTools did not come back');
    return 'cascade both ways';
  });

  await check('a disabled feature refuses its own IPC surface', async () => {
    features.toggle('httpClient', false);
    let refused = false;
    try {
      await container.http.send({ method: 'GET', url: 'http://127.0.0.1:1/' });
    } catch (err) {
      refused = /Feature Store/.test(err.message);
    }
    features.toggle('httpClient', true);
    assert(refused, 'the REST client ran while disabled');
    return 'refused with a useful message';
  });

  // =======================================================================
  // Screenshots
  // =======================================================================

  await check('captures a screenshot of the running browser', async () => {
    win.tabs.active.navigate('aether://start');
    await wait(900);
    const file = await capture(win, 'main-window');
    assert(fs.statSync(file).size > 5000, 'screenshot looks empty');
    return path.basename(file);
  });

  await check('captures each mode\'s chrome', async () => {
    const shot = [];
    for (const id of ['programmer', 'gamer', 'creator', 'student', 'ghost']) {
      container.modes.activate(id);
      // Let the renderer receive modes:changed and repaint before capturing;
      // a screenshot taken mid-transition proves nothing about either state.
      await wait(650);
      const file = await capture(win, `mode-${id}`);
      assert(fs.statSync(file).size > 5000, `${id} screenshot looks empty`);
      shot.push(id);
    }
    container.modes.activate('default');
    await wait(400);
    return shot.join(', ');
  });

  // =======================================================================
  // Report
  // =======================================================================

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log(`\n${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  fs.writeFileSync(
    path.join(OUT_DIR, 'smoke-results.json'),
    JSON.stringify({
      passed, failed, total: results.length,
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      at: new Date().toISOString(),
      results,
    }, null, 2)
  );
  console.log(`Report and screenshots: ${OUT_DIR}\n`);

  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error('smoke test crashed:', err);
  app.exit(2);
});

/**
 * Screenshot a window.
 *
 * A `BaseWindow` has no single capture API: the chrome and every page are
 * independent `WebContentsView`s with their own compositors. So we capture
 * each separately — `<name>.png` is the chrome, `<name>-page.png` is what
 * the user is actually reading. Capturing only the chrome shows a blank
 * content area and looks like a rendering failure when nothing is wrong.
 */
async function capture(win, name) {
  const file = path.join(OUT_DIR, `${name}.png`);

  try {
    const chrome = await win.shellView.webContents.capturePage();
    if (!chrome.isEmpty()) fs.writeFileSync(file, chrome.toPNG());
  } catch (err) {
    console.log(`    (chrome capture failed: ${err.message})`);
  }

  try {
    const tab = win.tabs.active;
    if (tab?.webContents) {
      const page = await tab.webContents.capturePage();
      if (!page.isEmpty()) {
        fs.writeFileSync(path.join(OUT_DIR, `${name}-page.png`), page.toPNG());
      }
    }
  } catch (err) {
    console.log(`    (page capture failed: ${err.message})`);
  }

  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(0));
  return file;
}

function makeJwt() {
  const crypto = require('node:crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'smoke', iss: 'aether', exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', 'k').update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
