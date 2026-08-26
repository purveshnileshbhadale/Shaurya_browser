'use strict';
/**
 * Markdown renderer tests.
 *
 * The security cases matter as much as the formatting ones: a README from a
 * cloned repository is untrusted input, and a renderer that passes raw HTML
 * or `javascript:` links through turns "preview this file" into script
 * execution.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { renderMarkdown } = require('../src/main/services/devtools/markdown');

test('renders headings with anchors', () => {
  const html = renderMarkdown('# Hello World\n\n## Sub Section');
  assert.match(html, /<h1 id="hello-world">Hello World<\/h1>/);
  assert.match(html, /<h2 id="sub-section">Sub Section<\/h2>/);
});

test('renders paragraphs and inline emphasis', () => {
  const html = renderMarkdown('Some **bold** and *italic* and ~~struck~~ text.');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<del>struck<\/del>/);
});

test('renders fenced code with a language class, unformatted inside', () => {
  const html = renderMarkdown('```js\nconst x = **not bold**;\n```');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /const x = \*\*not bold\*\*;/, 'code content is not inline-formatted');
  assert.equal(/<strong>/.test(html), false);
});

test('escapes HTML inside code blocks', () => {
  const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>'), false);
});

test('never emits raw HTML from the document', () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>');
  // The payload survives as inert *text*; what must not exist is a real tag.
  assert.equal(/<script/i.test(html), false, 'inline script must not become an element');
  assert.equal(/<img/i.test(html), false, 'the img tag must not become an element');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('blocks javascript: links', () => {
  const html = renderMarkdown('[click me](javascript:alert(1))');
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /href="#blocked"/);
});

test('blocks data: and vbscript: links', () => {
  for (const scheme of ['data:text/html,<script>x</script>', 'vbscript:msgbox']) {
    const html = renderMarkdown(`[x](${scheme})`);
    assert.match(html, /href="#blocked"/, `${scheme} should be blocked`);
  }
});

test('renders ordinary links and images, including titles', () => {
  const html = renderMarkdown('[docs](https://example.com/a) and ![alt](img.png "Title")');
  assert.match(html, /<a href="https:\/\/example\.com\/a">docs<\/a>/);
  assert.match(html, /<img src="img\.png" alt="alt" title="Title">/);

  const titled = renderMarkdown('[t](https://e.com "My Title")');
  assert.match(titled, /<a href="https:\/\/e\.com" title="My Title">t<\/a>/);
});

test('query strings in links are escaped exactly once', () => {
  const html = renderMarkdown('[q](https://example.com/s?a=1&b=2)');
  assert.match(html, /href="https:\/\/example\.com\/s\?a=1&amp;b=2"/);
  assert.equal(html.includes('&amp;amp;'), false, 'double escaping would break the URL');
});

test('autolinks bare URLs', () => {
  const html = renderMarkdown('See https://example.com/page for more');
  assert.match(html, /<a href="https:\/\/example\.com\/page">https:\/\/example\.com\/page<\/a>/);
});

test('renders unordered and ordered lists', () => {
  const ul = renderMarkdown('- one\n- two\n- three');
  assert.match(ul, /<ul>/);
  assert.equal((ul.match(/<li>/g) || []).length, 3);

  const ol = renderMarkdown('1. first\n2. second');
  assert.match(ol, /<ol>/);
  assert.equal((ol.match(/<li>/g) || []).length, 2);
});

test('renders task list checkboxes', () => {
  const html = renderMarkdown('- [x] done\n- [ ] pending');
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /<input type="checkbox" disabled>/);
});

test('renders tables with alignment', () => {
  const html = renderMarkdown([
    '| Name | Count | Note |',
    '|:-----|------:|:----:|',
    '| a    | 1     | x    |',
    '| b    | 2     | y    |',
  ].join('\n'));
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<th style="text-align:right">Count<\/th>/);
  assert.match(html, /<th style="text-align:center">Note<\/th>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header plus two body rows');
});

test('renders blockquotes, including nested content', () => {
  const html = renderMarkdown('> quoted **text**\n> more');
  assert.match(html, /<blockquote>/);
  assert.match(html, /<strong>text<\/strong>/);
});

test('renders horizontal rules', () => {
  for (const rule of ['---', '***', '___', '- - -']) {
    assert.match(renderMarkdown(rule), /<hr>/, `${rule} should be a rule`);
  }
});

test('inline code is escaped and not formatted', () => {
  const html = renderMarkdown('Use `<div>` and `**stars**` verbatim');
  assert.match(html, /<code>&lt;div&gt;<\/code>/);
  assert.match(html, /<code>\*\*stars\*\*<\/code>/);
});

test('an empty document renders to nothing rather than throwing', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n\n').trim(), '');
});

test('a realistic README renders every block type', () => {
  const html = renderMarkdown([
    '# Project',
    '',
    'A tool for **things**. See [docs](https://example.com).',
    '',
    '## Install',
    '',
    '```bash',
    'npm install project',
    '```',
    '',
    '## Features',
    '',
    '- [x] fast',
    '- [ ] documented',
    '',
    '> Note: alpha software.',
    '',
    '| Option | Default |',
    '|--------|---------|',
    '| `mode` | `auto`  |',
  ].join('\n'));

  for (const fragment of ['<h1', '<h2', '<strong>', '<a href=', '<pre><code class="language-bash">',
    '<ul>', 'checkbox', '<blockquote>', '<table>', '<code>mode</code>']) {
    assert.ok(html.includes(fragment), `missing ${fragment}`);
  }
});
