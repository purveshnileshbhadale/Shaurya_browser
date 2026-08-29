'use strict';
/**
 * The blocker's lifecycle: acquiring lists, rebuilding, and what happens
 * when the network is not there.
 *
 * These cover the failure that is invisible from the inside. Every rule in
 * the matcher can be correct and the browser can still block nothing,
 * because the rules never arrived — and the symptom, a shield reading zero,
 * is exactly what a genuinely clean page looks like.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Load the service against a throwaway profile, with `request` stubbed. */
function load({ respond }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-adblock-'));
  process.env.AETHER_USER_DATA = root;

  const netPath = require.resolve('../src/main/util/net');
  const servicePath = require.resolve('../src/main/services/adblock');
  const pathsPath = require.resolve('../src/main/util/paths');

  for (const p of [netPath, servicePath, pathsPath]) delete require.cache[p];

  const calls = [];
  require.cache[netPath] = {
    id: netPath,
    filename: netPath,
    loaded: true,
    exports: {
      request: async (url) => {
        calls.push(url);
        return respond(url);
      },
    },
  };

  const { AdblockService } = require(servicePath);
  const settings = {
    _data: { 'privacy.adblock': true },
    get(key) { return key ? this._data[key] : this._data; },
    set(key, value) { this._data[key] = value; },
  };
  const features = { enabled: () => true };

  const service = new AdblockService(settings, features);
  return { service, calls, root, cleanup: () => {
    delete require.cache[netPath];
    delete require.cache[servicePath];
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.AETHER_USER_DATA;
  } };
}

/** A body that passes the structural filter-list sniff. */
function listBody(rule = '||tracker.example^') {
  return `[Adblock Plus 2.0]\n! Title: stub\n${
    Array.from({ length: 30 }, (_, i) => `||stub-${i}.example^`).join('\n')
  }\n${rule}\n`;
}

const ok = (body) => ({ status: 200, body: Buffer.from(body) });

// ---- the bundled seed -----------------------------------------------------

test('a fresh profile with nothing downloaded still blocks the big trackers', async () => {
  const { service, cleanup } = load({ respond: () => { throw new Error('offline'); } });
  try {
    await service.rebuild();

    assert.equal(service.usingSeed, true, 'should have fallen back to the seed');
    assert.ok(service.engine.stats.network > 20,
      `only ${service.engine.stats.network} seed rules loaded`);

    const verdict = service.engine.match({
      url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
      sourceUrl: 'https://news.example.org/',
      type: 'script',
    });
    assert.ok(verdict.block,
      'a brand-new install must not be completely defenceless while it downloads');
  } finally {
    cleanup();
  }
});

test('the seed steps aside as soon as a real list is cached', async () => {
  const { service, cleanup } = load({ respond: () => ok(listBody()) });
  try {
    await service.updateLists();
    assert.equal(service.usingSeed, false, 'a downloaded list must supersede the seed');
    assert.ok(service.engine.match({
      url: 'https://tracker.example/pixel.gif',
      sourceUrl: 'https://news.example.org/',
      type: 'image',
    }).block, 'the downloaded rules are not in the index');
  } finally {
    cleanup();
  }
});

// ---- the twelve-hour hole -------------------------------------------------

test('a wholly failed update does not stamp the clock', async () => {
  // The bug this guards: stamping unconditionally makes `init()` treat the
  // lists as fresh, so a browser that has never downloaded a single rule
  // waits twelve hours before trying again — blocking nothing, reporting
  // nothing wrong.
  const { service, cleanup } = load({ respond: () => { throw new Error('ENOTFOUND'); } });
  try {
    const before = service.listStore.data.lastUpdate;
    const results = await service.updateLists();

    assert.ok(results.every((r) => !r.ok), 'the stub should have failed every fetch');
    assert.equal(service.listStore.data.lastUpdate, before,
      'a failed update must not look like a successful one');
  } finally {
    cleanup();
  }
});

test('a partial success does stamp the clock', async () => {
  let n = 0;
  const { service, cleanup } = load({
    respond: () => {
      n += 1;
      if (n === 1) return ok(listBody());
      throw new Error('ENOTFOUND');
    },
  });
  try {
    const results = await service.updateLists();
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(service.listStore.data.lastUpdate > 0,
      'getting some lists is an update; refusing to record it would retry forever');
  } finally {
    cleanup();
  }
});

test('an HTML error page is refused rather than indexed as rules', async () => {
  // A captive portal answers 200 with a login page for every request. Saving
  // that would replace a real list with zero rules and look like a success.
  const { service, cleanup } = load({
    respond: () => ok('<!doctype html><html><body>Sign in to continue</body></html>'),
  });
  try {
    const results = await service.updateLists();
    assert.ok(results.every((r) => !r.ok), 'a login page is not a filter list');
    assert.equal(service.listStore.data.lastUpdate, 0);
  } finally {
    cleanup();
  }
});

// ---- rebuilding without a gap --------------------------------------------

test('the index never goes empty while it is being rebuilt', async () => {
  const { service, cleanup } = load({ respond: () => ok(listBody()) });
  try {
    await service.updateLists();
    const before = service.engine;
    assert.ok(before.stats.network > 0);

    // Rebuilding in place would clear this engine and spend real time
    // reparsing, and every request arriving in that window would go
    // unfiltered. Holding a reference across the rebuild proves the live
    // index was replaced rather than emptied.
    const rebuilding = service.rebuild();
    assert.ok(service.engine.stats.network > 0,
      'the live index was emptied mid-rebuild — requests would sail through');
    await rebuilding;

    assert.ok(service.engine.stats.network > 0);
    assert.notStrictEqual(service.engine, before, 'the new index should be swapped in');
  } finally {
    cleanup();
  }
});

test('disabling every list falls back to the seed rather than to nothing', async () => {
  const { service, cleanup } = load({ respond: () => ok(listBody()) });
  try {
    await service.updateLists();
    for (const list of service.listStore.data.lists) list.enabled = false;
    await service.rebuild();

    assert.equal(service.usingSeed, true);
    assert.ok(service.engine.stats.network > 20,
      'turning off subscriptions should not leave an empty index');
  } finally {
    cleanup();
  }
});

// ---- what the UI is told -------------------------------------------------

test('stats say when protection is only the seed', async () => {
  const { service, cleanup } = load({ respond: () => { throw new Error('offline'); } });
  try {
    await service.rebuild();
    assert.equal(service.statsForTab(1).seedOnly, true,
      'a bare zero on the shield reads as "this page is clean", which is the '
      + 'opposite of what is happening');

    service.usingSeed = false;
    assert.equal(service.statsForTab(1).seedOnly, false);
  } finally {
    cleanup();
  }
});
