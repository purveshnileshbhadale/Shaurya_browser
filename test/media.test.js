'use strict';
/**
 * Background playback.
 *
 * The registry decides three things that are easy to get subtly wrong: which
 * artwork to fetch, which tab owns the media keys, and which tabs are safe to
 * suspend. The last one is the expensive mistake — getting it wrong kills the
 * track someone was listening to.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const { pickArtwork } = require('../src/main/services/media');

// ---- artwork --------------------------------------------------------------

test('artwork picks the size closest to the render size, not the largest', () => {
  const chosen = pickArtwork([
    { src: 'tiny.png', sizes: '96x96' },
    { src: 'right.png', sizes: '192x192' },
    { src: 'huge.png', sizes: '1024x1024' },
  ]);
  assert.equal(chosen, 'right.png',
    'downloading a 1024px cover to draw it at 40px is waste, and 96px is blurry at 2x');
});

test('artwork falls back sensibly when sizes are missing or odd', () => {
  assert.equal(pickArtwork([{ src: 'only.png' }]), 'only.png');
  assert.equal(pickArtwork([{ src: 'a.png', sizes: 'any' }]), 'a.png');
  assert.equal(pickArtwork([]), null);
  assert.equal(pickArtwork(null), null);
  assert.equal(pickArtwork([{ sizes: '192x192' }]), null, 'an entry with no src is unusable');
});

test('artwork prefers 256 over 96 when 192 is absent', () => {
  const chosen = pickArtwork([
    { src: 'small.png', sizes: '96x96' },
    { src: 'big.png', sizes: '256x256' },
  ]);
  assert.equal(chosen, 'big.png', '256 is 64 away from 192; 96 is 96 away');
});

// ---- registry -------------------------------------------------------------

/**
 * Build a MediaService with the Electron surface stubbed.
 *
 * `powerSaveBlocker` and `globalShortcut` are process-wide singletons, so the
 * module is loaded through a cache-busting shim rather than mutating the real
 * ones — a test that bound the hardware media keys would steal play/pause
 * from whatever else is running on the machine.
 */
function build({ backgroundPlay = true } = {}) {
  const calls = { throttling: [], blocker: [], keys: [] };

  const features = {
    enabled: (id) => (id === 'backgroundPlay' ? backgroundPlay : true),
  };
  const settings = {
    get: (path) => (path === 'media'
      ? { mediaKeys: true, preventSuspend: true, pausedGraceMinutes: 5 }
      : undefined),
  };

  const tabs = new Map();
  const windowManager = {
    locateTabById: (id) => (tabs.has(id) ? { tab: tabs.get(id), window: {} } : null),
    list: () => [],
  };

  const makeTab = (id) => {
    const tab = {
      id,
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (v) => calls.throttling.push([id, v]),
      },
    };
    tabs.set(id, tab);
    return tab;
  };

  // Load with the Electron singletons replaced.
  const path = require.resolve('../src/main/services/media');
  delete require.cache[path];
  const electronPath = require.resolve('electron');
  const realElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      powerSaveBlocker: {
        start: () => { calls.blocker.push('start'); return 42; },
        stop: () => { calls.blocker.push('stop'); },
      },
      globalShortcut: {
        register: (a) => { calls.keys.push(['register', a]); },
        unregister: (a) => { calls.keys.push(['unregister', a]); },
      },
    },
  };

  const { MediaService } = require(path);
  const media = new MediaService({ settings, features, content: new EventEmitter() });
  media.attach(windowManager);

  // Restore, so nothing else in the suite sees the stub.
  if (realElectron) require.cache[electronPath] = realElectron;
  else delete require.cache[electronPath];
  delete require.cache[path];

  return { media, calls, makeTab };
}

test('a playing tab is exempted from background throttling', () => {
  const { media, calls, makeTab } = build();
  makeTab('tab-1');

  media.report('tab-1', { playing: true, title: 'Track' });

  assert.deepEqual(calls.throttling.at(-1), ['tab-1', false],
    'Chromium throttles background timers, which stalls the site\'s own player');
});

test('pausing restores throttling', () => {
  const { media, calls, makeTab } = build();
  makeTab('tab-1');

  media.report('tab-1', { playing: true, title: 'Track' });
  media.report('tab-1', { playing: false, title: 'Track' });

  assert.deepEqual(calls.throttling.at(-1), ['tab-1', true]);
});

