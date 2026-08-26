/**
 * JSON tree viewer.
 *
 * Renders lazily: a collapsed node builds no children until it is opened, so
 * a 40 MB API response paints instantly instead of constructing a million
 * DOM nodes up front.
 */
const params = new URLSearchParams(location.search);
const source = params.get('src');

const tree = document.getElementById('tree');
const search = document.getElementById('search');
const stat = document.getElementById('stat');

let data = null;
let raw = '';

(async function start() {
  if (!source) return fail('No source URL was provided.');
  try {
    // Served from Chromium's cache: the document was already fetched once.
    const response = await fetch(source);
    raw = await response.text();
    data = JSON.parse(raw);
  } catch (err) {
    return fail(`Could not parse this response as JSON: ${err.message}`);
  }

  document.title = new URL(source).pathname.split('/').pop() || 'JSON';
  stat.textContent = `${formatBytes(raw.length)} · ${countNodes(data).toLocaleString()} nodes`;
  tree.replaceChildren(buildNode('', data, true, 0));
}());

document.getElementById('raw').addEventListener('click', () => {
  window.aether.invoke('tabs.navigate', { url: source });
});
document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(JSON.stringify(data, null, 2)).catch(() => {});
});
document.getElementById('expand').addEventListener('click', () => setAll(false));
document.getElementById('collapse').addEventListener('click', () => setAll(true));
search.addEventListener('input', () => applyFilter(search.value.trim().toLowerCase()));

/**
 * Build one node. Children are constructed on first expand, which is what
 * keeps a huge document responsive.
 */
function buildNode(key, value, expanded, depth) {
  const type = typeOf(value);
  const node = el('div', 'node');
  const row = el('div', 'row');

  if (type === 'object' || type === 'array') {
    const entries = type === 'array'
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);

    // Deep trees stay collapsed by default; the first two levels open.
    const startExpanded = expanded && depth < 2 && entries.length <= 200;
    node.classList.toggle('is-collapsed', !startExpanded);

    const twist = el('div', 'twist', '▾');
    node.appendChild(twist);

    if (key !== '') row.append(el('span', 'key', key), el('span', 'punct', ': '));
    row.append(el('span', 'punct', type === 'array' ? '[' : '{'));
    row.append(el('span', 'summary', type === 'array' ? ` … ${entries.length} items ]` : ` … ${entries.length} keys }`));
    row.append(el('span', 'count', String(entries.length)));
    node.appendChild(row);

    const children = el('div', 'children');
    node.appendChild(children);

    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      for (const [childKey, childValue] of entries) {
        children.appendChild(buildNode(childKey, childValue, true, depth + 1));
      }
      children.appendChild(el('div', 'punct', type === 'array' ? ']' : '}'));
    };
    if (startExpanded) build();

    const toggle = () => {
      const collapsed = node.classList.toggle('is-collapsed');
      if (!collapsed) build();
    };
    twist.addEventListener('click', toggle);
    row.addEventListener('click', (event) => {
      if (event.target.classList.contains('key')) return copyPath(node, key);
      toggle();
    });
    return node;
  }

  // ---- leaf ----
  if (key !== '') row.append(el('span', 'key', key), el('span', 'punct', ': '));
  row.appendChild(renderLeaf(value, type));
  node.appendChild(row);
  row.addEventListener('click', (event) => {
    if (event.target.classList.contains('key')) copyPath(node, key);
  });
  return node;
}

function renderLeaf(value, type) {
  if (type === 'string') {
    // URLs inside JSON are usually the next thing you want to open.
    if (/^https?:\/\//.test(value)) {
      const link = el('a', 'link', `"${value}"`);
      link.href = value;
      return link;
    }
    return el('span', 'string', `"${value}"`);
  }
  if (type === 'null') return el('span', 'null', 'null');
  return el('span', type, String(value));
}

function copyPath(node, key) {
  const parts = [];
  let cursor = node;
  while (cursor && cursor.classList?.contains('node')) {
    const own = cursor.querySelector(':scope > .row > .key')?.textContent;
    if (own) parts.unshift(/^\d+$/.test(own) ? `[${own}]` : `.${own}`);
    cursor = cursor.parentElement?.closest('.node');
  }
  const path = '$' + parts.join('').replace(/^\./, '.');
  navigator.clipboard.writeText(path).catch(() => {});

  const toast = el('div', 'path-toast', `Copied ${path}`);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1600);
}

function setAll(collapsed) {
  for (const node of tree.querySelectorAll('.node')) {
    if (!node.querySelector(':scope > .children')) continue;
    if (!collapsed) {
      node.classList.remove('is-collapsed');
      // Force a click so lazily-built children materialise.
      node.querySelector(':scope > .twist')?.dispatchEvent(new MouseEvent('click'));
      node.classList.remove('is-collapsed');
    } else {
      node.classList.add('is-collapsed');
    }
  }
}

function applyFilter(query) {
  if (!query) {
    for (const node of tree.querySelectorAll('.node')) node.classList.remove('is-hidden');
    for (const row of tree.querySelectorAll('.row')) row.classList.remove('is-match');
    return;
  }
  setAll(false);
  for (const node of tree.querySelectorAll('.node')) {
    const row = node.querySelector(':scope > .row');
    const own = row ? row.textContent.toLowerCase() : '';
    const matches = own.includes(query);
    row?.classList.toggle('is-match', matches);
    // A node stays visible if it matches or contains a match.
    const contains = node.textContent.toLowerCase().includes(query);
    node.classList.toggle('is-hidden', !contains);
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function countNodes(value) {
  const type = typeOf(value);
  if (type === 'array') return 1 + value.reduce((n, v) => n + countNodes(v), 0);
  if (type === 'object') return 1 + Object.values(value).reduce((n, v) => n + countNodes(v), 0);
  return 1;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function fail(message) {
  tree.replaceChildren(el('div', 'jv-error', message));
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
