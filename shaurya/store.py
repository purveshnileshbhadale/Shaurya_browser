"""SQLite-backed storage for the SHAURYA index.

One file holds everything: the crawl frontier, fetched documents, the inverted
index and the link graph.  Postings keep term positions (delta + varint packed)
so phrase and proximity queries are answered straight from the index.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Iterable, Iterator, Optional

SCHEMA_VERSION = 1

# Frontier states
PENDING = 0
IN_FLIGHT = 1
DONE = 2
FAILED = 3

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS docs (
    id            INTEGER PRIMARY KEY,
    url           TEXT UNIQUE NOT NULL,
    host          TEXT,
    title         TEXT,
    description   TEXT,
    headings      TEXT,
    body          TEXT,
    lang          TEXT,
    content_type  TEXT,
    content_hash  TEXT,
    status        INTEGER,
    fetched_at    REAL,
    length        INTEGER DEFAULT 0,
    rank          REAL DEFAULT 0.0,
    boost         REAL DEFAULT 1.0,
    indexed_at    REAL
);
CREATE INDEX IF NOT EXISTS docs_host ON docs(host);
CREATE INDEX IF NOT EXISTS docs_hash ON docs(content_hash);
CREATE INDEX IF NOT EXISTS docs_indexed ON docs(indexed_at);

CREATE TABLE IF NOT EXISTS terms (
    id   INTEGER PRIMARY KEY,
    term TEXT UNIQUE NOT NULL,
    df   INTEGER DEFAULT 0,
    cf   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS postings (
    term_id   INTEGER NOT NULL,
    doc_id    INTEGER NOT NULL,
    tf        INTEGER NOT NULL,
    fields    INTEGER NOT NULL DEFAULT 0,
    positions BLOB,
    PRIMARY KEY (term_id, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS postings_doc ON postings(doc_id);

CREATE TABLE IF NOT EXISTS links (
    src_id  INTEGER NOT NULL,
    dst_url TEXT NOT NULL,
    anchor  TEXT,
    PRIMARY KEY (src_id, dst_url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_url);

CREATE TABLE IF NOT EXISTS frontier (
    url      TEXT PRIMARY KEY,
    host     TEXT,
    depth    INTEGER DEFAULT 0,
    state    INTEGER DEFAULT 0,
    added_at REAL,
    error    TEXT
);
CREATE INDEX IF NOT EXISTS frontier_state ON frontier(state, depth);

CREATE TABLE IF NOT EXISTS forms (
    stem TEXT NOT NULL,
    word TEXT NOT NULL,
    n    INTEGER DEFAULT 0,
    PRIMARY KEY (stem, word)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS forms_word ON forms(word);

CREATE TABLE IF NOT EXISTS queries (
    q     TEXT PRIMARY KEY,
    hits  INTEGER DEFAULT 0,
    last  REAL
);
"""


# --------------------------------------------------------------------------
# position list codec: delta encoding + varints keeps postings small
# --------------------------------------------------------------------------

def encode_positions(positions: Iterable[int]) -> bytes:
    out = bytearray()
    prev = 0
    for pos in positions:
        delta = pos - prev
        prev = pos
        while delta >= 0x80:
            out.append((delta & 0x7F) | 0x80)
            delta >>= 7
        out.append(delta)
    return bytes(out)


def decode_positions(blob: Optional[bytes]) -> list[int]:
    if not blob:
        return []
    out: list[int] = []
    value = 0
    shift = 0
    pos = 0
    for byte in blob:
        value |= (byte & 0x7F) << shift
        if byte & 0x80:
            shift += 7
            continue
        pos += value
        out.append(pos)
        value = 0
        shift = 0
    return out


