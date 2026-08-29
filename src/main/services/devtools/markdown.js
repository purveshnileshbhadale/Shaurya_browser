'use strict';
/**
 * Markdown live preview for local `.md` files (spec §5).
 *
 * Opening a `.md` file in the browser renders it, and the file is watched so
 * saving in an editor updates the preview immediately — the point of "live".
 *
 * The renderer is a self-contained CommonMark-ish implementation. Two things
 * it does not do, on purpose: it never emits raw HTML from the document
 * (a local file is trusted, but a `.md` fetched from a repo is not), and it
 * escapes before it formats, so a code block containing `<script>` renders
 * as text.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createLogger } = require('../../util/logger');

const log = createLogger('markdown');

class MarkdownService extends EventEmitter {
  constructor(features) {
    super();
    this.features = features;
    /** file -> fs.FSWatcher */
    this._watchers = new Map();
  }

  enabled() {
    return this.features.enabled('markdownPreview');
  }

  /** Does this URL point at a local markdown file? */
  shouldIntercept(url) {
    if (!this.enabled()) return false;
    return /^file:\/\/.*\.(md|markdown|mdown|mkd)(\?|#|$)/i.test(url);
  }

  previewUrl(fileUrl) {
    const file = fileUrl.startsWith('file://') ? fileURLToPath(fileUrl) : fileUrl;
    return `shaurya://markdown/?file=${encodeURIComponent(file)}`;
  }

  /**
   * Render a file for the preview page, and start watching it.
   * @returns {Promise<{html:string, title:string, file:string, mtime:number}>}
   */
  async render(file) {
    if (!this.enabled()) throw new Error('Markdown preview is turned off in the Feature Store');

    const resolved = path.resolve(file);
    const stat = await fsp.stat(resolved);
    const source = await fsp.readFile(resolved, 'utf8');

    this._watch(resolved);

    return {
      file: resolved,
      title: firstHeading(source) || path.basename(resolved),
      html: renderMarkdown(source, path.dirname(resolved)),
      mtime: stat.mtimeMs,
      bytes: stat.size,
    };
  }

  _watch(file) {
    if (this._watchers.has(file)) return;
    try {
      const watcher = fs.watch(file, () => {
        // Editors often write via rename, which fires several events.
        clearTimeout(this._timers?.[file]);
        this._timers ||= {};
        this._timers[file] = setTimeout(() => {
          this.emit('changed', { file });
        }, 80);
      });
      this._watchers.set(file, watcher);
    } catch (err) {
      log.debug(`could not watch ${file}: ${err.message}`);
    }
  }

  unwatch(file) {
    const watcher = this._watchers.get(file);
    if (watcher) {
      watcher.close();
      this._watchers.delete(file);
    }
  }

  dispose() {
    for (const [file] of this._watchers) this.unwatch(file);
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Markdown -> HTML.
 *
 * Block-level parsing first (fences, headings, lists, tables, quotes), then
 * inline formatting on the resulting text. Escaping happens up front so no
 * document content can ever become markup.
 */
function renderMarkdown(source, baseDir = '') {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const out = [];

  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeBuffer = [];
  let listStack = [];   // { type:'ul'|'ol', indent:number }
  let paragraph = [];

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeLists = (toIndent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
      out.push(`</${listStack.pop().type}>`);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // --- fenced code ---
    const fence = /^(\s*)(```|~~~)\s*(\w+)?\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        out.push(
          `<pre><code${codeLang ? ` class="language-${escapeAttr(codeLang)}"` : ''}>`
          + escapeHtml(codeBuffer.join('\n'))
          + '</code></pre>'
        );
        inCode = false;
        codeBuffer = [];
        codeLang = '';
      } else {
        closeParagraph();
        closeLists();
        inCode = true;
        codeLang = fence[3] || '';
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuffer.push(line);
      i++;
      continue;
    }

    // --- blank ---
    if (!line.trim()) {
      closeParagraph();
      closeLists();
      i++;
      continue;
    }

    // --- heading ---
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeParagraph();
      closeLists();
      const level = heading[1].length;
      const text = inline(heading[2]);
      out.push(`<h${level} id="${slug(heading[2])}">${text}</h${level}>`);
      i++;
      continue;
    }

    // --- horizontal rule ---
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      closeParagraph();
      closeLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // --- blockquote ---
    if (/^\s*>/.test(line)) {
      closeParagraph();
      closeLists();
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'), baseDir)}</blockquote>`);
      continue;
    }

    // --- table ---
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeParagraph();
      closeLists();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        return right && left ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c, n) =>
        `<th${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(c)}</th>`).join('');
      const tb = rows.map((r) =>
        '<tr>' + r.map((c, n) =>
          `<td${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(c)}</td>`).join('')
        + '</tr>').join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // --- list item ---
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      closeParagraph();
      const indent = listItem[1].length;
      const ordered = /\d/.test(listItem[2]);
      const type = ordered ? 'ol' : 'ul';

      closeLists(indent);
      const top = listStack[listStack.length - 1];
      if (!top || top.indent < indent) {
        out.push(`<${type}>`);
        listStack.push({ type, indent });
      } else if (top.type !== type) {
        out.push(`</${top.type}>`);
        listStack.pop();
        out.push(`<${type}>`);
        listStack.push({ type, indent });
      }

      // GitHub task list checkboxes.
      let content = listItem[3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        out.push(
          `<li class="task"><input type="checkbox" disabled${checked ? ' checked' : ''}> `
          + `${inline(task[2])}</li>`
        );
      } else {
        out.push(`<li>${inline(content)}</li>`);
      }
      i++;
      continue;
    }

    // --- paragraph text ---
    closeLists();
    paragraph.push(line.trim());
    i++;
  }

  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }
  closeParagraph();
  closeLists();

  return out.join('\n');
}

