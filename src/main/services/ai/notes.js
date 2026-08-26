'use strict';
/**
 * AI note generation and export (spec §4).
 *
 * One click turns an article, a video transcript or a PDF into structured
 * notes — key points, definitions, and optionally a quiz — then exports them
 * to Markdown, PDF, Notion or Obsidian.
 *
 * Notes are stored as Markdown on disk. That is deliberate: a note the user
 * cannot read without this browser is a note held hostage, and Markdown is
 * also what every export target wants as input.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog, shell, app } = require('electron');
const { JsonStore } = require('../../util/json-store');
const paths = require('../../util/paths');
const { uid } = require('../../util/id');
const { request } = require('../../util/net');
const { createLogger } = require('../../util/logger');

const log = createLogger('notes');

/**
 * The note-generation instruction. Structured tightly because the output
 * feeds a parser, not just a human reader.
 */
const NOTE_PROMPT = `Turn the source material into structured study notes.

Use exactly this Markdown structure, omitting any section that genuinely does not apply:

# <concise title>

> <one-sentence summary of what this source is about>

## Key points
- <the substantive claims, one per line, specific rather than generic>

## Definitions
- **<term>** — <definition in the source's own sense>

## Details
<short paragraphs covering anything important that the key points compress too far>

## Open questions
- <what the source raises but does not answer>

Rules:
- Draw only on the source. Do not add outside facts.
- Prefer the source's own terminology.
- If the source is thin, produce short notes rather than padding them.`;

const QUIZ_PROMPT = `

## Quiz
Add 5 questions that test understanding rather than recall of wording. Format each as:

**Q1.** <question>
<details><summary>Answer</summary>

<answer>
</details>`;

class NotesService extends EventEmitter {
  constructor(settings, features, ai) {
    super();
    this.settings = settings;
    this.features = features;
    this.ai = ai;
    this.store = new JsonStore(paths.userData('notes.json'), { notes: [] });
  }

  // ---- generation ------------------------------------------------------

  /**
   * Generate notes from the active tab.
   *
   * @param {object} opts
   * @param {string} opts.windowId
   * @param {object} opts.window
   * @param {boolean} [opts.quiz]
   * @param {'hosted'|'local'} [opts.model]
   */
  async generate({ windowId, window, quiz, model }) {
    if (!this.features.enabled('aiNotes')) {
      throw new Error('AI Notes are turned off in the Feature Store');
    }
    const tab = window?.tabs.active;
    if (!tab) throw new Error('no active tab');

    const source = await this._gatherSource(tab);
    if (!source.text || source.text.length < 200) {
      throw new Error('there is not enough readable content on this page to take notes from');
    }

    const wantQuiz = quiz ?? this.settings.get('ai.autoQuiz');
    const provider = model || this.settings.get('ai.defaultModel');

    const markdown = await this._complete({
      provider,
      system: NOTE_PROMPT + (wantQuiz ? QUIZ_PROMPT : ''),
      prompt: `Source: ${source.title}\nURL: ${source.url}\nType: ${source.kind}\n\n`
        + `---BEGIN SOURCE---\n${source.text}\n---END SOURCE---`,
    });

    const note = this.save({
      title: extractTitle(markdown) || source.title,
      markdown,
      sourceUrl: source.url,
      sourceKind: source.kind,
      hasQuiz: wantQuiz,
      wordCount: source.text.split(/\s+/).length,
    });

    log.info(`generated notes for ${source.url}`);
    return note;
  }

