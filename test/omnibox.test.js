'use strict';
/**
 * Omnibox resolution tests.
 *
 * The URL-vs-search call is the single most-exercised heuristic in a
 * browser, and every wrong answer is immediately visible: a search that
 * should have navigated, or a hostname leaked to a search engine.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { SearchService } = require('../src/main/services/search');
const { DEFAULTS } = require('../src/main/services/settings');

/** Settings stub backed by the real default document. */
function settingsStub(overrides = {}) {
  const data = structuredClone(DEFAULTS);
  Object.assign(data.search, overrides);
  return {
    get(path) {
      if (!path) return data;
      return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), data);
    },
    set() {},
  };
}

function makeService() {
  return new SearchService(
    settingsStub(),
    { query: () => [], topSites: () => [] },
    { list: () => [] }
  );
}

test('explicit schemes navigate as typed', () => {
  const s = makeService();
  for (const input of [
    'https://example.com/a?b=c',
    'http://example.com',
    'file:///home/user/notes.md',
    'shaurya://settings',
    'view-source:https://example.com',
  ]) {
    const r = s.resolve(input);
    assert.equal(r.kind, 'url', `${input} should navigate`);
    assert.equal(r.url, input);
  }
});

test('bare hostnames navigate over HTTPS', () => {
  const s = makeService();
  for (const input of ['example.com', 'sub.example.co.uk', 'news.ycombinator.com/item?id=1']) {
    const r = s.resolve(input);
    assert.equal(r.kind, 'url', `${input} should navigate`);
    assert.equal(r.url, `https://${input}`);
  }
});

test('localhost and dev addresses navigate over plain HTTP', () => {
  const s = makeService();
  for (const input of ['localhost', 'localhost:3000', 'localhost:8080/api/health',
    '127.0.0.1:5173', '0.0.0.0:9000', '192.168.1.10']) {
    const r = s.resolve(input);
    assert.equal(r.kind, 'url', `${input} should navigate`);
    assert.ok(r.url.startsWith('http://'), `${input} -> ${r.url} should not be upgraded here`);
  }
});

test('host:port with a plausible name navigates', () => {
  const s = makeService();
  const r = s.resolve('dev-box:8000/status');
  assert.equal(r.kind, 'url');
  assert.equal(r.url, 'http://dev-box:8000/status');
});

test('anything with whitespace is a search', () => {
  const s = makeService();
  for (const input of ['how to center a div', 'example.com and stuff', 'node --test']) {
    assert.equal(s.resolve(input).kind, 'search', `${input} should search`);
  }
});

test('questions and expressions are searches, not hostnames', () => {
  const s = makeService();
  for (const input of ['what is 2+2', 'why.is.this.happening', 'a.b']) {
    const r = s.resolve(input);
    assert.equal(r.kind, 'search', `${input} resolved to ${r.kind} (${r.url})`);
  }
});

test('a single word is a search, never a hostname', () => {
  const s = makeService();
  assert.equal(s.resolve('electron').kind, 'search');
  assert.equal(s.resolve('typescript').kind, 'search');
});

test('the search URL encodes the query', () => {
  const s = makeService();
  const r = s.resolve('c++ & rust');
  assert.equal(r.kind, 'search');
  assert.ok(r.url.includes(encodeURIComponent('c++ & rust')), `got ${r.url}`);
  assert.equal(r.url.startsWith('https://duckduckgo.com/'), true);
});

test('empty input goes to the start page', () => {
  const s = makeService();
  assert.equal(s.resolve('   ').url, 'shaurya://start');
});

test('open tabs outrank history in suggestions', async () => {
  const service = new SearchService(
    settingsStub(),
    {
      query: () => [{ url: 'https://example.com/docs', title: 'Docs', score: 50, visits: 3, lastVisit: Date.now() }],
      topSites: () => [],
    },
    { list: () => [] }
  );

  const results = await service.suggest({
    query: 'docs',
    openTabs: [{ id: 't1', title: 'Docs', url: 'https://example.com/docs' }],
  });

  const tabHit = results.find((r) => r.kind === 'tab');
  assert.ok(tabHit, 'the open tab should be offered');
  // Same URL in both sources: the tab entry must win the de-duplication.
  assert.equal(results.filter((r) => r.url === 'https://example.com/docs').length, 1);
});

test('suggestions always lead with what the input resolves to', async () => {
  const s = makeService();
  const results = await s.suggest({ query: 'example.com' });
  assert.equal(results[0].kind, 'navigate');
  assert.equal(results[0].url, 'https://example.com');
});

test('remote suggestions stay off unless explicitly enabled', async () => {
  const s = makeService();
  assert.equal(s.settings.get('search.suggestionsEnabled'), false,
    'typing must not reach the network by default');
});
