"""SHAURYA - a search engine you can run yourself.

SHAURYA crawls pages, builds an inverted index, and ranks results with BM25
plus field boosts, phrase/proximity bonuses and a link-graph score.  The whole
engine is written against the Python standard library: no external services,
no third-party packages, one SQLite file on disk.
"""

__version__ = "1.0.0"
__engine__ = "SHAURYA"

from .config import Config
from .store import Store
from .search import Searcher, SearchResponse, Result

__all__ = [
    "Config",
    "Store",
    "Searcher",
    "SearchResponse",
    "Result",
    "__version__",
    "__engine__",
]