/**
 * Inline formatting.
 *
 * The whole string is HTML-escaped up front, so no document content can ever
 * become markup and only the tags this function emits survive. Two
 * consequences that are easy to get wrong:
 *
 *  - Link and image *titles* arrive already escaped, so the delimiter to
 *    match is `&quot;`, not `"`. Matching a bare quote silently drops every
 *    titled link and leaves the raw Markdown on screen.
 *  - Captured groups are likewise already escaped. Escaping them a second
 *    time turns a query string like `?a=1&b=2` into `?a=1&amp;amp;b=2` and
 *    breaks the link.
 */
function inline(text) {
  let s = escapeHtml(text);

  // Code spans are extracted first so their contents are not formatted.
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // Titles are delimited by `&quot;` once the string has been escaped.
  const TITLE = '(?:\\s+&quot;([^&]*)&quot;)?';

  s = s
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\(([^)\\s]+)${TITLE}\\)`, 'g'),
      (_m, alt, src, title) =>
        `<img src="${safeHref(src)}" alt="${alt}"${title ? ` title="${title}"` : ''}>`)
    .replace(new RegExp(`\\[([^\\]]+)\\]\\(([^)\\s]+)${TITLE}\\)`, 'g'),
      (_m, label, href, title) =>
        `<a href="${safeHref(href)}"${title ? ` title="${title}"` : ''}>${label}</a>`)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    // Bare URLs become links, which is what every Markdown reader expects.
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_m, pre, url) => `${pre}<a href="${escapeAttr(url)}">${url}</a>`);

  return s.replace(/\u0000CODE(\d+)\u0000/g, (_m, n) => `<code>${codeSpans[Number(n)]}</code>`);
}

/**
 * Refuse `javascript:` and other script-bearing schemes in links. A local
 * README is trusted; one cloned from a stranger's repository is not.
 */
function safeHref(href) {
  const trimmed = String(href).trim();
  if (/^(javascript|vbscript|data):/i.test(trimmed)) return '#blocked';
  return trimmed;
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function firstHeading(source) {
  const m = /^#\s+(.+)$/m.exec(source);
  return m ? m[1].trim() : null;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function fileURLToPath(url) {
  return decodeURIComponent(url.replace(/^file:\/\//, ''));
}

module.exports = { MarkdownService, renderMarkdown, inline };
