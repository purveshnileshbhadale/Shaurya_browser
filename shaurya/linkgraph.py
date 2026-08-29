"""Link-graph scoring.

PageRank over the crawled link graph gives SHAURYA a query-independent notion
of which pages the corpus itself considers important.
"""

from __future__ import annotations

from collections import defaultdict

from .store import Store

DAMPING = 0.85
ITERATIONS = 25
TOLERANCE = 1e-6


def compute_pagerank(store: Store, damping: float = DAMPING,
                     iterations: int = ITERATIONS) -> dict[int, float]:
    """Return doc_id -> PageRank, normalised so the highest scoring page is 1.0."""
    url_to_id = store.url_to_id()
    if not url_to_id:
        return {}

    outgoing: dict[int, set[int]] = defaultdict(set)
    for src_id, dst_url, _anchor in store.iter_links():
        dst_id = url_to_id.get(dst_url)
        if dst_id is not None and dst_id != src_id:
            outgoing[src_id].add(dst_id)

    ids = list(url_to_id.values())
    n = len(ids)
    incoming: dict[int, list[int]] = defaultdict(list)
    out_degree: dict[int, int] = {}
    for src_id, targets in outgoing.items():
        out_degree[src_id] = len(targets)
        for dst_id in targets:
            incoming[dst_id].append(src_id)

    rank = {doc_id: 1.0 / n for doc_id in ids}
    dangling = [doc_id for doc_id in ids if not out_degree.get(doc_id)]

    for _ in range(iterations):
        # Pages with no outgoing links spill their score evenly over the corpus.
        leaked = sum(rank[doc_id] for doc_id in dangling) / n
        base = (1.0 - damping) / n + damping * leaked
        updated = {}
        delta = 0.0
        for doc_id in ids:
            inbound = sum(
                rank[src] / out_degree[src] for src in incoming.get(doc_id, ())
            )
            value = base + damping * inbound
            updated[doc_id] = value
            delta += abs(value - rank[doc_id])
        rank = updated
        if delta < TOLERANCE:
            break

    top = max(rank.values()) if rank else 0.0
    if top > 0:
        rank = {doc_id: score / top for doc_id, score in rank.items()}
    return rank


def update_ranks(store: Store) -> dict:
    """Recompute PageRank and persist it on the documents."""
    ranks = compute_pagerank(store)
    if ranks:
        store.set_rank(ranks)
    top = sorted(ranks.items(), key=lambda kv: -kv[1])[:5]
    docs = store.get_docs([doc_id for doc_id, _ in top])
    return {
        "documents": len(ranks),
        "top": [
            {"url": docs[doc_id]["url"], "rank": round(score, 4)}
            for doc_id, score in top
            if doc_id in docs
        ],
    }
