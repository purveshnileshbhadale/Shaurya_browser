"""HTML, CSS and JavaScript for the SHAURYA web interface.

Kept as templates in one module so the server stays a router and the whole
engine remains a single dependency-free package.
"""

from __future__ import annotations

import html

BRAND = "SHAURYA"
TAGLINE = "Search, on your own terms."

LOGO_SVG = """
<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
  <defs>
    <linearGradient id="sg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#e11d48"/>
    </linearGradient>
  </defs>
  <circle cx="17" cy="17" r="11" fill="none" stroke="url(#sg)" stroke-width="4"/>
  <line x1="25" y1="25" x2="36" y2="36" stroke="url(#sg)"
        stroke-width="4" stroke-linecap="round"/>
</svg>
"""

CSS = """
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f6f7f9;
  --border: #e2e5ea;
  --text: #16181d;
  --muted: #5f6673;
  --link: #1a56db;
  --visited: #6b3fa0;
  --accent: #f59e0b;
  --accent-2: #e11d48;
  --mark-bg: #fff2c2;
  --mark-fg: #4a3200;
  --shadow: 0 1px 3px rgba(16, 18, 24, .08), 0 8px 24px rgba(16, 18, 24, .06);
  --radius: 26px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --surface: #1c1f25;
    --border: #2b2f37;
    --text: #e8eaed;
    --muted: #9aa2ad;
    --link: #8ab4f8;
    --visited: #c58af9;
    --mark-bg: #4a3a00;
    --mark-fg: #ffe08a;
    --shadow: 0 1px 3px rgba(0, 0, 0, .5), 0 8px 24px rgba(0, 0, 0, .35);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
a:visited { color: var(--visited); }
mark { background: var(--mark-bg); color: var(--mark-fg); padding: 0 .1em; border-radius: 3px; }

.mark { width: 1em; height: 1em; flex: none; }
.wordmark {
  display: inline-flex; align-items: center; gap: .45em;
  font-weight: 800; letter-spacing: .14em; color: var(--text);
  text-decoration: none;
}
.wordmark:hover { text-decoration: none; }
.wordmark .name {
  background: linear-gradient(105deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}

/* --- search box ------------------------------------------------------ */
.searchbox { position: relative; width: 100%; }
.searchbox form { display: flex; align-items: center; gap: .5rem; }
.field {
  display: flex; align-items: center; gap: .6rem; flex: 1;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); padding: .55rem 1rem; box-shadow: var(--shadow);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.field:focus-within { border-color: var(--accent); }
.field input {
  flex: 1; border: 0; outline: 0; background: transparent;
  color: var(--text); font-size: 1rem; min-width: 0;
}
.field .icon { color: var(--muted); flex: none; }
button.go {
  border: 0; border-radius: var(--radius); cursor: pointer;
  background: linear-gradient(105deg, var(--accent), var(--accent-2));
  color: #fff; font-weight: 600; padding: .62rem 1.25rem; font-size: .95rem;
}
button.go:hover { filter: brightness(1.06); }
.suggestions {
  position: absolute; top: calc(100% + .35rem); left: 0; right: 0; z-index: 20;
  background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: var(--shadow); overflow: hidden; display: none;
}
.suggestions.open { display: block; }
.suggestions li {
  list-style: none; padding: .5rem 1rem; cursor: pointer; font-size: .95rem;
}
.suggestions li:hover, .suggestions li.active { background: var(--surface); }
.suggestions ul { margin: 0; padding: 0; }

/* --- home ------------------------------------------------------------ */
.home {
  min-height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 2rem 1rem; gap: 1.5rem;
}
.home .wordmark { font-size: 2.9rem; }
.home .tagline { color: var(--muted); margin: -.75rem 0 .5rem; }
.home .searchbox { max-width: 620px; }
.examples { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: center; }
.chip {
  border: 1px solid var(--border); border-radius: 999px; padding: .3rem .85rem;
  font-size: .87rem; color: var(--muted); background: var(--surface);
}
.chip:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }

/* --- results --------------------------------------------------------- */
header.bar {
  position: sticky; top: 0; z-index: 10; background: var(--bg);
  border-bottom: 1px solid var(--border); padding: .85rem 1.5rem;
}
.bar-inner {
  display: flex; align-items: center; gap: 1.25rem; max-width: 1100px;
}
header.bar .wordmark { font-size: 1.25rem; }
header.bar .searchbox { max-width: 620px; }
main { max-width: 1100px; padding: 1.25rem 1.5rem 4rem; }
.meta { color: var(--muted); font-size: .85rem; margin: .25rem 0 1.5rem 0; }
.didyoumean { margin: 0 0 1.5rem; font-size: 1rem; }
.didyoumean a { font-style: italic; font-weight: 600; }
.result { margin: 0 0 1.75rem; max-width: 42rem; }
.result .url { color: var(--muted); font-size: .82rem; display: block; margin-bottom: .1rem; }
.result h2 { font-size: 1.16rem; font-weight: 500; margin: 0 0 .25rem; line-height: 1.35; }
.result p { margin: 0; color: var(--muted); font-size: .93rem; }
.empty { max-width: 42rem; color: var(--muted); }
.empty h2 { color: var(--text); }
nav.pages { display: flex; gap: .35rem; flex-wrap: wrap; margin-top: 2.5rem; align-items: center; }
nav.pages a, nav.pages span {
  min-width: 2.1rem; text-align: center; padding: .35rem .55rem;
  border-radius: 8px; font-size: .92rem;
}
nav.pages .current { background: var(--surface); font-weight: 700; color: var(--text); }
footer.foot {
  border-top: 1px solid var(--border); color: var(--muted);
  font-size: .82rem; padding: 1rem 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap;
}
@media (max-width: 640px) {
  .bar-inner { flex-wrap: wrap; }
  header.bar .searchbox { order: 3; width: 100%; max-width: none; }
  .home .wordmark { font-size: 2.1rem; }
}
"""

