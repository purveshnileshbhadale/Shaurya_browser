'use strict';
/**
 * Citation capture and formatting.
 *
 * Formatting rules are asserted against the shape the style guides actually
 * specify, because "looks about right" is how bibliographies lose marks.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  fromPageMetadata, format, bibliography, parseName, normaliseDate,
} = require('../src/main/services/student/citations');

// ---- name parsing ---------------------------------------------------------

test('names parse from both written orders', () => {
  assert.deepEqual(parseName('Smith, John'), { family: 'Smith', given: 'John' });
  assert.deepEqual(parseName('John Smith'), { family: 'Smith', given: 'John' });
  assert.deepEqual(parseName('Ada Lovelace King'), { family: 'King', given: 'Ada Lovelace' });
  assert.deepEqual(parseName('Cher'), { family: 'Cher', given: '' });
});

test('dates normalise to ISO and tolerate partial input', () => {
  assert.equal(normaliseDate('2024/03/07'), '2024-03-07');
  assert.equal(normaliseDate('2024-3-7'), '2024-03-07');
  assert.equal(normaliseDate('2024'), '2024');
  assert.equal(normaliseDate('2019-11-02T10:00:00Z'), '2019-11-02');
  assert.equal(normaliseDate('no date here'), '');
});

// ---- capture --------------------------------------------------------------

test('publisher metadata is preferred and reported as high confidence', () => {
  const source = fromPageMetadata({
    citation_title: 'Attention Is All You Need',
    citation_author: ['Vaswani, Ashish', 'Shazeer, Noam'],
    citation_journal_title: 'Advances in Neural Information Processing Systems',
    citation_publication_date: '2017/12/04',
    citation_volume: '30',
    citation_firstpage: '5998',
    citation_lastpage: '6008',
    citation_doi: '10.5555/3295222',
    'og:title': 'Some SEO title nobody wants',
  }, 'https://papers.example.org/attention');

  assert.equal(source.title, 'Attention Is All You Need',
    'the publisher tag must beat the OpenGraph title');
  assert.equal(source.type, 'article-journal');
  assert.equal(source.confidence, 'high');
  assert.equal(source.authors.length, 2);
  assert.deepEqual(source.authors[0], { family: 'Vaswani', given: 'Ashish' });
  assert.equal(source.pages, '5998-6008');
  assert.equal(source.issued, '2017-12-04');
  assert.equal(source.doi, '10.5555/3295222');
});

test('a page with only a title still yields a usable record, marked low', () => {
  const source = fromPageMetadata({ title: 'Some Blog Post' }, 'https://www.example.com/post');

  assert.equal(source.title, 'Some Blog Post');
  assert.equal(source.type, 'webpage');
  assert.equal(source.confidence, 'low',
    'a student should be able to see this was scraped, not machine-read');
  assert.equal(source.container, 'example.com');
  assert.ok(source.accessed, 'an undated web source needs an access date');
});

test('semicolon-separated authors are split', () => {
  const source = fromPageMetadata({ author: 'Curie, Marie; Curie, Pierre' }, 'https://x.test/');
  assert.equal(source.authors.length, 2);
  assert.equal(source.authors[1].family, 'Curie');
});

// ---- APA 7 ----------------------------------------------------------------

test('APA: journal article', () => {
  const out = format({
    type: 'article-journal',
    title: 'A Study of Something',
    authors: [{ family: 'Smith', given: 'John Robert' }],
    container: 'Journal of Things',
    issued: '2020-05-01',
    volume: '12', issue: '3', pages: '45-67',
    doi: '10.1000/abc',
  }, 'apa');

  assert.equal(out,
    'Smith, J. R. (2020). A Study of Something. *Journal of Things*, *12*(3), 45-67. https://doi.org/10.1000/abc');
});

test('APA: two authors use an ampersand, and no date becomes n.d.', () => {
  const out = format({
    title: 'Untitled Work',
    authors: [{ family: 'Doe', given: 'Jane' }, { family: 'Roe', given: 'Richard' }],
    url: 'https://example.com/x',
  }, 'apa');

  assert.match(out, /Doe, J\., & Roe, R\./);
  assert.match(out, /\(n\.d\.\)/, 'APA requires an explicit n.d. rather than an empty year');
});

test('APA: an author list over twenty is elided, keeping the last', () => {
  const authors = Array.from({ length: 25 }, (_, i) => ({ family: `Author${i + 1}`, given: 'A' }));
  const out = format({ title: 'Big Collaboration', authors, issued: '2021' }, 'apa');

  assert.match(out, /\.\.\. Author25, A\./, 'APA 7 keeps the final author after the ellipsis');
  assert.ok(!out.includes('Author21, A., Author22'), 'authors 21-24 are dropped');
});

// ---- MLA 9 ----------------------------------------------------------------

test('MLA: single author, container in italics, day-month-year', () => {
  const out = format({
    title: 'How Things Work',
    authors: [{ family: 'Smith', given: 'John' }],
    container: 'The Journal',
    issued: '2020-05-04',
    url: 'https://example.com/a',
  }, 'mla');

  assert.match(out, /^Smith, John\./);
  assert.match(out, /"How Things Work\."/);
  assert.match(out, /\*The Journal\*/);
  assert.match(out, /4 May 2020/, 'MLA writes the day first and abbreviates long months');
});

