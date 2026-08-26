'use strict';
/**
 * Filter engine tests.
 *
 * These cover the ABP semantics that are easy to get subtly wrong and that
 * break real sites when they are: domain anchoring vs. substring matching,
 * separator handling, third-party scoping, and exception precedence.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { parseLine, parseList } = require('../src/main/services/adblock/filter-parser');
const { FilterEngine, baseDomain } = require('../src/main/services/adblock/matcher');

/** Build an engine from raw filter text. */
function engineFrom(text) {
  const engine = new FilterEngine();
  engine.addParsedList(parseList(text));
  return engine;
}

test('parses a domain-anchored rule with options', () => {
  const rule = parseLine('||ads.example.com^$third-party,script');
  assert.equal(rule.anchorDomain, true);
  assert.equal(rule.pattern, 'ads.example.com^');
  assert.equal(rule.thirdParty, true);
  assert.ok(rule.types.has('script'));
});

test('parses an exception rule', () => {
  const rule = parseLine('@@||example.com/ok.js');
  assert.equal(rule.kind, 1);
  assert.equal(rule.pattern, 'example.com/ok.js');
});

test('skips comments, metadata and unsupported options', () => {
  assert.equal(parseLine('! a comment'), null);
  assert.equal(parseLine('[Adblock Plus 2.0]'), null);
  assert.equal(parseLine('||x.com^$redirect=noop.js'), null, 'unhonourable option is dropped');
  assert.equal(parseLine('example.com#?#div:has(> .ad)'), null, 'extended selectors skipped');
});

test('domain anchoring matches subdomains but not lookalike domains', () => {
  const engine = engineFrom('||example.com^');
  assert.equal(engine.match({ url: 'https://example.com/a' }).block, true);
  assert.equal(engine.match({ url: 'https://ads.example.com/a' }).block, true);
  assert.equal(engine.match({ url: 'https://notexample.com/a' }).block, false);
  // `^` is a separator class that excludes `.`, so a lookalike host that
  // merely *starts* with the domain is a different site and is left alone.
  assert.equal(engine.match({ url: 'https://example.com.evil.net/a' }).block, false);
});

test('rules whose token could be absorbed by a wildcard still match', () => {
  // `banner` is not a whole URL token in `/banner123.gif`, so this rule must
  // not be indexed under it — a regression here silently stops blocking.
  const engine = engineFrom('/banner*.gif');
  assert.equal(engine.blockCatchAll.length, 1, 'rule falls back to the catch-all bucket');
  assert.equal(engine.match({ url: 'https://x.com/banner123.gif' }).block, true);
});

test('safely-tokenised rules stay out of the catch-all bucket', () => {
  const engine = engineFrom('||doubleclick.net^\n||googlesyndication.com^');
  assert.equal(engine.blockCatchAll.length, 0, 'both rules are indexed by token');
  assert.equal(engine.match({ url: 'https://ad.doubleclick.net/x' }).block, true);
});

test('separator ^ matches path boundaries and end of URL', () => {
  const engine = engineFrom('||tracker.io^');
  assert.equal(engine.match({ url: 'https://tracker.io/pixel' }).block, true);
  assert.equal(engine.match({ url: 'https://tracker.io' }).block, true, 'end-of-URL counts');
  assert.equal(engine.match({ url: 'https://tracker.io:8080/x' }).block, true);
});

test('wildcards match across path segments', () => {
  const engine = engineFrom('/banner*.gif');
  assert.equal(engine.match({ url: 'https://x.com/banner123.gif' }).block, true);
  assert.equal(engine.match({ url: 'https://x.com/banner.gif' }).block, true);
  assert.equal(engine.match({ url: 'https://x.com/bannr.gif' }).block, false);
});

test('regex rules are honoured', () => {
  const engine = engineFrom('/ad[0-9]{3}\\.js/');
  assert.equal(engine.match({ url: 'https://x.com/ad123.js' }).block, true);
  assert.equal(engine.match({ url: 'https://x.com/ad12.js' }).block, false);
});