JS = """
(function () {
  var box = document.querySelector('.searchbox input[name=q]');
  var list = document.querySelector('.suggestions');
  if (!box) return;
  var items = [], active = -1, timer = null, lastValue = box.value;

  function close() { if (list) { list.classList.remove('open'); list.innerHTML = ''; }
                     items = []; active = -1; }

  function render(values) {
    if (!list) return;
    items = values || [];
    if (!items.length) { close(); return; }
    var ul = document.createElement('ul');
    items.forEach(function (value, i) {
      var li = document.createElement('li');
      li.textContent = value;
      li.addEventListener('mousedown', function (e) {
        e.preventDefault(); box.value = value; box.form.submit();
      });
      li.addEventListener('mouseenter', function () { setActive(i); });
      ul.appendChild(li);
    });
    list.innerHTML = '';
    list.appendChild(ul);
    list.classList.add('open');
  }

  function setActive(i) {
    active = i;
    var nodes = list.querySelectorAll('li');
    nodes.forEach(function (n, j) { n.classList.toggle('active', j === i); });
  }

  function fetchSuggestions() {
    var value = box.value.trim();
    if (value.length < 2) { close(); return; }
    fetch('/api/suggest?q=' + encodeURIComponent(value))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (box.value.trim() === value) render(data.suggestions);
      })
      .catch(close);
  }

  box.addEventListener('input', function () {
    if (box.value === lastValue) return;
    lastValue = box.value;
    clearTimeout(timer);
    timer = setTimeout(fetchSuggestions, 120);
  });

  box.addEventListener('keydown', function (e) {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
    else if (e.key === 'Enter' && active >= 0) { box.value = items[active]; }
    else if (e.key === 'Escape') { close(); }
  });

  box.addEventListener('blur', function () { setTimeout(close, 120); });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== box) {
      e.preventDefault(); box.focus(); box.select();
    }
  });
})();
"""


def _esc(text: str) -> str:
    return html.escape(text or "", quote=True)


def searchbox(value: str = "", autofocus: bool = False) -> str:
    return f"""
<div class="searchbox">
  <form action="/search" method="get" role="search" autocomplete="off">
    <label class="field">
      <span class="icon" aria-hidden="true">{LOGO_SVG.strip()}</span>
      <input type="text" name="q" value="{_esc(value)}" placeholder="Search {BRAND}"
             aria-label="Search query" {'autofocus' if autofocus else ''}>
    </label>
    <button class="go" type="submit">Search</button>
  </form>
  <div class="suggestions" role="listbox"></div>
</div>
"""


def page(title: str, body: str, *, description: str = "") -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(title)}</title>
<meta name="description" content="{_esc(description or TAGLINE)}">
<link rel="search" type="application/opensearchdescription+xml"
      title="{BRAND}" href="/opensearch.xml">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<style>{CSS}</style>
</head>
<body>
{body}
<script>{JS}</script>
</body>
</html>"""


def plural(count: int) -> str:
    return "" if count == 1 else "s"


def home(stats: dict, examples: list[str]) -> str:
    chips = "".join(
        f'<a class="chip" href="/search?q={html.escape(ex, quote=True)}">{_esc(ex)}</a>'
        for ex in examples
    )
    body = f"""
