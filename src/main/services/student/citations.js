'use strict';
/**
 * Citation capture and formatting (spec §6).
 *
 * The data model is a subset of CSL-JSON, the format Zotero and Pandoc
 * already speak, so a captured library can leave this browser without a
 * conversion step. Inventing a bespoke shape would trap a student's
 * bibliography inside Aether, which is the opposite of useful for the one
 * user group whose work has to be portable by definition.
 *
 * The three styles implemented are the ones actually assigned: APA 7th, MLA
 * 9th, and Chicago 17th (notes-bibliography). Each is a pure function from
 * record to string, which is why they are all directly testable.
 */

/**
 * @typedef {object} Source
 * @property {string} id
 * @property {'webpage'|'article-journal'|'book'|'chapter'|'report'} type
 * @property {string} title
 * @property {Array<{family:string, given:string}>} authors
 * @property {string} [container]      journal, site, or book title
 * @property {string} [publisher]
 * @property {string} [url]
 * @property {string} [doi]
 * @property {string} [issued]         ISO date of publication
 * @property {string} [accessed]       ISO date the user captured it
 * @property {string} [volume]
 * @property {string} [issue]
 * @property {string} [pages]
 * @property {string} [note]
 */

// ===========================================================================
// Capture
// ===========================================================================

/**
 * Build a source record from what a page actually exposes.
 *
 * Metadata quality on the web is poor, so this reads the tags in descending
 * order of reliability — Highwire Press tags (what publishers emit for
 * Google Scholar), then Dublin Core, then OpenGraph, then the bare title —
 * and records which one it used. A student can then see at a glance whether
 * a citation was machine-read from a publisher or scraped off a `<title>`,
 * rather than trusting all of them equally.
 *
 * @param {object} meta name/property -> content, as scraped from the page
 * @param {string} url
 */
function fromPageMetadata(meta = {}, url = '') {
  const get = (...keys) => {
    for (const key of keys) {
      const value = meta[key] ?? meta[key.toLowerCase()];
      if (value) return String(value).trim();
    }
    return '';
  };

  const authorsRaw = []
    .concat(meta['citation_author'] || [])
    .concat(meta['dc.creator'] || [])
    .concat(meta['author'] || [])
    .flatMap((v) => String(v).split(/\s*;\s*/))
    .filter(Boolean);

  const title = get('citation_title', 'dc.title', 'og:title', 'twitter:title', 'title');
  const container = get('citation_journal_title', 'citation_conference_title',
    'dc.source', 'og:site_name', 'application-name');

  let confidence = 'low';
  if (get('citation_title')) confidence = 'high';
  else if (get('dc.title')) confidence = 'medium';
  else if (get('og:title')) confidence = 'medium';

  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }

  return {
    id: null,                 // assigned on save
    type: get('citation_journal_title') ? 'article-journal' : 'webpage',
    title: title || hostname || url,
    authors: authorsRaw.map(parseName),
    container: container || hostname,
    publisher: get('citation_publisher', 'dc.publisher'),
    url,
    doi: get('citation_doi', 'dc.identifier').replace(/^doi:/i, ''),
    issued: normaliseDate(get('citation_publication_date', 'citation_date',
      'article:published_time', 'dc.date', 'date')),
    accessed: new Date().toISOString().slice(0, 10),
    volume: get('citation_volume'),
    issue: get('citation_issue'),
    pages: joinPages(get('citation_firstpage'), get('citation_lastpage')),
    confidence,
    capturedFrom: hostname,
  };
}