class Store:
    """Thread-safe handle on the index database."""

    def __init__(self, path: str = "shaurya.db"):
        self.path = path
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            conn.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', ?)",
                (str(SCHEMA_VERSION),),
            )

    # -- connections ------------------------------------------------------
    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30.0, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA temp_store=MEMORY")
            conn.execute("PRAGMA cache_size=-40000")
            self._local.conn = conn
        return conn

    def connect(self) -> sqlite3.Connection:
        return self.conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # -- metadata ---------------------------------------------------------
    def get_meta(self, key: str, default=None):
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value) -> None:
        with self._write_lock:
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value) if not isinstance(value, str) else value),
            )

    # -- frontier ---------------------------------------------------------
    def enqueue(self, url: str, host: str, depth: int) -> bool:
        """Add a URL to the crawl frontier.  Returns True when it is new."""
        with self._write_lock:
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO frontier(url, host, depth, state, added_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (url, host, depth, PENDING, time.time()),
            )
            return cur.rowcount > 0

    def claim(self, limit: int = 1) -> list[sqlite3.Row]:
        """Atomically take pending URLs off the frontier, shallowest first."""
        with self._write_lock:
            rows = self.conn.execute(
                "SELECT url, host, depth FROM frontier WHERE state=? "
                "ORDER BY depth ASC, added_at ASC LIMIT ?",
                (PENDING, limit),
            ).fetchall()
            if rows:
                self.conn.executemany(
                    "UPDATE frontier SET state=? WHERE url=?",
                    [(IN_FLIGHT, r["url"]) for r in rows],
                )
            return rows

    def finish(self, url: str, state: int, error: str | None = None) -> None:
        with self._write_lock:
            self.conn.execute(
                "UPDATE frontier SET state=?, error=? WHERE url=?", (state, error, url)
            )

    def frontier_counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT state, COUNT(*) AS n FROM frontier GROUP BY state"
        ).fetchall()
        names = {PENDING: "pending", IN_FLIGHT: "in_flight", DONE: "done", FAILED: "failed"}
        counts = {v: 0 for v in names.values()}
        for row in rows:
            counts[names.get(row["state"], "unknown")] = row["n"]
        return counts

    def reset_in_flight(self) -> int:
        with self._write_lock:
            cur = self.conn.execute(
                "UPDATE frontier SET state=? WHERE state=?", (PENDING, IN_FLIGHT)
            )
            return cur.rowcount

    # -- documents --------------------------------------------------------
    def put_doc(self, **fields) -> int:
        """Insert or refresh a document, returning its id."""
        cols = [
            "url", "host", "title", "description", "headings", "body", "lang",
            "content_type", "content_hash", "status", "fetched_at",
        ]
        values = [fields.get(c) for c in cols]
        with self._write_lock:
            self.conn.execute(
                f"INSERT INTO docs({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
                "ON CONFLICT(url) DO UPDATE SET "
                + ", ".join(f"{c}=excluded.{c}" for c in cols[1:])
                + ", indexed_at=NULL",
                values,
            )
            row = self.conn.execute(
                "SELECT id FROM docs WHERE url=?", (fields["url"],)
            ).fetchone()
            return row["id"]

    def get_doc(self, doc_id: int) -> Optional[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM docs WHERE id=?", (doc_id,)).fetchone()

    def get_doc_by_url(self, url: str) -> Optional[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM docs WHERE url=?", (url,)).fetchone()

    def get_docs(self, doc_ids: Iterable[int]) -> dict[int, sqlite3.Row]:
        ids = list(doc_ids)
        out: dict[int, sqlite3.Row] = {}
        for chunk_start in range(0, len(ids), 500):
            chunk = ids[chunk_start:chunk_start + 500]
            rows = self.conn.execute(
                f"SELECT * FROM docs WHERE id IN ({','.join('?' * len(chunk))})", chunk
            ).fetchall()
            out.update({r["id"]: r for r in rows})
        return out

    def docs_meta(self, doc_ids: Iterable[int]) -> dict[int, sqlite3.Row]:
        """Fetch only the columns the ranker needs, never the document body."""
        ids = list(doc_ids)
        out: dict[int, sqlite3.Row] = {}
        cols = "id, url, host, title, lang, length, rank, boost, fetched_at, content_type"
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            rows = self.conn.execute(
                f"SELECT {cols} FROM docs WHERE id IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
            out.update({r["id"]: r for r in rows})
        return out

    def doc_ids_for_hosts(self, sites: Iterable[str]) -> set[int]:
        """Every indexed document on the given sites (or their subdomains)."""
        out: set[int] = set()
        for site in sites:
            rows = self.conn.execute(
                "SELECT id FROM docs WHERE indexed_at IS NOT NULL AND "
                "(host = ? OR host = ? OR host LIKE ?)",
                (site, "www." + site, "%." + site),
            ).fetchall()
            out.update(r["id"] for r in rows)
        return out

    def all_doc_ids(self, limit: int = 10000) -> set[int]:
        rows = self.conn.execute(
            "SELECT id FROM docs WHERE indexed_at IS NOT NULL "
            "ORDER BY rank DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return {r["id"] for r in rows}

    def corpus_stats(self) -> tuple[int, float]:
        """(number of indexed documents, average document length)."""
        row = self.conn.execute(
            "SELECT COUNT(*) n, COALESCE(AVG(length), 0.0) avg FROM docs "
            "WHERE indexed_at IS NOT NULL AND length > 0"
        ).fetchone()
        return row["n"] or 0, float(row["avg"] or 0.0)

    def iter_docs(self, only_unindexed: bool = False) -> Iterator[sqlite3.Row]:
        sql = "SELECT * FROM docs"
        if only_unindexed:
            sql += " WHERE indexed_at IS NULL"
        sql += " ORDER BY id"
        cur = self.conn.execute(sql)
        while True:
            rows = cur.fetchmany(200)
            if not rows:
                break
            yield from rows

    def has_content_hash(self, content_hash: str, url: str) -> bool:
        """True when another URL already holds identical content."""
        row = self.conn.execute(
            "SELECT 1 FROM docs WHERE content_hash=? AND url<>? LIMIT 1",
            (content_hash, url),
        ).fetchone()
        return row is not None

    def mark_indexed(self, doc_id: int, length: int) -> None:
        with self._write_lock:
            self.conn.execute(
                "UPDATE docs SET indexed_at=?, length=? WHERE id=?",
                (time.time(), length, doc_id),
            )

    def set_rank(self, ranks: dict[int, float]) -> None:
        with self._write_lock:
            self.conn.executemany(
                "UPDATE docs SET rank=? WHERE id=?",
                [(score, doc_id) for doc_id, score in ranks.items()],
            )

    def delete_doc(self, doc_id: int) -> None:
        with self._write_lock:
            self.conn.execute("BEGIN")
            self._decrement_df(doc_id)
            self.conn.execute("DELETE FROM postings WHERE doc_id=?", (doc_id,))
            self.conn.execute("DELETE FROM links WHERE src_id=?", (doc_id,))
            self.conn.execute("DELETE FROM docs WHERE id=?", (doc_id,))
            self.conn.execute("COMMIT")

    def _decrement_df(self, doc_id: int) -> None:
        self.conn.execute(
            "UPDATE terms SET df = MAX(df - 1, 0), cf = MAX(cf - COALESCE("
            "(SELECT tf FROM postings p WHERE p.term_id=terms.id AND p.doc_id=?), 0), 0) "
            "WHERE id IN (SELECT term_id FROM postings WHERE doc_id=?)",
            (doc_id, doc_id),
        )

    # -- terms & postings -------------------------------------------------
    def term_ids(self, terms: Iterable[str], create: bool = False) -> dict[str, int]:
        terms = list(dict.fromkeys(terms))
        if not terms:
            return {}
        found: dict[str, int] = {}
        for start in range(0, len(terms), 500):
            chunk = terms[start:start + 500]
            rows = self.conn.execute(
                f"SELECT id, term FROM terms WHERE term IN ({','.join('?' * len(chunk))})",
                chunk,
            ).fetchall()
            found.update({r["term"]: r["id"] for r in rows})
        missing = [t for t in terms if t not in found]
        if missing and create:
            self.conn.executemany(
                "INSERT OR IGNORE INTO terms(term) VALUES (?)", [(t,) for t in missing]
            )
            for start in range(0, len(missing), 500):
                chunk = missing[start:start + 500]
                rows = self.conn.execute(
                    f"SELECT id, term FROM terms WHERE term IN ({','.join('?' * len(chunk))})",
                    chunk,
                ).fetchall()
                found.update({r["term"]: r["id"] for r in rows})
        return found

    def write_postings(self, doc_id: int, postings: dict[str, tuple[int, int, list[int]]]) -> None:
        """Replace every posting for ``doc_id``.

        ``postings`` maps term -> (tf, field mask, positions).
        """
        with self._write_lock:
            conn = self.conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                self._decrement_df(doc_id)
                conn.execute("DELETE FROM postings WHERE doc_id=?", (doc_id,))
                ids = self.term_ids(postings.keys(), create=True)
                rows = [
                    (ids[term], doc_id, tf, fields, encode_positions(positions))
                    for term, (tf, fields, positions) in postings.items()
                ]
                conn.executemany(
                    "INSERT INTO postings(term_id, doc_id, tf, fields, positions) "
                    "VALUES (?, ?, ?, ?, ?)",
                    rows,
                )
                conn.executemany(
                    "UPDATE terms SET df = df + 1, cf = cf + ? WHERE id = ?",
                    [(tf, ids[term]) for term, (tf, _, _) in postings.items()],
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    def postings_for(self, term: str, limit: int = 5000) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT p.doc_id, p.tf, p.fields, p.positions, t.df "
            "FROM terms t JOIN postings p ON p.term_id = t.id "
            "WHERE t.term = ? ORDER BY p.tf DESC LIMIT ?",
            (term, limit),
        ).fetchall()

    def doc_frequency(self, term: str) -> int:
        row = self.conn.execute("SELECT df FROM terms WHERE term=?", (term,)).fetchone()
        return row["df"] if row else 0

    def vocabulary(self, min_df: int = 1, limit: int = 100000) -> list[tuple[str, int]]:
        rows = self.conn.execute(
            "SELECT term, df FROM terms WHERE df >= ? ORDER BY df DESC LIMIT ?",
            (min_df, limit),
        ).fetchall()
        return [(r["term"], r["df"]) for r in rows]

    # -- surface forms ----------------------------------------------------
    def add_forms(self, counts: dict[tuple[str, str], int]) -> None:
        """Record how often each stem was written as each surface word."""
        if not counts:
            return
        with self._write_lock:
            self.conn.executemany(
                "INSERT INTO forms(stem, word, n) VALUES (?, ?, ?) "
                "ON CONFLICT(stem, word) DO UPDATE SET n = n + excluded.n",
                [(stem, word, n) for (stem, word), n in counts.items()],
            )

    def surface_vocabulary(self, min_df: int = 1, limit: int = 100000
                           ) -> list[tuple[str, int]]:
        """Real words the corpus uses, paired with their stem's doc frequency.

        Suggestions must be words a user can actually type back into the box,
        which is why they come from here rather than from the stem list.
        """
        rows = self.conn.execute(
            "SELECT f.word AS word, MAX(t.df) AS df FROM forms f "
            "JOIN terms t ON t.term = f.stem WHERE t.df >= ? "
            "GROUP BY f.word ORDER BY df DESC LIMIT ?",
            (min_df, limit),
        ).fetchall()
        return [(r["word"], r["df"]) for r in rows]

    def best_form(self, stem: str) -> str:
        """The most common way this stem is written."""
        row = self.conn.execute(
            "SELECT word FROM forms WHERE stem=? ORDER BY n DESC LIMIT 1", (stem,)
        ).fetchone()
        return row["word"] if row else stem

    # -- link graph -------------------------------------------------------
    def add_links(self, src_id: int, links: Iterable[tuple[str, str]]) -> None:
        rows = [(src_id, url, anchor) for url, anchor in links]
        if not rows:
            return
        with self._write_lock:
            self.conn.execute("DELETE FROM links WHERE src_id=?", (src_id,))
            self.conn.executemany(
                "INSERT OR IGNORE INTO links(src_id, dst_url, anchor) VALUES (?, ?, ?)",
                rows,
            )

    def iter_links(self) -> Iterator[tuple[int, str, str]]:
        cur = self.conn.execute("SELECT src_id, dst_url, anchor FROM links")
        while True:
            rows = cur.fetchmany(500)
            if not rows:
                break
            for row in rows:
                yield row["src_id"], row["dst_url"], row["anchor"] or ""

    def anchors_for(self, url: str) -> list[str]:
        rows = self.conn.execute(
            "SELECT anchor FROM links WHERE dst_url=? AND anchor IS NOT NULL AND anchor<>''",
            (url,),
        ).fetchall()
        return [r["anchor"] for r in rows]

    def url_to_id(self) -> dict[str, int]:
        return {
            r["url"]: r["id"]
            for r in self.conn.execute("SELECT id, url FROM docs").fetchall()
        }

    # -- query log --------------------------------------------------------
    def log_query(self, q: str) -> None:
        q = q.strip()
        if not q:
            return
        with self._write_lock:
            self.conn.execute(
                "INSERT INTO queries(q, hits, last) VALUES (?, 1, ?) "
                "ON CONFLICT(q) DO UPDATE SET hits = hits + 1, last = excluded.last",
                (q, time.time()),
            )

    def popular_queries(self, prefix: str = "", limit: int = 8) -> list[str]:
        rows = self.conn.execute(
            "SELECT q FROM queries WHERE q LIKE ? ORDER BY hits DESC, last DESC LIMIT ?",
            (prefix + "%", limit),
        ).fetchall()
        return [r["q"] for r in rows]

    # -- stats ------------------------------------------------------------
    def stats(self) -> dict:
        conn = self.conn
        docs = conn.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(length), 0) len, "
            "COUNT(indexed_at) idx FROM docs"
        ).fetchone()
        terms = conn.execute("SELECT COUNT(*) n FROM terms WHERE df > 0").fetchone()
        postings = conn.execute("SELECT COUNT(*) n FROM postings").fetchone()
        hosts = conn.execute("SELECT COUNT(DISTINCT host) n FROM docs").fetchone()
        indexed = docs["idx"] or 0
        return {
            "documents": docs["n"],
            "indexed": indexed,
            "hosts": hosts["n"],
            "terms": terms["n"],
            "postings": postings["n"],
            "tokens": docs["len"],
            "avg_doc_length": (docs["len"] / indexed) if indexed else 0.0,
            "frontier": self.frontier_counts(),
            "index_bytes": os.path.getsize(self.path) if os.path.exists(self.path) else 0,
        }