  /**
   * Pull the best available text: a transcript for video, extracted text for
   * a PDF, the article body otherwise.
   */
  async _gatherSource(tab) {
    const context = await this.ai.context.forTab(tab, { maxChars: 120000 });
    if (!context) throw new Error('could not read this page');

    // A page with a caption track is a video; its transcript is far better
    // note material than the surrounding page furniture.
    if (context.tracks?.length) {
      const transcript = await this._fetchTranscript(context.tracks[0].src);
      if (transcript) {
        return {
          title: context.title,
          url: context.url,
          kind: 'video transcript',
          text: transcript,
        };
      }
    }

    if (/\.pdf($|\?)/i.test(context.url) || context.title?.endsWith('.pdf')) {
      return { ...context, kind: 'PDF' };
    }

    return {
      title: context.title,
      url: context.url,
      kind: context.isArticle ? 'article' : 'web page',
      text: context.text,
    };
  }

  /** Parse a WebVTT caption track into plain prose. */
  async _fetchTranscript(src) {
    if (!src) return null;
    try {
      const res = await request(src, { timeout: 10000, limit: 4 * 1024 * 1024 });
      if (res.status !== 200) return null;
      return parseVtt(res.body.toString('utf8'));
    } catch (err) {
      log.debug(`transcript fetch failed: ${err.message}`);
      return null;
    }
  }

