"""Index construction.

Each document is flattened into a single token stream — title, URL words,
headings, description, body, then inbound anchor text — and every term is
written to the inverted index with its frequency, the fields it appeared in
and its positions.  Fields are separated by a position gap so a phrase query
can never match across a field boundary.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Iterable

from . import urls as urlutil
from .config import (
    Config, F_ANCHOR, F_BODY, F_DESCRIPTION, F_HEADING, F_TITLE, F_URL,
)
from .store import Store
from .text import analyze, analyze_pairs

FIELD_GAP = 16          # positions inserted between fields
MAX_ANCHORS = 40        # inbound anchors folded into a document


def build_streams(doc: dict, anchors: Iterable[str] = ()
                  ) -> list[tuple[int, list[tuple[str, str]]]]:
    """Return the (word, stem) stream for each field of a document."""
    anchor_text = " ".join(list(anchors)[:MAX_ANCHORS])
    return [
        (F_TITLE, analyze_pairs(doc.get("title") or "")),
        (F_URL, analyze_pairs(urlutil.words(doc.get("url") or ""))),
        (F_HEADING, analyze_pairs(doc.get("headings") or "")),
        (F_DESCRIPTION, analyze_pairs(doc.get("description") or "")),
        (F_BODY, analyze_pairs(doc.get("body") or "")),
        (F_ANCHOR, analyze_pairs(anchor_text)),
    ]


def postings_for_doc(streams) -> tuple[dict[str, tuple[int, int, list[int]]], int]:
    """Collapse field streams into term -> (tf, field mask, positions)."""
    tf: dict[str, int] = defaultdict(int)
    fields: dict[str, int] = defaultdict(int)
    positions: dict[str, list[int]] = defaultdict(list)
    cursor = 0
    for field_bit, pairs in streams:
        for _word, token in pairs:
            tf[token] += 1
            fields[token] |= field_bit
            positions[token].append(cursor)
            cursor += 1
        if pairs:
            cursor += FIELD_GAP
    postings = {
        term: (tf[term], fields[term], positions[term]) for term in tf
    }
    return postings, cursor


def surface_forms(streams) -> dict[tuple[str, str], int]:
    """Count (stem, word) pairs so suggestions can use real spellings."""
    counts: dict[tuple[str, str], int] = defaultdict(int)
    for _field_bit, pairs in streams:
        for word, token in pairs:
            counts[(token, word)] += 1
    return counts


class Indexer:
    """Turns stored documents into inverted-index entries."""

    def __init__(self, store: Store, config: Config | None = None):
        self.store = store
        self.config = config or Config()

    def index_doc(self, doc) -> int:
        """Index one document row; returns its token count."""
        data = dict(doc)
        anchors = self.store.anchors_for(data["url"])
        streams = build_streams(data, anchors)
        postings, length = postings_for_doc(streams)
        if not postings:
            self.store.mark_indexed(data["id"], 0)
            return 0
        self.store.write_postings(data["id"], postings)
        self.store.add_forms(surface_forms(streams))
        self.store.mark_indexed(data["id"], length)
        return length

    def run(self, rebuild: bool = False, progress=None) -> dict:
        """Index every document that needs it."""
        started = time.time()
        count = 0
        tokens = 0
        for doc in list(self.store.iter_docs(only_unindexed=not rebuild)):
            tokens += self.index_doc(doc)
            count += 1
            if progress and count % 25 == 0:
                progress(count)
        stats = self.store.stats()
        self.store.set_meta("last_indexed", str(time.time()))
        self.store.set_meta("avg_doc_length", str(stats["avg_doc_length"]))
        return {
            "documents": count,
            "tokens": tokens,
            "terms": stats["terms"],
            "postings": stats["postings"],
            "elapsed": round(time.time() - started, 2),
        }


def index_text(
    store: Store,
    url: str,
    title: str,
    body: str,
    *,
    description: str = "",
    headings: str = "",
    config: Config | None = None,
) -> int:
    """Add a document straight from text, bypassing the crawler.

    This is what ``shaurya add`` and the local-file importer use.
    """
    import hashlib

    doc_id = store.put_doc(
        url=url,
        host=urlutil.host(url) or "local",
        title=title,
        description=description,
        headings=headings,
        body=body,
        lang="",
        content_type="text/plain",
        content_hash=hashlib.sha256(body.encode("utf-8", "replace")).hexdigest()[:32],
        status=200,
        fetched_at=time.time(),
    )
    Indexer(store, config).index_doc(store.get_doc(doc_id))
    return doc_id
