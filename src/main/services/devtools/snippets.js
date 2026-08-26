'use strict';
/**
 * Snippet manager (spec §3).
 *
 * Snippets sync, which means they pass through the E2EE sync engine like
 * bookmarks and notes — the server sees ciphertext. That matters more than it
 * might seem: developers paste API keys, connection strings and internal
 * hostnames into snippet managers constantly, and a plaintext-synced snippet
 * store would be a credential dump waiting to happen.
 *
 * Insertion goes through the command palette, so a snippet is reachable with
 * the same keystroke as everything else rather than needing its own chord.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');

/** Languages offered for highlighting. Extended freely by the user. */
const LANGUAGES = ['plaintext', 'javascript', 'typescript', 'python', 'go', 'rust',
  'java', 'sql', 'bash', 'json', 'yaml', 'html', 'css', 'graphql', 'dockerfile'];

class SnippetService extends EventEmitter {
  constructor({ features }) {
    super();
    this.features = features;
    this.store = new JsonStore(paths.userData('snippets.json'), { snippets: [] });
  }

  list({ query, language, tag } = {}) {
    let items = this.store.data.snippets;

    if (language) items = items.filter((s) => s.language === language);
    if (tag) items = items.filter((s) => (s.tags || []).includes(tag));

    if (query?.trim()) {
      const needle = query.toLowerCase();
      items = items
        .map((s) => ({ snippet: s, score: scoreSnippet(s, needle) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.snippet);
    }

    return {
      snippets: items,
      languages: LANGUAGES,
      tags: [...new Set(this.store.data.snippets.flatMap((s) => s.tags || []))].sort(),
    };
  }

  save({ id, title, body, language = 'plaintext', tags = [], description = '' }) {
    if (!this.features.enabled('snippets')) throw new Error('the snippet manager is off');
    if (!String(body || '').trim()) throw new Error('a snippet needs a body');

    const record = {
      id: id || crypto.randomUUID(),
      title: String(title || '').trim() || firstLine(body),
      body,
      language,
      description,
      tags: [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))],
      updatedAt: Date.now(),
      // Placeholders let one snippet serve a family of cases without needing
      // a template engine: ${name} is substituted at insert time.
      placeholders: [...new Set([...String(body).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]))],
    };

    const snippets = this.store.data.snippets;
    const index = snippets.findIndex((s) => s.id === record.id);
    if (index === -1) {
      record.createdAt = Date.now();
      record.uses = 0;
      snippets.unshift(record);
    } else {
      snippets[index] = { ...snippets[index], ...record };
    }

    this.store.save();
    this.emit('changed', this.list());
    return record;
  }

  remove(id) {
    this.store.data.snippets = this.store.data.snippets.filter((s) => s.id !== id);
    this.store.save();
    this.emit('changed', this.list());
    return this.list();
  }

  /**
   * Resolve a snippet for insertion, substituting placeholders.
   *
   * Use counts drive palette ranking, so the snippets someone actually
   * reaches for surface first without them having to organise anything.
   */
  resolve(id, values = {}) {
    const snippet = this.store.data.snippets.find((s) => s.id === id);
    if (!snippet) throw new Error('unknown snippet');

    const missing = (snippet.placeholders || []).filter((p) => values[p] === undefined);
    const body = String(snippet.body).replace(
      /\$\{(\w+)\}/g,
      (match, name) => (values[name] !== undefined ? values[name] : match),
    );

    snippet.uses = (snippet.uses || 0) + 1;
    snippet.lastUsed = Date.now();
    this.store.save();

    return { id, body, missing, language: snippet.language };
  }

  /** Palette entries, most-used first. */
  paletteEntries() {
    if (!this.features.enabled('snippets')) return [];
    return [...this.store.data.snippets]
      .sort((a, b) => (b.uses || 0) - (a.uses || 0))
      .slice(0, 50)
      .map((s) => ({
        id: `snippet:${s.id}`,
        title: s.title,
        subtitle: `${s.language}${s.tags?.length ? ` · ${s.tags.join(', ')}` : ''}`,
        kind: 'snippet',
      }));
  }

  /** Everything the sync engine needs; it encrypts before transmitting. */
  exportAll() {
    return this.store.data.snippets;
  }

  importAll(snippets) {
    const byId = new Map(this.store.data.snippets.map((s) => [s.id, s]));
    for (const incoming of snippets || []) {
      const existing = byId.get(incoming.id);
      // Last write wins per record, which is the sync engine's policy for
      // everything that is not history or a deletion.
      if (!existing || (incoming.updatedAt || 0) > (existing.updatedAt || 0)) {
        byId.set(incoming.id, incoming);
      }
    }
    this.store.data.snippets = [...byId.values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.store.save();
    this.emit('changed', this.list());
    return this.list();
  }
}

function scoreSnippet(snippet, needle) {
  const title = String(snippet.title || '').toLowerCase();
  const tags = (snippet.tags || []).join(' ');
  const body = String(snippet.body || '').toLowerCase();

  // Title beats tags beats body: someone typing "curl" wants the snippet
  // called curl, not every snippet that happens to contain the word.
  if (title.startsWith(needle)) return 100;
  if (title.includes(needle)) return 60;
  if (tags.includes(needle)) return 40;
  if (body.includes(needle)) return 15;
  return 0;
}

function firstLine(body) {
  return String(body).split('\n')[0].slice(0, 60) || 'Untitled snippet';
}

module.exports = { SnippetService, LANGUAGES, scoreSnippet };
