"""The searcher: query in, ranked results out."""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict

from . import query as querylang
from . import rank as ranking
from .config import Config, F_TITLE
from .snippet import highlight, make_snippet, plain
from .store import Store, decode_positions
from .suggest import Suggester
from .text import normalize

MAX_PROXIMITY_CANDIDATES = 500   # only the top slice needs the expensive signals


@dataclass
class Result:
    """One ranked document."""

    doc_id: int
    url: str
    title: str
    snippet: str = ""
    score: float = 0.0
    host: str = ""
    display_url: str = ""
    title_html: str = ""
    lang: str = ""
    fetched_at: float = 0.0
    page_rank: float = 0.0
    explain: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["score"] = round(self.score, 4)
        data["text"] = plain(self.snippet)
        return data


@dataclass
class SearchResponse:
    """Everything the UI needs to render a result page."""

    query: str
    results: list[Result] = field(default_factory=list)
    total: int = 0
    page: int = 1
    size: int = 10
    elapsed_ms: float = 0.0
    suggestion: str | None = None
    parsed: querylang.Query | None = None

    @property
    def pages(self) -> int:
        return max(1, -(-self.total // self.size)) if self.size else 1

    @property
    def is_empty(self) -> bool:
        return not self.results

    def to_dict(self) -> dict:
        return {
            "engine": "SHAURYA",
            "query": self.query,
            "total": self.total,
            "page": self.page,
            "pages": self.pages,
            "size": self.size,
            "elapsed_ms": round(self.elapsed_ms, 2),
            "suggestion": self.suggestion,
            "results": [r.to_dict() for r in self.results],
        }


class Searcher:
    """Answers queries against an index."""

    def __init__(self, store: Store, config: Config | None = None):
        self.store = store
        self.config = config or Config()
        self.suggester = Suggester(store)

    # -- public API -------------------------------------------------------
    def search(self, text: str, page: int = 1, size: int | None = None,
               explain: bool = False, log: bool = True,
               suggest: bool = True) -> SearchResponse:
        started = time.perf_counter()
        size = size or self.config.page_size
        page = max(1, page)
        parsed = querylang.parse(text)
        response = SearchResponse(query=text or "", page=page, size=size, parsed=parsed)
        if parsed.is_empty:
            response.elapsed_ms = (time.perf_counter() - started) * 1000
            return response

        total_docs, avg_length = self.store.corpus_stats()
        if total_docs == 0:
            response.elapsed_ms = (time.perf_counter() - started) * 1000
            return response

        scored = self._score(parsed, total_docs, avg_length, explain)
        scored.sort(key=lambda item: (-item[1], item[0]))
        response.total = len(scored)

        window = scored[(page - 1) * size: (page - 1) * size + size]
        response.results = self._materialise(window, parsed)

        if suggest:
            response.suggestion = self._suggestion(parsed, len(scored))
        # Only well-spelled, productive queries feed autocomplete.
        if log and response.total and not response.suggestion:
            self.store.log_query(text.strip())
        response.elapsed_ms = (time.perf_counter() - started) * 1000
        return response

    def _suggestion(self, parsed: querylang.Query, hits: int) -> str | None:
        """Offer a spelling fix when a word is unknown or the query fell flat."""
        words = [t.raw for t in parsed.terms if not t.is_stopword]
        if not words:
            return None
        # A correction is only offered when the index has never seen one of
        # the query's words; anything else is second-guessing the user.
        unknown = any(
            self.store.doc_frequency(t.stem) == 0
            for t in parsed.terms if not t.is_stopword
        )
        if not unknown:
            return None
        suggestion = self.suggester.correct_query(" ".join(words))
        if not suggestion:
            return None
        # Never offer a correction that finds nothing.
        probe = self.search(suggestion, page=1, size=1, log=False, suggest=False)
        return suggestion if probe.total else None

    def explain(self, text: str, url: str) -> dict:
        """Why does this URL score the way it does for this query?"""
        doc = self.store.get_doc_by_url(url)
        if not doc:
            return {"error": f"not indexed: {url}"}
        response = self.search(text, page=1, size=1000, explain=True, log=False,
                               suggest=False)
        for position, result in enumerate(response.results, start=1):
            if result.doc_id == doc["id"]:
                return {"url": url, "position": position, "score": result.score,
                        "factors": result.explain}
        return {"url": url, "position": None, "score": 0.0,
                "factors": {"reason": "document did not match the query"}}

    # -- scoring ----------------------------------------------------------
    def _postings(self, stems: list[str]) -> tuple[dict, dict]:
        """stem -> {doc_id: (tf, fields, blob)} plus stem -> df."""
        postings: dict[str, dict[int, tuple[int, int, bytes]]] = {}
        dfs: dict[str, int] = {}
        for stem_text in stems:
            rows = self.store.postings_for(stem_text, self.config.candidate_limit)
            postings[stem_text] = {
                row["doc_id"]: (row["tf"], row["fields"], row["positions"])
                for row in rows
            }
            dfs[stem_text] = rows[0]["df"] if rows else 0
        return postings, dfs

    def _score(self, parsed: querylang.Query, total_docs: int, avg_length: float,
               explain: bool) -> list[tuple[int, float, dict]]:
        stems = parsed.stems
        postings, dfs = self._postings(stems)

        candidates: set[int] = set()
        for stem_text in stems:
            candidates |= postings[stem_text].keys()

        if not stems:
            # A query made only of filters ("intitle:tea", "site:x.test") still
            # has to start from somewhere.
            if parsed.intitle:
                for stem_text in parsed.intitle:
                    rows = self.store.postings_for(stem_text, self.config.candidate_limit)
                    candidates |= {r["doc_id"] for r in rows if r["fields"] & F_TITLE}
            elif parsed.sites:
                candidates = self.store.doc_ids_for_hosts(parsed.sites)
            else:
                candidates = self.store.all_doc_ids()
        if not candidates:
            return []

        # Hard filters that can be answered from the index alone.
        for excluded in parsed.excluded:
            rows = self.store.postings_for(excluded, self.config.candidate_limit)
            candidates -= {row["doc_id"] for row in rows}
        for stem_text in parsed.intitle:
            rows = self.store.postings_for(stem_text, self.config.candidate_limit)
            in_title = {row["doc_id"] for row in rows if row["fields"] & F_TITLE}
            candidates &= in_title
        if not candidates:
            return []

        # Phrase queries: every quoted phrase must actually occur.
        for phrase in parsed.phrases:
            matched = {
                doc_id for doc_id in candidates
                if self._phrase_in_doc(doc_id, phrase.stems, postings)
            }
            candidates = (candidates - matched) if phrase.negated else matched
            if not candidates:
                return []

        metas = self.store.docs_meta(candidates)
        candidates = {doc_id for doc_id in candidates if doc_id in metas}
        candidates = self._apply_doc_filters(candidates, metas, parsed)
        if not candidates:
            return []

        idfs = {s: ranking.idf(total_docs, dfs.get(s, 0)) for s in stems}
        required = parsed.required_stems or stems
        query_normal = normalize(parsed.describe())

        base_scores: list[tuple[int, float, dict]] = []
        for doc_id in candidates:
            meta = metas[doc_id]
            length = meta["length"] or 1
            score = 0.0
            matched_required = 0
            per_term: dict[str, float] = {}
            for stem_text in stems:
                entry = postings[stem_text].get(doc_id)
                if not entry:
                    continue
                tf, fields, _ = entry
                term_score = ranking.bm25(
                    tf, length, avg_length, idfs[stem_text],
                    self.config.bm25_k1, self.config.bm25_b,
                )
                term_score *= 1.0 + self.config.field_boost(fields)
                score += term_score
                if explain:
                    per_term[stem_text] = round(term_score, 4)
                if stem_text in required:
                    matched_required += 1
            if not stems:
                # Filter-only query: every survivor is equally relevant, so the
                # query-independent signals below decide the order.
                score = 1.0
            elif score <= 0:
                continue
            coverage = ranking.coverage_factor(matched_required, len(required))
            base_scores.append((doc_id, score * coverage,
                                {"terms": per_term, "coverage": round(coverage, 3)}))

        # Expensive signals only for the head of the list.
        base_scores.sort(key=lambda item: -item[1])
        head = base_scores[:MAX_PROXIMITY_CANDIDATES]
        tail = base_scores[MAX_PROXIMITY_CANDIDATES:]
        now = time.time()
        final: list[tuple[int, float, dict]] = []
        for doc_id, score, factors in head:
            meta = metas[doc_id]
            position_lists = [
                decode_positions(postings[s][doc_id][2])
                for s in stems if doc_id in postings[s]
            ]
            proximity = ranking.proximity_factor(position_lists,
                                                 self.config.proximity_boost)
            phrase = 1.0
            if len(stems) > 1 and len(position_lists) == len(stems):
                hits = ranking.phrase_hits(
                    [decode_positions(postings[s][doc_id][2]) for s in stems]
                )
                if hits:
                    phrase = 1.0 + self.config.phrase_boost
            link = ranking.link_factor(meta["rank"], self.config.rank_weight)
            fresh = ranking.freshness_factor(meta["fetched_at"],
                                             self.config.freshness_weight, now)
            title_bonus = (
                self.config.exact_title_boost
                if query_normal and normalize(meta["title"] or "") == query_normal
                else 1.0
            )
            total = ranking.combine(
                score, self.config, coverage=1.0, proximity=proximity,
                phrase=phrase, link=link, fresh=fresh,
                boost=(meta["boost"] or 1.0) * title_bonus,
            )
            if factors is not None:
                factors.update({
                    "bm25": round(score, 4), "proximity": round(proximity, 3),
                    "phrase": round(phrase, 3), "link": round(link, 3),
                    "freshness": round(fresh, 3), "title_match": title_bonus,
                    "final": round(total, 4),
                })
            final.append((doc_id, total, factors))
        final.extend(tail)
        return final

    def _apply_doc_filters(self, candidates: set[int], metas: dict,
                           parsed: querylang.Query) -> set[int]:
        def host_matches(host: str, site: str) -> bool:
            host = (host or "").removeprefix("www.")
            return host == site or host.endswith("." + site)

        keep = set()
        for doc_id in candidates:
            meta = metas[doc_id]
            url = meta["url"] or ""
            if parsed.sites and not any(host_matches(meta["host"], s) for s in parsed.sites):
                continue
            if parsed.not_sites and any(host_matches(meta["host"], s) for s in parsed.not_sites):
                continue
            if parsed.lang and (meta["lang"] or "").lower()[:2] != parsed.lang[:2]:
                continue
            if parsed.inurl and not all(fragment in url.casefold() for fragment in parsed.inurl):
                continue
            if parsed.filetype and not url.casefold().split("?")[0].endswith(
                "." + parsed.filetype
            ):
                continue
            keep.add(doc_id)
        return keep

    def _phrase_in_doc(self, doc_id: int, stems: list[str], postings: dict) -> bool:
        lists = []
        for stem_text in stems:
            entry = postings.get(stem_text, {}).get(doc_id)
            if not entry:
                return False
            lists.append(decode_positions(entry[2]))
        return ranking.phrase_hits(lists) > 0

    # -- rendering --------------------------------------------------------
    def _materialise(self, window, parsed: querylang.Query) -> list[Result]:
        docs = self.store.get_docs([doc_id for doc_id, _, _ in window])
        words = parsed.words
        results = []
        for doc_id, score, factors in window:
            doc = docs.get(doc_id)
            if doc is None:
                continue
            text = " ".join(filter(None, [doc["description"], doc["body"]]))
            results.append(
                Result(
                    doc_id=doc_id,
                    url=doc["url"],
                    title=doc["title"] or doc["url"],
                    title_html=highlight(doc["title"] or doc["url"], words),
                    snippet=make_snippet(text, words, self.config.snippet_chars),
                    score=score,
                    host=doc["host"] or "",
                    display_url=_display_url(doc["url"]),
                    lang=doc["lang"] or "",
                    fetched_at=doc["fetched_at"] or 0.0,
                    page_rank=doc["rank"] or 0.0,
                    explain=factors or {},
                )
            )
        return results


def _display_url(url: str, limit: int = 90) -> str:
    """A URL the way a results page shows it: no scheme, no trailing slash."""
    shown = url.split("://", 1)[-1]
    if shown.endswith("/"):
        shown = shown[:-1]
    shown = shown.replace("/", " › ")
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"