  async _complete({ provider, system, prompt }) {
    const target = this.ai._providerFor(provider);
    return target.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      effort: 'high',
    });
  }

  // ---- storage ---------------------------------------------------------

  save({ title, markdown, sourceUrl, sourceKind, hasQuiz, wordCount, id }) {
    const existing = id ? this.store.data.notes.find((n) => n.id === id) : null;
    const note = existing || {
      id: uid('note_'),
      created: Date.now(),
    };
    Object.assign(note, {
      title: title || 'Untitled note',
      markdown,
      sourceUrl: sourceUrl || note.sourceUrl || null,
      sourceKind: sourceKind || note.sourceKind || null,
      hasQuiz: hasQuiz ?? note.hasQuiz ?? false,
      wordCount: wordCount ?? note.wordCount ?? null,
      updated: Date.now(),
      tags: note.tags || [],
    });
    if (!existing) this.store.data.notes.push(note);
    this.store.save();
    this.emit('changed', this.list());
    return note;
  }

  update(id, patch) {
    const note = this.store.data.notes.find((n) => n.id === id);
    if (!note) throw new Error('no such note');
    Object.assign(note, patch, { id: note.id, updated: Date.now() });
    this.store.save();
    this.emit('changed', this.list());
    return note;
  }

  list({ query } = {}) {
    const notes = this.store.data.notes.map(({ markdown, ...rest }) => ({
      ...rest,
      excerpt: firstProse(markdown).slice(0, 180),
    }));
    if (!query) return notes.sort((a, b) => b.updated - a.updated);
    const q = query.toLowerCase();
    return notes
      .filter((n) => `${n.title} ${n.excerpt} ${n.sourceUrl}`.toLowerCase().includes(q))
      .sort((a, b) => b.updated - a.updated);
  }

  get(id) {
    return this.store.data.notes.find((n) => n.id === id) || null;
  }

  remove(id) {
    const idx = this.store.data.notes.findIndex((n) => n.id === id);
    if (idx < 0) return false;
    this.store.data.notes.splice(idx, 1);
    this.store.save();
    this.emit('changed', this.list());
    return true;
  }

  // ---- export ----------------------------------------------------------

  /**
   * @param {{id:string, target:'markdown'|'pdf'|'notion'|'obsidian'|'clipboard'}} opts
   */
  async export({ id, target = 'markdown' }) {
    const note = this.get(id);
    if (!note) throw new Error('no such note');

    switch (target) {
      case 'markdown': return this._exportMarkdown(note);
      case 'pdf': return this._exportPdf(note);
      case 'obsidian': return this._exportObsidian(note);
      case 'notion': return this._exportNotion(note);
      default: throw new Error(`unknown export target "${target}"`);
    }
  }

  async _exportMarkdown(note) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export notes',
      defaultPath: path.join(app.getPath('documents'), `${safeName(note.title)}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { exported: false };
    await fs.writeFile(filePath, withFrontMatter(note), 'utf8');
    return { exported: true, path: filePath };
  }

  /**
   * PDF export renders the note in an offscreen window and uses Chromium's
   * own print-to-PDF. Reusing the engine that already lays out the reader
   * view keeps typography consistent and avoids a PDF library.
   */
  async _exportPdf(note) {
    const { BrowserWindow } = require('electron');
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export notes as PDF',
      defaultPath: path.join(app.getPath('documents'), `${safeName(note.title)}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { exported: false };

    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: false },
    });
    try {
      const html = renderNoteHtml(note);
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        pageSize: 'A4',
      });
      await fs.writeFile(filePath, pdf);
      return { exported: true, path: filePath };
    } finally {
      win.destroy();
    }
  }

  /** Obsidian vaults are plain folders, so this is a file write plus a link. */
  async _exportObsidian(note) {
    const vault = this.settings.get('ai.obsidianVault');
    if (!vault) {
      throw new Error('Set your Obsidian vault folder in Settings › AI first');
    }
    const file = path.join(vault, `${safeName(note.title)}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, withFrontMatter(note), 'utf8');
    // Open it in Obsidian if the URI handler is registered.
    const uri = `obsidian://open?path=${encodeURIComponent(file)}`;
    shell.openExternal(uri).catch(() => {});
    return { exported: true, path: file, opened: uri };
  }

  /**
   * Notion export via the public API. Markdown is converted to Notion's
   * block model — headings, lists, quotes, code and paragraphs — because the
   * API takes structured blocks, not raw Markdown.
   */
  async _exportNotion(note) {
    const token = this.settings.get('ai.notionToken');
    const parent = this.settings.get('ai.notionParentPage');
    if (!token || !parent) {
      throw new Error('Add a Notion integration token and parent page in Settings › AI');
    }

    const blocks = markdownToNotionBlocks(note.markdown);
    const res = await request('https://api.notion.com/v1/pages', {
      method: 'POST',
      timeout: 20000,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { page_id: parent },
        properties: {
          title: { title: [{ text: { content: note.title.slice(0, 200) } }] },
        },
        // Notion caps children per request; the rest would need appends.
        children: blocks.slice(0, 100),
      }),
    });

    if (res.status < 200 || res.status >= 300) {
      const detail = safeJson(res.body.toString('utf8'))?.message || `HTTP ${res.status}`;
      throw new Error(`Notion rejected the page: ${detail}`);
    }
    const created = JSON.parse(res.body.toString('utf8'));
    return { exported: true, url: created.url, truncated: blocks.length > 100 };
  }

  exportAll() {
    return this.store.data.notes;
  }

  importAll(notes) {
    const byId = new Map(this.store.data.notes.map((n) => [n.id, n]));
    for (const incoming of notes) {
      const existing = byId.get(incoming.id);
      if (!existing) this.store.data.notes.push(incoming);
      else if (incoming.updated > existing.updated) Object.assign(existing, incoming);
    }
    this.store.save();
    this.emit('changed', this.list());
  }

  flush() {
    this.store.flush();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** WebVTT -> prose, dropping cue timings and de-duplicating rolling captions. */
function parseVtt(vtt) {
  const lines = vtt.split(/\r?\n/);
  const out = [];
  let previous = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (/^\d+$/.test(trimmed)) continue;                 // cue number
    if (/-->/.test(trimmed)) continue;                   // timing
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;
    const text = trimmed.replace(/<[^>]+>/g, '');        // karaoke spans
    // Rolling captions repeat the previous line plus one new one.
    if (text === previous) continue;
    out.push(text);
    previous = text;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function extractTitle(markdown) {
  const m = /^#\s+(.+)$/m.exec(markdown || '');
  return m ? m[1].trim() : null;
}

function firstProse(markdown) {
  if (!markdown) return '';
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.replace(/^[>\-*]\s*/, '');
  }
  return '';
}

function safeName(title) {
  return String(title).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80)
    || 'note';
}