test('third-party option only fires cross-site', () => {
  const engine = engineFrom('||cdn.example.com^$third-party');
  assert.equal(
    engine.match({ url: 'https://cdn.example.com/t.js', sourceUrl: 'https://other.org/' }).block,
    true
  );
  assert.equal(
    engine.match({ url: 'https://cdn.example.com/t.js', sourceUrl: 'https://www.example.com/' }).block,
    false,
    'same registrable domain is first-party'
  );
});

test('resource type scoping is respected', () => {
  const engine = engineFrom('||x.com/a^$image');
  assert.equal(engine.match({ url: 'https://x.com/a/1', type: 'image' }).block, true);
  assert.equal(engine.match({ url: 'https://x.com/a/1', type: 'script' }).block, false);
});

test('domain= option scopes a rule to specific sites', () => {
  const engine = engineFrom('||metrics.io^$domain=news.com|blog.org');
  assert.equal(
    engine.match({ url: 'https://metrics.io/p', sourceUrl: 'https://news.com/' }).block, true);
  assert.equal(
    engine.match({ url: 'https://metrics.io/p', sourceUrl: 'https://unrelated.com/' }).block, false);
});

test('exceptions override blocks, and $important overrides exceptions', () => {
  const plain = engineFrom('||ads.io^\n@@||ads.io/allowed^');
  assert.equal(plain.match({ url: 'https://ads.io/blocked' }).block, true);
  assert.equal(plain.match({ url: 'https://ads.io/allowed' }).block, false);

  const important = engineFrom('||ads.io^$important\n@@||ads.io/allowed^');
  assert.equal(important.match({ url: 'https://ads.io/allowed' }).block, true);
});

test('cosmetic rules resolve per hostname with exceptions applied', () => {
  const engine = engineFrom([
    '##.generic-ad',
    'shop.com##.shop-banner',
    'shop.com#@#.generic-ad',
    'other.com##.other-banner',
  ].join('\n'));

  const shop = engine.cosmeticFor('www.shop.com');
  assert.deepEqual(shop.specific, ['.shop-banner']);
  assert.ok(!('.generic-ad' in shop.genericByToken),
    'site-specific exception removes the generic rule');

  const news = engine.cosmeticFor('news.example');
  assert.deepEqual(news.genericByToken['.generic-ad'], ['.generic-ad']);
  assert.deepEqual(news.specific, [], 'another site\'s rules do not leak');
});

test('generic cosmetic rules are indexed by their leading class/id token', () => {
  const engine = engineFrom([
    '##.ad-box > .promo',
    '###sponsored-slot',
    '##div[data-ad]',
  ].join('\n'));
  const c = engine.cosmeticFor('example.com');
  assert.deepEqual(c.genericByToken['.ad-box'], ['.ad-box > .promo']);
  assert.deepEqual(c.genericByToken['#sponsored-slot'], ['#sponsored-slot']);
  assert.deepEqual(c.genericOther, ['div[data-ad]'],
    'attribute selectors have no cheap token hook and stay in the fallback set');
});

test('baseDomain handles two-level public suffixes', () => {
  assert.equal(baseDomain('www.example.com'), 'example.com');
  assert.equal(baseDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(baseDomain('example.com'), 'example.com');
});

test('unrelated URLs are not blocked by a large list', () => {
  const engine = engineFrom([
    '||doubleclick.net^',
    '||googlesyndication.com^',
    '||scorecardresearch.com^',
    '/pagead/',
    '||facebook.com/tr^',
  ].join('\n'));
  for (const url of [
    'https://en.wikipedia.org/wiki/Browser',
    'https://developer.mozilla.org/en-US/docs/Web',
    'https://news.ycombinator.com/',
    'https://github.com/electron/electron',
  ]) {
    assert.equal(engine.match({ url }).block, false, `${url} must not be blocked`);
  }
  assert.equal(engine.match({ url: 'https://ad.doubleclick.net/x' }).block, true);
  assert.equal(engine.match({ url: 'https://x.com/pagead/conversion.js' }).block, true);
});

test('match results are cached without changing the verdict', () => {
  const engine = engineFrom('||ads.io^');
  const a = engine.match({ url: 'https://ads.io/x' });
  const b = engine.match({ url: 'https://ads.io/x' });
  assert.deepEqual(a, b);
  assert.equal(engine._cache.size, 1);
});
