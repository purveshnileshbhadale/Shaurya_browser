# SHAURYA

**A search engine you can run yourself.**

SHAURYA crawls pages, builds an inverted index, and ranks results with BM25 plus
field boosts, phrase and proximity signals, and a link-graph score. It ships with
a web interface, a JSON API and a command line client.

It is written entirely against the Python standard library: **no third-party
packages, no external services**. The whole engine is one SQLite file plus this
package.

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌───────────┐
│ crawler  │──▶│ indexer  │──▶│ inverted     │──▶│ searcher  │──▶ web UI
│ robots,  │   │ analyse, │   │ index        │   │ BM25 +    │    JSON API
│ politely │   │ position │   │ (SQLite)     │   │ signals   │    CLI
└──────────┘   └──────────┘   └──────────────┘   └───────────┘
```

## Quick start

```bash
git clone https://github.com/purveshnileshbhadale/Shaurya_browser
cd Shaurya_browser

python3 -m shaurya demo --serve        # built-in corpus, then open the UI
```

Then visit <http://127.0.0.1:8080>.

To index something real:

```bash
python3 -m shaurya crawl https://example.com --same-host -n 200
python3 -m shaurya search "your query here"
python3 -m shaurya serve
```

Install it as a command (`shaurya` instead of `python3 -m shaurya`):

```bash
pip install -e .
```

## Query syntax

| Query | Meaning |
| --- | --- |
| `coffee brewing` | Both words; documents containing all of them rank highest |
| `"french press"` | The exact phrase, words adjacent and in order |
| `coffee -instant` | Contains `coffee`, does not contain `instant` |
| `site:example.com` | Only pages on that site (and its subdomains) |
| `-site:spam.example` | Everything except that site |
| `intitle:brewing` | The word must appear in the page title |
| `inurl:docs` | The word must appear in the URL |
| `lang:en` | Only pages that declared that language |
| `filetype:html` | Only URLs ending in that extension |
| `coffee OR tea` | Either word satisfies the query |

Filters can be combined: `"burr grinder" site:example.com -blade intitle:coffee`.

## Command line

| Command | What it does |
| --- | --- |
| `shaurya demo [--serve]` | Load the built-in corpus to try the engine immediately |
| `shaurya crawl URL...` | Fetch, index and rank a site |
| `shaurya add PATH...` | Index local `.txt`, `.md` and `.html` files |
| `shaurya index [--rebuild]` | Build the inverted index from stored documents |
| `shaurya rank` | Recompute PageRank over the link graph |
| `shaurya search QUERY` | Query from the terminal (`--json`, `--explain`) |
| `shaurya serve` | Run the web interface |
| `shaurya stats` | Describe the index |
| `shaurya explain URL QUERY` | Show exactly why a page ranks where it does |
| `shaurya clear` | Empty the index |

Useful crawl flags: `--same-host` (never leave the seed sites), `-n/--max-pages`,
`-d/--depth`, `--delay` (seconds between requests to one host), `--allow HOST`,
`--deny REGEX`.

Every command takes `--index PATH` to work on a different index file
(default `shaurya.db`, or `$SHAURYA_INDEX`).

## HTTP API

| Endpoint | Returns |
| --- | --- |
| `GET /search?q=…&p=1` | The results page (HTML) |
| `GET /api/search?q=…&page=1&size=10&explain=1` | Results as JSON |
| `GET /api/suggest?q=…` | Autocomplete suggestions |
| `GET /api/explain?q=…&url=…` | The ranking factors for one URL |
| `GET /api/stats` | Index size, term count, crawl frontier |
| `GET /opensearch.xml` | Lets a browser add SHAURYA as a search engine |
| `GET /healthz` | Liveness check |

```bash
curl 'http://127.0.0.1:8080/api/search?q=inverted+index&size=3' | python3 -m json.tool
```

### Add SHAURYA to your browser

With the server running, visit it once: browsers that support OpenSearch discover
`/opensearch.xml` and offer SHAURYA as a search engine, so you can search your own
index straight from the address bar.

## How ranking works

The base score is Okapi BM25: term frequency damped so the tenth occurrence of a
word counts far less than the first, normalised by document length, and weighted
by inverse document frequency so rare words matter more. On top of that, SHAURYA
multiplies in the signals that matter for web-shaped documents:

- **Field boosts** — a match in the title, a heading, the URL or inbound anchor
  text counts for more than one buried in the body.
- **Coverage** — documents containing every query word beat documents containing
  only some.
- **Proximity** — the shortest window containing all query terms; tighter is better.
- **Phrases** — terms occurring adjacent and in order earn a large bonus, and a
  quoted phrase is a hard requirement rather than a bonus.
- **PageRank** — computed over the crawled link graph, so pages the corpus itself
  points at rank higher.
- **Freshness** — a mild preference for recently fetched pages.

`shaurya explain URL QUERY` prints each factor for a single document, so a
ranking decision can always be traced:

```console
$ shaurya explain https://shaurya.local/docs/bm25 ranking documents
{
  "url": "https://shaurya.local/docs/bm25",
  "position": 1,
  "score": 20.498065511779654,
  "factors": {
    "terms": {
      "rank": 4.5907,
      "document": 1.3315
    },
    "coverage": 1.0,
    "bm25": 5.9223,
    "proximity": 1.003,
    "phrase": 1.0,
    "link": 3.0,
    "freshness": 1.15,
    "title_match": 1.0,
    "final": 20.4981
  }
}
```

## How the pieces fit

| Module | Responsibility |
| --- | --- |
| `shaurya/crawler.py` | Polite multi-threaded fetching: robots.txt, per-host rate limits, budgets |
| `shaurya/htmlparse.py` | Title, description, headings, readable text, links and anchors |
| `shaurya/urls.py` | URL normalisation so one page is one index entry |
| `shaurya/text.py` | Normalisation, tokenisation, Porter stemming |
| `shaurya/indexer.py` | Flattens documents into a token stream and writes postings |
| `shaurya/store.py` | SQLite schema, postings codec, frontier, link graph |
| `shaurya/rank.py` | BM25 and the ranking signals |
| `shaurya/query.py` | The query language |
| `shaurya/search.py` | Filtering, scoring, pagination |
| `shaurya/snippet.py` | Picks and highlights the passage that answers the query |
| `shaurya/suggest.py` | Autocomplete and "did you mean" |
| `shaurya/linkgraph.py` | PageRank |
| `shaurya/server.py`, `web.py` | HTTP server and interface |

### Notes on the index

Postings store term positions, delta-encoded as varints, which is what makes
phrase and proximity queries possible. Fields are separated by a position gap so
a phrase can never match across a field boundary. Stems are index keys, not
words — SHAURYA also records the surface spellings it saw, so suggestions offer
real words (`coffee`) rather than stems (`coffe`).

## Crawling responsibly

SHAURYA reads `robots.txt` before fetching, honours `crawl-delay`, waits between
requests to the same host, identifies itself in the user agent, respects
`noindex` and `nofollow`, and refuses to download anything that is not text.
`--ignore-robots` exists for crawling your own sites; please leave it alone
otherwise.

## Tests

```bash
python3 -m unittest discover -s tests -t .
```

156 tests covering the stemmer against Porter's published vectors, URL
normalisation, HTML extraction, the postings codec and index bookkeeping, the
query language, every ranking primitive, search behaviour end to end, a real
crawl against a local HTTP server, the web API and the CLI.

## License

MIT. See [LICENSE](LICENSE).