function withFrontMatter(note) {
  const fm = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    note.sourceUrl ? `source: ${note.sourceUrl}` : null,
    `created: ${new Date(note.created).toISOString()}`,
    'generator: Aether',
    '---',
    '',
  ].filter(Boolean).join('\n');
  return fm + note.markdown;
}

/** Minimal Markdown -> HTML for the PDF renderer. */
function renderNoteHtml(note) {
  const body = escapeHtml(note.markdown)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^(?!<[hublc])(.+)$/gm, '<p>$1</p>');

  return `<!doctype html><meta charset="utf-8"><style>
    body { font: 15px/1.65 -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
           color: #16181d; max-width: 46em; margin: 0 auto; }
    h1 { font-size: 1.8em; margin: 0 0 .3em; }
    h2 { font-size: 1.25em; margin: 1.6em 0 .4em; border-bottom: 1px solid #e3e6ea; padding-bottom: .2em; }
    h3 { font-size: 1.05em; margin: 1.2em 0 .3em; }
    blockquote { margin: 0 0 1em; padding: .6em 1em; background: #f4f6f8;
                 border-left: 3px solid #6C8CFF; color: #3a4048; }
    ul { padding-left: 1.3em; } li { margin: .25em 0; }
    code { background: #f4f6f8; padding: .1em .35em; border-radius: 4px; font-size: .92em; }
    .src { color: #6b7280; font-size: .85em; margin-top: 2em;
           border-top: 1px solid #e3e6ea; padding-top: .8em; }
  </style>${body}
  ${note.sourceUrl ? `<p class="src">Source: ${escapeHtml(note.sourceUrl)}</p>` : ''}`;
}

/**
 * Convert Markdown to Notion blocks.
 * Covers the subset the note template emits; anything unrecognised becomes a
 * paragraph rather than being dropped.
 */
function markdownToNotionBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').split('\n');
  let inCode = false;
  let codeBuffer = [];
  let codeLang = 'plain text';

  const text = (content) => [{ type: 'text', text: { content: content.slice(0, 2000) } }];

  for (const line of lines) {
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      if (inCode) {
        blocks.push({
          object: 'block', type: 'code',
          code: { rich_text: text(codeBuffer.join('\n')), language: codeLang },
        });
        inCode = false;
        codeBuffer = [];
      } else {
        inCode = true;
        codeLang = fence[1] || 'plain text';
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    let m;
    if ((m = /^###\s+(.*)$/.exec(trimmed))) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: text(m[1]) } });
    } else if ((m = /^##\s+(.*)$/.exec(trimmed))) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: text(m[1]) } });
    } else if ((m = /^#\s+(.*)$/.exec(trimmed))) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: text(m[1]) } });
    } else if ((m = /^>\s+(.*)$/.exec(trimmed))) {
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: text(m[1]) } });
    } else if ((m = /^[-*]\s+(.*)$/.exec(trimmed))) {
      blocks.push({
        object: 'block', type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: text(stripInline(m[1])) },
      });
    } else if ((m = /^\d+\.\s+(.*)$/.exec(trimmed))) {
      blocks.push({
        object: 'block', type: 'numbered_list_item',
        numbered_list_item: { rich_text: text(stripInline(m[1])) },
      });
    } else if (/^<details>|^<\/details>|^<summary>/.test(trimmed)) {
      // Quiz answer wrappers have no Notion equivalent; skip the tags and
      // keep the content, which arrives on its own lines.
      continue;
    } else {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: text(stripInline(trimmed)) },
      });
    }
  }

  if (inCode && codeBuffer.length) {
    blocks.push({
      object: 'block', type: 'code',
      code: { rich_text: text(codeBuffer.join('\n')), language: codeLang },
    });
  }
  return blocks;
}

/** Notion's plain rich_text has no Markdown, so drop the markers. */
function stripInline(s) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { NotesService, parseVtt, markdownToNotionBlocks, NOTE_PROMPT };
