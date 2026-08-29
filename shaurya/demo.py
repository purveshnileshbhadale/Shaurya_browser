"""A small built-in corpus so SHAURYA can be tried without crawling anything."""

from __future__ import annotations

from .store import Store

DOCUMENTS = [
    (
        "https://shaurya.local/docs/what-is-a-search-engine",
        "What is a search engine?",
        "A search engine is three programs wearing one coat: a crawler that "
        "fetches documents, an indexer that turns those documents into a "
        "lookup structure, and a query engine that ranks the results. SHAURYA "
        "implements all three in the Python standard library.",
    ),
    (
        "https://shaurya.local/docs/inverted-index",
        "The inverted index",
        "An inverted index maps each term to the list of documents that "
        "contain it, together with how often the term occurs and where. "
        "Searching for a word becomes a dictionary lookup instead of a scan "
        "over every document. SHAURYA stores its postings in SQLite with the "
        "positions delta-encoded as varints.",
    ),
    (
        "https://shaurya.local/docs/bm25",
        "Ranking with BM25",
        "BM25 scores a document by how often the query terms appear in it, "
        "damped so that the tenth occurrence counts for far less than the "
        "first, and normalised by document length so long pages do not win by "
        "sheer size. Rare terms carry more weight than common ones through "
        "inverse document frequency.",
    ),
    (
        "https://shaurya.local/docs/crawler",
        "Writing a polite crawler",
        "A polite crawler reads robots.txt before it fetches anything, waits "
        "between requests to the same host, identifies itself with a real user "
        "agent, and never follows a link into an infinite calendar. SHAURYA "
        "obeys crawl-delay and refuses to download anything that is not text.",
    ),
    (
        "https://shaurya.local/docs/pagerank",
        "PageRank and the link graph",
        "PageRank treats the web as a graph and asks where a random surfer "
        "would spend their time. A page linked to by important pages becomes "
        "important itself. The score is query independent, so SHAURYA computes "
        "it once after crawling and folds it into every ranking.",
    ),
    (
        "https://shaurya.local/docs/stemming",
        "Stemming and tokenization",
        "Tokenization splits text into words; stemming reduces those words to "
        "a common root so that searching for running also finds ran and runs. "
        "SHAURYA uses the Porter stemmer, and keeps the original spelling of "
        "every word so suggestions show real words rather than stems.",
    ),
    (
        "https://shaurya.local/docs/phrase-queries",
        "Phrase and proximity queries",
        "Quoting a phrase asks the engine for documents where the words appear "
        "next to each other in that order. This needs term positions in the "
        "index. Even without quotes, documents where the query words sit close "
        "together are usually better answers, which is what a proximity boost "
        "rewards.",
    ),
    (
        "https://shaurya.local/docs/snippets",
        "Building result snippets",
        "A snippet should show the part of the page that answers the query. "
        "SHAURYA slides a window over the document text, keeps the passage "
        "containing the most distinct query terms, and marks those terms so "
        "the reader can see why the result matched.",
    ),
    (
        "https://shaurya.local/docs/spelling",
        "Did you mean: spelling correction",
        "Spelling correction compares an unknown query word against the "
        "vocabulary the index already holds, using Damerau-Levenshtein edit "
        "distance, and offers the closest more common word. A word the corpus "
        "actually uses is never treated as a misspelling.",
    ),
    (
        "https://shaurya.local/docs/query-syntax",
        "SHAURYA query syntax",
        "Quote a phrase to require it exactly. Prefix a word with a minus sign "
        "to exclude it. Use site:example.com to stay on one site, intitle: to "
        "demand a word in the title, inurl: to match the address, and OR "
        "between two words when either will do.",
    ),
    (
        "https://shaurya.local/docs/robots",
        "robots.txt and crawl etiquette",
        "The robots exclusion standard lets a site tell crawlers which paths "
        "are off limits and how slowly to fetch. Ignoring it gets a crawler "
        "blocked and is rude besides. SHAURYA caches each host's rules for the "
        "duration of a crawl.",
    ),
    (
        "https://shaurya.local/docs/deduplication",
        "Duplicate detection",
        "The same page often lives at several addresses. SHAURYA normalises "
        "URLs, honours the canonical link element, and hashes the extracted "
        "text so a page already stored under another address is not indexed "
        "twice.",
    ),
]


def load(store: Store) -> int:
    """Index the demo corpus.  Returns how many documents were added."""
    from .indexer import index_text

    for url, title, body in DOCUMENTS:
        index_text(store, url, title, body)
    return len(DOCUMENTS)
