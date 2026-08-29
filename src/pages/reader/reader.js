/**
 * Reader mode view.
 *
 * The article was extracted in the page by the content preload; this renders
 * it with typography controls that persist per profile.
 */
const api = window.shaurya;
const article = document.getElementById('article');
const toolbar = document.getElementById('toolbar');

const prefs = load();
apply();

(async function start() {
  const tabId = new URLSearchParams(location.search).get('tab');
  let data = null;
  try {
    const response = await fetch(`shaurya://api/reader?tab=${encodeURIComponent(tabId)}`);
    if (response.ok) data = await response.json();
  } catch { /* fall through to the message below */ }

  if (!data || data.error) {
    article.replaceChildren(el('p', 'dim',
      'This page could not be converted into an article. Reader mode works on pages with '
      + 'a clear body of prose.'));
    return;
  }

  document.title = data.title || 'Reader';
  article.replaceChildren();

  article.appendChild(el('h1', '', data.title || ''));

  const byline = el('div', 'byline');
  if (data.byline) byline.appendChild(el('span', '', data.byline));
  if (data.siteName) byline.appendChild(el('span', '', data.siteName));
  byline.appendChild(el('span', '', `${data.readingMinutes} min read`));
  if (data.publishedAt) {
    byline.appendChild(el('span', '', new Date(data.publishedAt).toLocaleDateString()));
  }
  const original = el('a', '', 'View original');
  original.href = data.url;
  byline.appendChild(original);
  article.appendChild(byline);

  // The extractor already stripped scripts, handlers and every attribute
  // outside a small allowlist, so this content is inert markup.
  const body = document.createElement('div');
  body.innerHTML = data.html;
  article.appendChild(body);
}());

buildToolbar();

function buildToolbar() {
  toolbar.append(
    button('A-', () => bump(-1)),
    button('A+', () => bump(1)),
    button('Width', () => {
      prefs.measure = prefs.measure === '68ch' ? '54ch' : prefs.measure === '54ch' ? '84ch' : '68ch';
      apply(); save();
    }),
    button('Theme', () => {
      prefs.theme = prefs.theme === 'default' ? 'sepia' : 'default';
      apply(); save();
    }),
    button('Exit', () => api.invoke('reader.toggle', {}))
  );
}

function bump(direction) {
  prefs.size = Math.max(14, Math.min(26, prefs.size + direction));
  apply();
  save();
}

function apply() {
  const root = document.documentElement;
  root.style.setProperty('--reader-size', `${prefs.size}px`);
  root.style.setProperty('--measure', prefs.measure);
  root.dataset.readerTheme = prefs.theme;
}

function load() {
  try {
    return { size: 19, measure: '68ch', theme: 'default',
      ...JSON.parse(localStorage.getItem('shaurya.reader') || '{}') };
  } catch {
    return { size: 19, measure: '68ch', theme: 'default' };
  }
}

function save() {
  try { localStorage.setItem('shaurya.reader', JSON.stringify(prefs)); } catch { /* ignore */ }
}

function button(label, onclick) {
  const node = el('button', 'btn btn-ghost', label);
  node.addEventListener('click', onclick);
  return node;
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
