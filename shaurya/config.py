"""Tunable knobs for SHAURYA.

Everything the engine needs to be told is gathered here so the crawler, the
indexer and the ranker cannot drift apart on defaults.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict, fields as dc_fields

DEFAULT_INDEX = os.environ.get("SHAURYA_INDEX", "shaurya.db")

# Field identifiers, stored as a bitmask on every posting.
F_TITLE = 1
F_URL = 2
F_HEADING = 4
F_DESCRIPTION = 8
F_BODY = 16
F_ANCHOR = 32

FIELD_NAMES = {
    F_TITLE: "title",
    F_URL: "url",
    F_HEADING: "heading",
    F_DESCRIPTION: "description",
    F_BODY: "body",
    F_ANCHOR: "anchor",
}


@dataclass
class Config:
    """Engine configuration.

    Attributes are grouped by the stage that reads them.  ``Config()`` on its
    own is a sensible engine; the CLI overrides individual fields.
    """

    # --- storage ---------------------------------------------------------
    index_path: str = DEFAULT_INDEX

    # --- crawler ---------------------------------------------------------
    user_agent: str = "SHAURYA/1.0 (+https://github.com/shaurya-search/shaurya)"
    max_pages: int = 500
    max_depth: int = 3
    threads: int = 8
    request_timeout: float = 15.0
    crawl_delay: float = 0.5          # seconds between hits on one host
    max_bytes: int = 4 * 1024 * 1024  # skip documents larger than this
    obey_robots: bool = True
    same_host_only: bool = False
    allow_hosts: tuple[str, ...] = ()
    deny_patterns: tuple[str, ...] = ()

    # --- ranking ---------------------------------------------------------
    bm25_k1: float = 1.2
    bm25_b: float = 0.75
    field_boosts: dict[str, float] = field(
        default_factory=lambda: {
            "title": 2.6,
            "url": 1.1,
            "heading": 1.4,
            "description": 0.9,
            "body": 0.0,   # body is the baseline, it earns no extra boost
            "anchor": 1.2,
        }
    )
    phrase_boost: float = 3.0      # exact phrase match multiplier contribution
    proximity_boost: float = 1.5   # reward terms occurring near each other
    rank_weight: float = 2.0       # weight of the link-graph (PageRank) score
    freshness_weight: float = 0.15 # mild preference for recently fetched pages
    exact_title_boost: float = 2.0 # query equals the title
    candidate_limit: int = 5000    # postings scanned per term before cutoff

    # --- serving ---------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8080
    page_size: int = 10
    snippet_chars: int = 260

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        known = {f.name for f in dc_fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def field_boost(self, mask: int) -> float:
        """Extra multiplier earned by a term appearing in high-value fields."""
        boost = 0.0
        for bit, name in FIELD_NAMES.items():
            if mask & bit:
                boost += self.field_boosts.get(name, 0.0)
        return boost
