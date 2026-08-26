'use strict';
/**
 * RSS/Atom parsing for patch-note feeds.
 *
 * Feed content is attacker-influenced text that ends up in a privileged
 * renderer, so the escaping behaviour is tested as carefully as the parsing.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseFeed } = require('../src/main/services/gaming/feeds');

test('RSS 2.0 items parse', () => {
  const items = parseFeed(`
    <rss><channel>
      <title>Channel title, not an item</title>
      <item>
        <title>Patch 1.4.2</title>
        <link>https://game.example/patch-142</link>
        <pubDate>Tue, 12 Aug 2026 10:00:00 GMT</pubDate>
        <description>Fixed the thing that ate your save.</description>
      </item>
    </channel></rss>`, 'https://game.example/feed');

  assert.equal(items.length, 1, 'the channel title must not be mistaken for an item');
  assert.equal(items[0].title, 'Patch 1.4.2');
  assert.equal(items[0].url, 'https://game.example/patch-142');
  assert.equal(items[0].summary, 'Fixed the thing that ate your save.');
  assert.equal(new Date(items[0].published).getUTCFullYear(), 2026);
});

test('Atom entries parse, including href-style links', () => {
  const items = parseFeed(`
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Season 3 notes</title>
        <link rel="alternate" href="https://game.example/s3"/>
        <updated>2026-03-01T12:00:00Z</updated>
        <summary>Balance pass.</summary>
      </entry>
    </feed>`, 'https://game.example/atom');

  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://game.example/s3');
  assert.equal(items[0].summary, 'Balance pass.');
});

test('CDATA sections are unwrapped', () => {
  const items = parseFeed(`
    <rss><item>
      <title><![CDATA[Hotfix & rollback]]></title>
      <description><![CDATA[<p>Reverted <b>everything</b>.</p>]]></description>
    </item></rss>`, 'f');

  assert.equal(items[0].title, 'Hotfix & rollback');
  assert.equal(items[0].summary, 'Reverted everything.', 'markup is stripped from summaries');
});

test('markup in a feed cannot reach the renderer as markup', () => {
  const items = parseFeed(`
    <rss><item>
      <title>Update</title>
      <description>&lt;img src=x onerror="alert(1)"&gt; and &lt;script&gt;bad()&lt;/script&gt;</description>
    </item></rss>`, 'f');

  const summary = items[0].summary;
  assert.ok(!summary.includes('<img'), 'no live element may survive');
  assert.ok(!summary.includes('<script'), 'no script element may survive');
});

test('entity decoding does not double-decode', () => {
  const items = parseFeed(`
    <rss><item><title>Tom &amp;amp; Jerry</title></item></rss>`, 'f');
  assert.equal(items[0].title, 'Tom &amp; Jerry',
    '&amp;amp; is a literal "&amp;", not an ampersand');
});

test('an item with no title is skipped rather than rendered blank', () => {
  const items = parseFeed('<rss><item><link>https://x.test/</link></item></rss>', 'f');
  assert.equal(items.length, 0);
});

test('an undated item still parses, with a null date', () => {
  const items = parseFeed('<rss><item><title>Undated</title></item></rss>', 'f');
  assert.equal(items[0].published, null);
});

test('summaries are capped so one feed cannot dominate the panel', () => {
  const long = 'x'.repeat(2000);
  const items = parseFeed(`<rss><item><title>T</title><description>${long}</description></item></rss>`, 'f');
  assert.ok(items[0].summary.length <= 400);
});

test('malformed XML yields nothing instead of throwing', () => {
  for (const input of ['', 'not xml', '<rss><item><title>unclosed']) {
    assert.doesNotThrow(() => parseFeed(input, 'f'));
  }
});

test('every item records which feed it came from', () => {
  const items = parseFeed('<rss><item><title>A</title></item></rss>', 'https://src.test/feed');
  assert.equal(items[0].source, 'https://src.test/feed');
});