<div class="home">
  <a class="wordmark" href="/">{LOGO_SVG.strip()}<span class="name">{BRAND}</span></a>
  <p class="tagline">{TAGLINE}</p>
  {searchbox(autofocus=True)}
  <div class="examples">{chips}</div>
  <footer class="foot" style="border:0">
    <span>{stats['indexed']:,} page{plural(stats['indexed'])}</span>
    <span>{stats['terms']:,} term{plural(stats['terms'])}</span>
    <span>{stats['hosts']:,} site{plural(stats['hosts'])}</span>
    <a href="/api/stats">index status</a>
  </footer>
</div>
"""
    return page(f"{BRAND} — {TAGLINE}", body)


def results(response, stats: dict) -> str:
    query = response.query
    parts: list[str] = []
    for result in response.results:
        snippet = f"<p>{result.snippet}</p>" if result.snippet else ""
        parts.append(f"""
<article class="result">
  <a class="url" href="{_esc(result.url)}">{_esc(result.display_url)}</a>
  <h2><a href="{_esc(result.url)}">{result.title_html or _esc(result.title)}</a></h2>
  {snippet}
</article>""")

    if response.results:
        listing = "".join(parts)
    else:
        listing = f"""
<div class="empty">
  <h2>No results for “{_esc(query)}”</h2>
  <p>Try fewer words, check the spelling, or drop any
     <code>site:</code> and <code>-exclusions</code> from the query.</p>
</div>"""

    didyoumean = ""
    if response.suggestion:
        link = html.escape(response.suggestion, quote=True)
        didyoumean = (
            f'<p class="didyoumean">Did you mean '
            f'<a href="/search?q={link}">{_esc(response.suggestion)}</a>?</p>'
        )

    body = f"""
<header class="bar">
  <div class="bar-inner">
    <a class="wordmark" href="/">{LOGO_SVG.strip()}<span class="name">{BRAND}</span></a>
    {searchbox(query)}
  </div>
</header>
<main>
  <p class="meta">{response.total:,} result{'' if response.total == 1 else 's'}
     &middot; {response.elapsed_ms:.0f} ms
     &middot; page {response.page} of {response.pages}</p>
  {didyoumean}
  {listing}
  {pagination(response)}
</main>
<footer class="foot">
  <span>{BRAND} &middot; {stats['indexed']:,} page{plural(stats['indexed'])} indexed</span>
  <a href="/">New search</a>
</footer>
"""
    return page(f"{query} — {BRAND}", body, description=f"{BRAND} results for {query}")


def pagination(response) -> str:
    if response.pages <= 1:
        return ""
    query = html.escape(response.query, quote=True)
    links = []
    if response.page > 1:
        links.append(f'<a href="/search?q={query}&amp;p={response.page - 1}">Previous</a>')
    start = max(1, response.page - 4)
    end = min(response.pages, start + 9)
    for number in range(start, end + 1):
        if number == response.page:
            links.append(f'<span class="current">{number}</span>')
        else:
            links.append(f'<a href="/search?q={query}&amp;p={number}">{number}</a>')
    if response.page < response.pages:
        links.append(f'<a href="/search?q={query}&amp;p={response.page + 1}">Next</a>')
    return f'<nav class="pages">{"".join(links)}</nav>'


def opensearch(base_url: str) -> str:
    """Lets a browser add SHAURYA as a search engine."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>{BRAND}</ShortName>
  <Description>{TAGLINE}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">{_esc(base_url)}/static/favicon.svg</Image>
  <Url type="text/html" method="get" template="{_esc(base_url)}/search?q={{searchTerms}}"/>
  <Url type="application/json" method="get"
       template="{_esc(base_url)}/api/search?q={{searchTerms}}"/>
  <Url type="application/x-suggestions+json" method="get"
       template="{_esc(base_url)}/api/suggest?q={{searchTerms}}&amp;format=opensearch"/>
  <moz:SearchForm xmlns:moz="http://www.mozilla.org/2006/browser/search/">{_esc(base_url)}</moz:SearchForm>
</OpenSearchDescription>"""


FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#e11d48"/>
  </linearGradient></defs>
  <circle cx="17" cy="17" r="11" fill="none" stroke="url(#g)" stroke-width="4"/>
  <line x1="25" y1="25" x2="36" y2="36" stroke="url(#g)" stroke-width="4" stroke-linecap="round"/>
</svg>"""
