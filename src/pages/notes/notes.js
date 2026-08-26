/**
 * Notes library: browse, read and export generated notes (spec §4).
 */
const api = window.aether;
const list = document.getElementById('list');
const main = document.getElementById('main');
const search = document.getElementById('search');

let notes = [];
let activeId = location.hash.replace('#', '') || null;

(async function start() {
  await load();
  if (activeId) open(activeId);
  search.addEventListener('input', () => load(search.value.trim()));
}());

async function load(query = '') {
  notes = await api.invoke('notes.list', { query }).catch(() => []);
  list.replaceChildren();
  if (!notes.length) {
    list.appendChild(el('div', 'empty', 'No notes yet.'));
    return;
  }
  for (const note of notes) {
    const item = el('button', `note-item${note.id === activeId ? ' is-active' : ''}`);
    item.append(el('strong', '', note.title), el('span', '', note.excerpt || ''));
    item.addEventListener('click', () => open(note.id));
    list.appendChild(item);
  }
}

async function open(id) {
  activeId = id;
  location.hash = id;
  const note = await api.invoke('notes.get', { id }).catch(() => null);
  if (!note) {
    main.replaceChildren(el('div', 'empty', 'That note no longer exists.'));
    return;
  }

  const actions = el('div', 'notes-actions');
  for (const [target, label] of [['markdown', 'Export Markdown'], ['pdf', 'Export PDF'],
    ['obsidian', 'Send to Obsidian'], ['notion', 'Send to Notion']]) {
    const button = el('button', 'btn', label);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api.invoke('notes.export', { id, target });
      } catch (err) {
        alert(err.message);
      } finally {
        button.disabled = false;
      }
    });
    actions.appendChild(button);
  }
  const remove = el('button', 'btn btn-danger', 'Delete');
  remove.addEventListener('click', async () => {
    await api.invoke('notes.remove', { id });
    activeId = null;
    main.replaceChildren(el('div', 'empty', 'Select a note'));
    load();
  });
  actions.appendChild(remove);

  const doc = el('div', 'notes-doc');
  doc.innerHTML = markdownToHtml(note.markdown || '');

  main.replaceChildren(actions);
  if (note.sourceUrl) {
    const source = el('div', 'notes-source');
    const link = el('a', '', note.sourceUrl);
    link.href = note.sourceUrl;
    source.append(document.createTextNode('Source: '), link);
    main.appendChild(source);
  }
  main.appendChild(doc);
  load(search.value.trim());
}

/**
 * Markdown for note bodies. Escapes first so nothing in a note — which was
 * generated from an untrusted web page — can become markup.
 */
function markdownToHtml(markdown) {
  const escaped = String(markdown)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    // The quiz sections use <details>; restore just those two tags.
    .replace(/&lt;details&gt;/g, '<details>').replace(/&lt;\/details&gt;/g, '</details>')
    .replace(/&lt;summary&gt;(.*?)&lt;\/summary&gt;/g, '<summary>$1</summary>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hbuldos])(.+)$/gm, '<p>$1</p>');
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