/** "Smith, John" or "John Smith" -> { family, given }. */
function parseName(raw) {
  const value = String(raw).trim();
  if (value.includes(',')) {
    const [family, given = ''] = value.split(',', 2);
    return { family: family.trim(), given: given.trim() };
  }
  const parts = value.split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

function normaliseDate(value) {
  if (!value) return '';
  const match = String(value).match(/(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?/);
  if (!match) return '';
  const [, y, m, d] = match;
  return [y, m?.padStart(2, '0'), d?.padStart(2, '0')].filter(Boolean).join('-');
}

function joinPages(first, last) {
  if (!first) return '';
  return last && last !== first ? `${first}-${last}` : first;
}

// ===========================================================================
// Formatting
// ===========================================================================

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const FORMATTERS = { apa, mla, chicago };

/**
 * @param {Source} source
 * @param {'apa'|'mla'|'chicago'} style
 */
function format(source, style = 'apa') {
  const fn = FORMATTERS[style];
  if (!fn) throw new Error(`unknown citation style "${style}"`);
  return fn(normalise(source));
}

function styles() {
  return [
    { id: 'apa', name: 'APA', edition: '7th edition' },
    { id: 'mla', name: 'MLA', edition: '9th edition' },
    { id: 'chicago', name: 'Chicago', edition: '17th, notes-bibliography' },
  ];
}

/** Fill in the shape so the formatters never branch on undefined. */
function normalise(source) {
  return {
    type: 'webpage', title: '', authors: [], container: '', publisher: '',
    url: '', doi: '', issued: '', accessed: '', volume: '', issue: '', pages: '',
    ...source,
    authors: Array.isArray(source.authors) ? source.authors.filter((a) => a && a.family) : [],
  };
}

// ---- APA 7 ----------------------------------------------------------------

function apa(s) {
  const names = s.authors.map((a) => {
    const initials = initialsOf(a.given);
    return initials ? `${a.family}, ${initials}` : a.family;
  });

  // APA 7 lists up to 20 authors, then an ellipsis and the final one.
  let authorPart;
  if (names.length === 0) authorPart = '';
  else if (names.length === 1) authorPart = names[0];
  else if (names.length <= 20) {
    authorPart = `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  } else {
    authorPart = `${names.slice(0, 19).join(', ')}, ... ${names[names.length - 1]}`;
  }

  const year = s.issued ? s.issued.slice(0, 4) : 'n.d.';
  const parts = [];

  if (authorPart) parts.push(`${ensureStop(authorPart)}`);
  parts.push(`(${year}).`);
  parts.push(ensureStop(s.title));

  if (s.type === 'article-journal' && s.container) {
    let journal = `${italic(s.container)}`;
    if (s.volume) journal += `, ${italic(s.volume)}`;
    if (s.issue) journal += `(${s.issue})`;
    if (s.pages) journal += `, ${s.pages}`;
    parts.push(`${journal}.`);
  } else if (s.container && s.container !== s.title) {
    parts.push(`${italic(s.container)}.`);
  }

  if (s.publisher && s.type !== 'article-journal') parts.push(`${ensureStop(s.publisher)}`);
  if (s.doi) parts.push(`https://doi.org/${s.doi}`);
  else if (s.url) parts.push(s.url);

  return collapse(parts.join(' '));
}

// ---- MLA 9 ----------------------------------------------------------------

function mla(s) {
  const parts = [];

  if (s.authors.length === 1) {
    const a = s.authors[0];
    parts.push(ensureStop(a.given ? `${a.family}, ${a.given}` : a.family));
  } else if (s.authors.length === 2) {
    const [a, b] = s.authors;
    parts.push(ensureStop(`${a.family}, ${a.given}, and ${b.given} ${b.family}`.trim()));
  } else if (s.authors.length > 2) {
    const a = s.authors[0];
    parts.push(ensureStop(`${a.family}, ${a.given}, et al`));
  }

  parts.push(`"${ensureStop(s.title)}"`);
  if (s.container) parts.push(`${italic(s.container)},`);
  if (s.volume) parts.push(`vol. ${s.volume},`);
  if (s.issue) parts.push(`no. ${s.issue},`);
  if (s.issued) parts.push(`${mlaDate(s.issued)},`);
  if (s.pages) parts.push(`pp. ${s.pages},`);
  if (s.doi) parts.push(`https://doi.org/${s.doi}.`);
  else if (s.url) parts.push(`${s.url}.`);
  // MLA 9 makes the access date optional but recommends it for undated web
  // sources, which is precisely the case a browser capture usually is.
  if (!s.issued && s.accessed) parts.push(`Accessed ${mlaDate(s.accessed)}.`);

  return collapse(parts.join(' ').replace(/,\s*$/, '.'));
}

function mlaDate(iso) {
  const [y, m, d] = iso.split('-');
  const month = m ? MONTHS[Number(m) - 1] : null;
  const abbrev = month && month.length > 4 ? `${month.slice(0, 3)}.` : month;
  return [d ? String(Number(d)) : null, abbrev, y].filter(Boolean).join(' ');
}

// ---- Chicago 17 (notes-bibliography) --------------------------------------

function chicago(s) {
  const parts = [];

  if (s.authors.length === 1) {
    const a = s.authors[0];
    parts.push(ensureStop(a.given ? `${a.family}, ${a.given}` : a.family));
  } else if (s.authors.length > 1) {
    const [first, ...rest] = s.authors;
    const others = rest.map((a) => `${a.given} ${a.family}`.trim());
    const list = others.length === 1
      ? others[0]
      : `${others.slice(0, -1).join(', ')}, and ${others[others.length - 1]}`;
    parts.push(ensureStop(`${first.family}, ${first.given}, and ${list}`));
  }

  parts.push(`"${ensureStop(s.title)}"`);
  if (s.container) parts.push(`${italic(s.container)}`);
  if (s.volume) parts.push(`${s.volume},`);
  if (s.issue) parts.push(`no. ${s.issue}`);
  if (s.issued) parts.push(`(${chicagoDate(s.issued)}):`);
  if (s.pages) parts.push(`${s.pages}.`);
  if (s.publisher) parts.push(ensureStop(s.publisher));
  if (s.doi) parts.push(`https://doi.org/${s.doi}.`);
  else if (s.url) parts.push(`${s.url}.`);

  return collapse(parts.join(' '));
}

function chicagoDate(iso) {
  const [y, m] = iso.split('-');
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : y;
}

// ---- shared ---------------------------------------------------------------

function initialsOf(given) {
  return String(given || '')
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ');
}

/**
 * Italics are carried as Markdown so one formatter output can render as
 * HTML in the panel, paste as plain text into a document, and round-trip
 * through the Markdown export without a second code path.
 */
function italic(text) {
  return text ? `*${text}*` : '';
}

function ensureStop(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/,\s*\./g, '.').trim();
}

/** A whole bibliography, alphabetised the way every style requires. */
function bibliography(sources, style = 'apa') {
  return sources
    .map((s) => format(s, style))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

module.exports = {
  fromPageMetadata, format, bibliography, styles, parseName, normaliseDate,
};
