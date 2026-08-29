"""Relevance scoring.

The base score is Okapi BM25.  On top of it SHAURYA adds the signals that
matter for web-shaped documents: which field a term matched, how close the
query terms sit to one another, how the corpus links to the page, and how
recently the page was seen.
"""

from __future__ import annotations

import math
import time

from .config import Config

DAY = 86400.0


def idf(total_docs: int, df: int) -> float:
    """Robertson-Sparck-Jones inverse document frequency, always positive."""
    if total_docs <= 0:
        return 0.0
    df = max(0, min(df, total_docs))
    return math.log(1.0 + (total_docs - df + 0.5) / (df + 0.5))


def bm25(tf: int, doc_length: int, avg_length: float, term_idf: float,
         k1: float = 1.2, b: float = 0.75) -> float:
    """Okapi BM25 contribution of a single term in a single document."""
    if tf <= 0:
        return 0.0
    avg_length = avg_length or 1.0
    norm = 1.0 - b + b * (doc_length / avg_length)
    return term_idf * (tf * (k1 + 1.0)) / (tf + k1 * norm)


def coverage_factor(matched: int, required: int) -> float:
    """Penalise documents that only contain some of the query's words."""
    if required <= 0:
        return 1.0
    ratio = matched / required
    return (0.25 + 0.75 * ratio) ** 2


def proximity_factor(position_lists: list[list[int]], boost: float) -> float:
    """Reward documents where the query terms occur close together.

    Finds the shortest span covering one occurrence of every term, then scales
    the boost by how tight that span is.
    """
    lists = [p for p in position_lists if p]
    if len(lists) < 2:
        return 1.0
    span = shortest_span(lists)
    if span is None:
        return 1.0
    ideal = len(lists)                     # adjacent terms: span == term count
    tightness = ideal / max(span, ideal)   # 1.0 when perfectly adjacent
    return 1.0 + boost * tightness ** 2


def shortest_span(position_lists: list[list[int]]) -> int | None:
    """Length of the smallest window containing one position from each list."""
    cursors = [0] * len(position_lists)
    best: int | None = None
    while True:
        current = []
        for i, positions in enumerate(position_lists):
            if cursors[i] >= len(positions):
                return best
            current.append(positions[cursors[i]])
        low = min(current)
        high = max(current)
        window = high - low + 1
        if best is None or window < best:
            best = window
            if best == len(position_lists):
                return best
        # Advance the list holding the leftmost position.
        cursors[current.index(low)] += 1


def phrase_hits(position_lists: list[list[int]]) -> int:
    """How many times the terms occur consecutively, in order."""
    if not position_lists or any(not p for p in position_lists):
        return 0
    if len(position_lists) == 1:
        return len(position_lists[0])
    candidates = set(position_lists[0])
    for offset, positions in enumerate(position_lists[1:], start=1):
        shifted = {p - offset for p in positions}
        candidates &= shifted
        if not candidates:
            return 0
    return len(candidates)


def freshness_factor(fetched_at: float | None, weight: float,
                     now: float | None = None) -> float:
    """A mild preference for pages fetched recently."""
    if not fetched_at or weight <= 0:
        return 1.0
    now = now if now is not None else time.time()
    age_days = max(0.0, (now - fetched_at) / DAY)
    return 1.0 + weight * math.exp(-age_days / 180.0)


def link_factor(rank: float, weight: float) -> float:
    """Fold the PageRank score into the ranking."""
    return 1.0 + weight * max(0.0, min(rank or 0.0, 1.0))


def combine(base: float, config: Config, *, coverage: float, proximity: float,
            phrase: float, link: float, fresh: float, boost: float) -> float:
    """The final score, kept in one place so it can be explained."""
    return base * coverage * proximity * phrase * link * fresh * max(boost, 0.0)
