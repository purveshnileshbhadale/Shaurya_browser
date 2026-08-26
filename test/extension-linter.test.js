'use strict';
/**
 * Manifest linter tests.
 *
 * The value of the linter is catching the V2->V3 leftovers that load without
 * error and then silently do nothing — the class of bug that costs an
 * extension developer an afternoon.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AETHER_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-ext-'));
const { ExtensionService } = require('../src/main/services/extensions');

/** Build a throwaway extension directory. */
function scaffold(manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  if (manifest !== null) {
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2));
  }
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

function makeService() {
  return new ExtensionService(
    { get: () => false, set: () => {} },
    { enabled: () => true },
    {}
  );
}

const VALID = {
  manifest_version: 3,
  name: 'Test Extension',
  version: '1.0.0',
  description: 'A well-formed MV3 extension',
  icons: { 128: 'icon128.png' },
  action: { default_popup: 'popup.html', default_icon: { 16: 'icon128.png' } },
  background: { service_worker: 'sw.js' },
  content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
  permissions: ['storage'],
  host_permissions: ['https://example.com/*'],
};

const VALID_FILES = {
  'icon128.png': 'x',
  'popup.html': '<!doctype html>',
  'sw.js': '// worker',
  'content.js': '// content',
};

test('a well-formed MV3 extension passes cleanly', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold(VALID, VALID_FILES));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.manifest.name, 'Test Extension');
});

test('a missing manifest is reported, not thrown', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold(null));
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /no manifest\.json/);
});

test('invalid JSON is reported with the parser message', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold('{ "name": "broken", }'));
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /invalid JSON/);
});

test('Manifest V2 is called out specifically', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold({ ...VALID, manifest_version: 2 }, VALID_FILES));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Manifest V2 is no longer accepted/.test(e.message)));
});

test('V2 leftovers that silently do nothing under V3 are errors', async () => {
  const svc = makeService();
  const dir = scaffold({
    manifest_version: 3,
    name: 'Legacy bits',
    version: '1.0',
    background: { scripts: ['bg.js'] },
    browser_action: { default_title: 'x' },
    web_accessible_resources: ['injected.js'],
    content_security_policy: "script-src 'self'",
  }, { 'bg.js': '', 'injected.js': '' });

  const result = await svc.lint(dir);
  assert.equal(result.valid, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('background.scripts'), 'service_worker migration');
  assert.ok(fields.includes('browser_action'), 'action merge');
  assert.ok(fields.includes('web_accessible_resources'), 'object form required');
  assert.ok(fields.includes('content_security_policy'), 'object form required');
});

test('files referenced but not present are errors', async () => {
  const svc = makeService();
  // Everything declared, nothing written to disk.
  const result = await svc.lint(scaffold(VALID));
  assert.equal(result.valid, false);
  const missing = result.errors.filter((e) => e.field === 'files').map((e) => e.message);
  assert.ok(missing.some((m) => m.includes('sw.js')));
  assert.ok(missing.some((m) => m.includes('content.js')));
  assert.ok(missing.some((m) => m.includes('popup.html')));
});

test('bad match patterns are caught', async () => {
  const svc = makeService();
  const dir = scaffold({
    ...VALID,
    content_scripts: [
      { matches: ['not-a-pattern'], js: ['content.js'] },
      { js: ['content.js'] },
    ],
  }, VALID_FILES);
  const result = await svc.lint(dir);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /not a valid match pattern/.test(e.message)));
  assert.ok(result.errors.some((e) => /matches is required/.test(e.message)));
});

test('<all_urls> is a warning, not a hard error', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold(
    { ...VALID, host_permissions: ['<all_urls>'] }, VALID_FILES));
  assert.equal(result.valid, true, 'it is legal, just heavily scrutinised');
  assert.ok(result.warnings.some((w) => /every site/.test(w.message)));
});

test('permissions this runtime cannot honour are named explicitly', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold(
    { ...VALID, permissions: ['storage', 'debugger', 'printing'] }, VALID_FILES));
  assert.equal(result.valid, true);
  const messages = result.warnings.map((w) => w.message).join(' ');
  assert.match(messages, /"debugger" is not implemented/);
  assert.match(messages, /"printing" is not implemented/);
});

test('host permissions left in the V2 slot are flagged', async () => {
  const svc = makeService();
  const result = await svc.lint(scaffold(
    { ...VALID, permissions: ['https://example.com/*'] }, VALID_FILES));
  assert.ok(result.warnings.some((w) => /belongs in host_permissions/.test(w.message)));
});

test('version format is validated', async () => {
  const svc = makeService();
  const bad = await svc.lint(scaffold({ ...VALID, version: '1.0.0-beta' }, VALID_FILES));
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.field === 'version'));

  const good = await svc.lint(scaffold({ ...VALID, version: '1.2.3.4' }, VALID_FILES));
  assert.equal(good.valid, true);
});