test('the wake lock is held only while something is playing', () => {
  const { media, calls, makeTab } = build();
  makeTab('tab-1');

  media.report('tab-1', { playing: true, title: 'Track' });
  assert.ok(calls.blocker.includes('start'));
  assert.equal(media.snapshot().holdingWakeLock, true);

  media.report('tab-1', { playing: false, title: 'Track' });
  assert.ok(calls.blocker.includes('stop'));
  assert.equal(media.snapshot().holdingWakeLock, false);
});

test('media keys are bound only while a session exists', () => {
  const { media, calls, makeTab } = build();
  makeTab('tab-1');

  assert.equal(media.snapshot().mediaKeysBound, false,
    'holding the media keys permanently would steal play/pause from Spotify');

  media.report('tab-1', { playing: true, title: 'Track' });
  assert.equal(media.snapshot().mediaKeysBound, true);
  assert.ok(calls.keys.some(([verb, key]) => verb === 'register' && key === 'MediaPlayPause'));

  media.clear('tab-1');
  assert.equal(media.snapshot().mediaKeysBound, false);
  assert.ok(calls.keys.some(([verb]) => verb === 'unregister'));
});

test('a playing tab is protected from hibernation', () => {
  const { media, makeTab } = build();
  makeTab('tab-1');

  media.report('tab-1', { playing: true, title: 'Track' });
  assert.equal(media.isProtected('tab-1'), true);
  assert.equal(media.isProtected('tab-other'), false);
});

test('a recently paused tab keeps its reprieve, an old one does not', () => {
  const { media, makeTab } = build();
  makeTab('tab-1');

  media.report('tab-1', { playing: false, title: 'Podcast' });
  assert.equal(media.isProtected('tab-1'), true,
    'suspending a paused podcast loses the position, which is the thing the listener cared about');

  // Age the record past the grace period.
  media.sessions.get('tab-1').updatedAt = Date.now() - 10 * 60_000;
  assert.equal(media.isProtected('tab-1'), false,
    'a tab paused half an hour ago is an ordinary tab again');
});

test('protection is off entirely when the feature is off', () => {
  const { media, makeTab } = build({ backgroundPlay: false });
  makeTab('tab-1');

  media.report('tab-1', { playing: true, title: 'Track' });
  assert.equal(media.isProtected('tab-1'), false);
});

test('the most recently started session owns the media keys', () => {
  const { media, makeTab } = build();
  makeTab('tab-1');
  makeTab('tab-2');

  media.report('tab-1', { playing: true, title: 'First' });
  assert.equal(media.snapshot().activeId, 'tab-1');

  media.report('tab-2', { playing: true, title: 'Second' });
  assert.equal(media.snapshot().activeId, 'tab-2',
    'starting a new track is when a user reaches for the play button');
});

test('closing the active session hands the keys to whatever still plays', () => {
  const { media, makeTab } = build();
  makeTab('tab-1');
  makeTab('tab-2');

  media.report('tab-1', { playing: true, title: 'First' });
  media.report('tab-2', { playing: true, title: 'Second' });
  media.clear('tab-2');

  assert.equal(media.snapshot().activeId, 'tab-1');

  media.clear('tab-1');
  assert.equal(media.snapshot().activeId, null);
});

test('the snapshot sorts playing sessions first', () => {
  const { media, makeTab } = build();
  makeTab('a'); makeTab('b');

  media.report('a', { playing: false, title: 'Paused' });
  media.report('b', { playing: true, title: 'Playing' });

  const { sessions } = media.snapshot();
  assert.equal(sessions[0].title, 'Playing');
  assert.equal(media.snapshot().anyPlaying, true);
});

test('reported strings are bounded so a page cannot bloat the chrome', () => {
  const { media, makeTab } = build();
  makeTab('a');

  media.report('a', { playing: true, title: 'x'.repeat(5000), artist: 'y'.repeat(5000) });
  const session = media.snapshot().sessions[0];

  assert.equal(session.title.length, 200);
  assert.equal(session.artist.length, 200);
});

test('a control call for a vanished tab fails cleanly and drops the session', async () => {
  const { media, makeTab } = build();
  makeTab('gone');
  media.report('gone', { playing: true, title: 'Track' });

  // Simulate the tab disappearing without a clear().
  media.windowManager.locateTabById = () => null;

  const result = await media.control('pause');
  assert.equal(result.ok, false);
  assert.match(result.reason, /gone/);
  assert.equal(media.sessions.size, 0, 'the stale session should not linger');
});

test('control with nothing playing is refused rather than throwing', async () => {
  const { media } = build();
  const result = await media.control('playpause');
  assert.equal(result.ok, false);
  assert.match(result.reason, /nothing is playing/);
});
