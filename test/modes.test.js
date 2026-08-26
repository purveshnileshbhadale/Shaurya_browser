'use strict';
/**
 * Mode resolution.
 *
 * The property under test throughout is that a mode is an *overlay*: it
 * changes the answers `features.enabled()` gives while it is active, and
 * leaves the user's stored preferences exactly as it found them. If that
 * ever stops holding, a round trip through Gamer Mode silently rewrites
 * someone's configuration, which is the worst kind of bug — invisible until
 * they go looking for a setting they never changed.
 */
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const { FeatureStore } = require('../src/main/services/feature-store');
const { ModeService, BUILTIN_MODES } = require('../src/main/services/modes');

/** A settings service with the same surface, backed by a plain object. */
class FakeSettings extends EventEmitter {
  constructor(seed = {}) {
    super();
    this.data = {
      appearance: { theme: 'system', accent: '#6C8CFF', density: 'comfortable', animations: true },
      modes: { active: 'default', custom: [], overrides: {}, lastUsed: {} },
      features: {},
      ...seed,
    };
  }

  get(path) {
    if (!path) return this.data;
    return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = this.data;
    for (const k of keys) {
      if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[last] = value;
    this.emit('changed', { path, value });
    return value;
  }
}

function build(seed) {
  const settings = new FakeSettings(seed);
  const features = new FeatureStore(settings);
  const modes = new ModeService(settings, features);
  return { settings, features, modes };
}

// ---------------------------------------------------------------------------

test('default mode has no overlay: the stored preference wins', () => {
  const { features, modes } = build();

  assert.equal(modes.activeId(), 'default');
  assert.equal(modes.resolveFeature('turbo'), undefined,
    'Default must express no opinion, or it is not "the browser as you configured it"');
  assert.equal(features.enabled('turbo'), false);
  assert.equal(features.enabled('adblock'), true);
});

test('a mode overlays features without writing the stored preference', () => {
  const { settings, features, modes } = build();

  const before = JSON.parse(JSON.stringify(settings.get('features')));
  assert.equal(features.enabled('turbo'), false);

  modes.activate('gamer');
  assert.equal(features.enabled('turbo'), true, 'Gamer Mode turns Turbo on');
  assert.equal(features.base('turbo'), false, 'but the stored preference is untouched');
  assert.deepEqual(settings.get('features'), before,
    'no key in the stored preference map may move on a mode switch');

  modes.activate('default');
  assert.equal(features.enabled('turbo'), false, 'and leaving the mode restores the answer');
});

test('switching away and back restores the user preferences exactly', () => {
  const { settings, features, modes } = build();

  // The user makes a deliberate choice in Default.
  features.toggle('extensionDev', true);
  features.toggle('gestures', false);
  const snapshot = JSON.parse(JSON.stringify(settings.get('features')));

  modes.activate('programmer');
  modes.activate('gamer');
  modes.activate('default');

  assert.deepEqual(settings.get('features'), snapshot);
  assert.equal(features.enabled('extensionDev'), true);
  assert.equal(features.enabled('gestures'), false);
});

test('toggling inside a mode records a per-mode override, not a preference', () => {
  const { settings, features, modes } = build();

  modes.activate('gamer');
  assert.equal(features.enabled('recorder'), true);
  const stored = JSON.parse(JSON.stringify(settings.get('features')));

  // One toggle in each direction, so the assertion below is sharp: turning
  // `extensionDev` on moves the resolved answer away from *both* the stored
  // preference (false) and the mode's own overlay (false).
  features.toggle('recorder', false);
  features.toggle('extensionDev', true);

  assert.equal(features.enabled('recorder'), false, 'the mode honours the change');
  assert.equal(features.enabled('extensionDev'), true);
  assert.equal(features.base('extensionDev'), false,
    'while the stored preference stays where the user left it');
  assert.deepEqual(settings.get('features'), stored,
    'not one key of the stored preference map may move on a toggle inside a mode');
  assert.deepEqual(settings.get('modes.overrides').gamer,
    { recorder: false, extensionDev: true });

  modes.activate('programmer');
  modes.activate('gamer');
  assert.equal(features.enabled('recorder'), false, 'the override survives a round trip');

  modes.resetOverrides('gamer');
  assert.equal(features.enabled('recorder'), true, 'and reset returns to the preset');
});

test('toggling in Default still writes the preference, as it did before modes', () => {
  const { settings, features, modes } = build();

  assert.equal(modes.activeId(), 'default');
  features.toggle('sync', true);

  assert.equal(settings.get('features').sync, true);
  assert.deepEqual(settings.get('modes.overrides'), {},
    'Default must not accumulate overrides, or it stops being the base layer');
});

test('dependency cascades are computed against resolved values', () => {
  const { features, modes } = build();

  modes.activate('programmer');
  // Programmer Mode switches devtools on via overlay; the REST client
  // depends on it, so enabling the client must not think the dep is missing.
  assert.equal(features.enabled('devtools'), true);
  features.toggle('httpClient', true);
  assert.equal(features.enabled('httpClient'), true);

  // Turning the dependency off must push its dependents down with it.
  features.toggle('devtools', false);
  assert.equal(features.enabled('httpClient'), false,
    'a dependent cannot stay on when its requirement went off');
});

test('appearance merges mode over user, but reduced motion always wins', () => {
  const { modes } = build({
    appearance: { theme: 'light', accent: '#ff0000', density: 'comfortable', animations: false },
  });

  const plain = modes.appearanceFor('default');
  assert.equal(plain.theme, 'light', 'Default overrides nothing');
  assert.equal(plain.accent, '#ff0000');

  const dev = modes.appearanceFor('programmer');
  assert.equal(dev.theme, 'dark', 'the mode supplies presentation');
  assert.equal(dev.density, 'compact');
  assert.equal(dev.monoUi, true);
  assert.equal(dev.animations, false,
    'a user who asked for reduced motion keeps it inside every mode');
});

test('appearance is never written back to settings', () => {
  const { settings, modes } = build();

  const before = JSON.parse(JSON.stringify(settings.get('appearance')));
  modes.activate('gamer');
  modes.appearanceFor();
  modes.activate('default');

  assert.deepEqual(settings.get('appearance'), before);
});

test('custom modes mix features from the built-ins and stand alone', () => {
  const { features, modes } = build();

  const doc = modes.create({
    name: 'Stream & Ship',
    basedOn: 'programmer',
    features: { recorder: true, streamPlayer: true },
  });

  assert.equal(doc.builtin, false);
  assert.equal(doc.basedOn, 'programmer');
  assert.equal(doc.features.httpClient, true, 'inherited from the seed');
  assert.equal(doc.features.recorder, true, 'mixed in from the other mode');

  modes.activate(doc.id);
  assert.equal(features.enabled('recorder'), true);
  assert.equal(features.enabled('httpClient'), true);

  // Independence: the seed is a starting point, not a live parent.
  const programmer = BUILTIN_MODES.find((m) => m.id === 'programmer');
  assert.equal(programmer.features.recorder, false,
    'creating a custom mode must not mutate the built-in it copied');
});

test('a custom mode id is unique and slugged', () => {
  const { modes } = build();
  const a = modes.create({ name: 'My Mode' });
  const b = modes.create({ name: 'My Mode' });
  assert.equal(a.id, 'my-mode');
  assert.equal(b.id, 'my-mode-2');
});

test('built-in modes cannot be edited or removed', () => {
  const { modes } = build();
  assert.throws(() => modes.update('gamer', { name: 'Nope' }), /built-in/);
  assert.throws(() => modes.remove('programmer'), /built-in/);
});

test('duplicating a built-in folds in the user overrides', () => {
  const { features, modes } = build();

  modes.activate('gamer');
  features.toggle('rgbTheme', false);

  const copy = modes.duplicate('gamer', 'Calm Gamer');
  assert.equal(copy.features.rgbTheme, false,
    'the copy should capture what the user actually had, not the bare preset');
  assert.equal(copy.features.turbo, true);
});

test('removing the active custom mode falls back to Default', () => {
  const { features, modes } = build();

  const doc = modes.create({ name: 'Temp', basedOn: 'gamer' });
  modes.activate(doc.id);
  assert.equal(features.enabled('turbo'), true);

  modes.remove(doc.id);
  assert.equal(modes.activeId(), 'default');
  assert.equal(features.enabled('turbo'), false);
});

test('a deleted mode left dangling in settings resolves to Default', () => {
  const { modes } = build({
    modes: { active: 'deleted-long-ago', custom: [], overrides: {}, lastUsed: {} },
  });
  assert.equal(modes.activeId(), 'default',
    'pointing at a document that no longer exists must not brick the switcher');
});

test('activate reports the switch and is idempotent', () => {
  const { modes } = build();
  let events = 0;
  modes.on('changed', () => { events += 1; });

  modes.activate('gamer');
  assert.equal(events, 1);
  modes.activate('gamer');
  assert.equal(events, 1, 're-activating the current mode should not churn the UI');
});

test('every built-in mode overlay names a feature that actually exists', () => {
  const { CATALOG } = require('../src/main/services/feature-store');
  const known = new Set(CATALOG.map((f) => f.id));

  for (const mode of BUILTIN_MODES) {
    for (const id of Object.keys(mode.features || {})) {
      assert.ok(known.has(id),
        `mode "${mode.id}" overlays unknown feature "${id}" — it would silently do nothing`);
    }
  }
});

test('every built-in mode is reachable and resolves an appearance', () => {
  const { modes } = build();
  for (const mode of BUILTIN_MODES) {
    const snap = modes.activate(mode.id);
    assert.equal(snap.activeId, mode.id);
    assert.ok(snap.appearance.theme, `${mode.id} must resolve a theme`);
    assert.ok(Array.isArray(snap.panels) && snap.panels.length,
      `${mode.id} must surface at least one panel`);
  }
});

test('ghost mode turns off everything that keeps a record', () => {
  const { features, modes } = build();

  // Deliberately switch these on first, so the assertion proves the mode
  // overrides a live preference rather than merely agreeing with a default.
  features.toggle('history', true);
  features.toggle('sync', true);
  assert.equal(features.enabled('history'), true);

  modes.activate('ghost');
  assert.equal(features.enabled('history'), false,
    'a Ghost window that wrote history would be worse than none, because it is trusted');
  assert.equal(features.enabled('sync'), false);
  assert.equal(features.enabled('tor'), true);
  assert.equal(features.enabled('fingerprintRandom'), true);

  modes.activate('default');
  assert.equal(features.enabled('history'), true, 'and the user gets their history back');
});

test('the snapshot carries panels, behaviors and no raw feature maps', () => {
  const { modes } = build();
  modes.activate('gamer');
  const snap = modes.snapshot();

  assert.equal(snap.activeId, 'gamer');
  assert.deepEqual(snap.panels, ['stream', 'games', 'deals', 'perf', 'ai']);
  assert.equal(snap.behaviors.aggressiveHibernate, true);
  assert.ok(snap.modes.every((m) => m.features === undefined),
    'the switcher list only needs identity, not every mode\'s full overlay');
});

test('feature list marks which switches a mode is driving', () => {
  const { features, modes } = build();

  modes.activate('gamer');
  const byId = Object.fromEntries(features.list().map((f) => [f.id, f]));

  assert.equal(byId.turbo.source, 'mode');
  assert.equal(byId.turbo.enabled, true);
  assert.equal(byId.adblock.source, 'preference',
    'a feature the mode says nothing about is still the user\'s own');
});