test('MLA: three or more authors collapse to et al.', () => {
  const out = format({
    title: 'Group Work',
    authors: [
      { family: 'Alpha', given: 'A' }, { family: 'Beta', given: 'B' }, { family: 'Gamma', given: 'C' },
    ],
    issued: '2022-01-15',
  }, 'mla');

  assert.match(out, /Alpha, A, et al\./);
  assert.ok(!out.includes('Gamma'));
});

test('MLA: an undated source gets an access date', () => {
  const out = format({
    title: 'Living Page',
    authors: [{ family: 'Web', given: 'Ann' }],
    accessed: '2026-08-26',
  }, 'mla');

  assert.match(out, /Accessed 26 Aug\. 2026\./,
    'MLA 9 recommends an access date exactly when there is no publication date');
});

test('MLA: a dated source does not get a redundant access date', () => {
  const out = format({
    title: 'Fixed Article', authors: [{ family: 'Web', given: 'Ann' }],
    issued: '2021-02-02', accessed: '2026-08-26',
  }, 'mla');
  assert.ok(!out.includes('Accessed'));
});

// ---- Chicago 17 -----------------------------------------------------------

test('Chicago: author inverted, month and year in parentheses', () => {
  const out = format({
    title: 'On Method',
    authors: [{ family: 'Smith', given: 'John' }],
    container: 'Review of Methods',
    issued: '2019-07-01',
    volume: '8', issue: '2', pages: '10-30',
  }, 'chicago');

  assert.match(out, /^Smith, John\./);
  assert.match(out, /\*Review of Methods\*/);
  assert.match(out, /\(July 2019\):/);
  assert.match(out, /10-30\./);
});

test('Chicago: multiple authors invert only the first', () => {
  const out = format({
    title: 'Joint Paper',
    authors: [{ family: 'Alpha', given: 'Ann' }, { family: 'Beta', given: 'Bob' }],
    issued: '2020',
  }, 'chicago');

  assert.match(out, /Alpha, Ann, and Bob Beta\./,
    'only the leading name is inverted; the rest read naturally');
});

// ---- general --------------------------------------------------------------

test('an unknown style is refused rather than silently defaulting', () => {
  assert.throws(() => format({ title: 'x' }, 'harvard'), /unknown citation style/);
});

test('a record with no authors still formats', () => {
  for (const style of ['apa', 'mla', 'chicago']) {
    const out = format({ title: 'Anonymous Report', issued: '2020', url: 'https://x.test/' }, style);
    assert.ok(out.includes('Anonymous Report'), `${style} must not drop the title`);
    assert.ok(!out.startsWith(','), `${style} must not leave a dangling separator`);
  }
});

test('bibliography output is alphabetised', () => {
  const sources = [
    { title: 'Zebra', authors: [{ family: 'Zulu', given: 'Z' }], issued: '2020' },
    { title: 'Apple', authors: [{ family: 'Alpha', given: 'A' }], issued: '2020' },
  ];
  const lines = bibliography(sources, 'apa');
  assert.match(lines[0], /^Alpha/);
  assert.match(lines[1], /^Zulu/);
});

test('formatting never leaves doubled punctuation', () => {
  const out = format({
    title: 'Ends With A Period.',
    authors: [{ family: 'Smith', given: 'J.' }],
    container: 'Journal.',
    issued: '2020',
  }, 'apa');

  assert.ok(!/\.\./.test(out.replace(/\.\.\./g, '')), `doubled stop in: ${out}`);
});
