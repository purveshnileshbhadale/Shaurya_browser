"""The SHAURYA crawler.

A breadth-first, polite, multi-threaded fetcher.  It honours robots.txt, rate
limits itself per host, refuses to download anything that is not text, and
stores every page it keeps in the index database along with its outgoing links.
"""

from __future__ import annotations

import gzip
import hashlib
import re
import threading
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import dataclass, field
from urllib.robotparser import RobotFileParser

from . import urls as urlutil
from .config import Config
from .htmlparse import decode, parse_html, parse_text
from .store import DONE, FAILED, Store

_TEXT_TYPES = ("text/html", "application/xhtml", "text/plain", "application/xml",
               "text/xml", "application/json", "text/markdown")


@dataclass
class CrawlStats:
    """Counters describing one crawl run."""

    fetched: int = 0
    stored: int = 0
    skipped: int = 0
    failed: int = 0
    duplicates: int = 0
    bytes: int = 0
    started: float = field(default_factory=time.time)

    @property
    def elapsed(self) -> float:
        return time.time() - self.started

    def as_dict(self) -> dict:
        return {
            "fetched": self.fetched, "stored": self.stored, "skipped": self.skipped,
            "failed": self.failed, "duplicates": self.duplicates,
            "bytes": self.bytes, "elapsed": round(self.elapsed, 2),
        }


class RobotsCache:
    """Per-host robots.txt rules, fetched once and remembered."""

    def __init__(self, user_agent: str, timeout: float = 10.0):
        self.user_agent = user_agent
        self.timeout = timeout
        self._cache: dict[str, RobotFileParser | None] = {}
        self._lock = threading.Lock()

    def _parser(self, scheme: str, host: str) -> RobotFileParser | None:
        key = f"{scheme}://{host}"
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        parser: RobotFileParser | None = RobotFileParser()
        parser.set_url(f"{key}/robots.txt")
        try:
            request = urllib.request.Request(
                f"{key}/robots.txt", headers={"User-Agent": self.user_agent}
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(512 * 1024).decode("utf-8", "replace")
            parser.parse(body.splitlines())
        except Exception:
            # No robots.txt (or unreachable) means nothing is disallowed.
            parser = None
        with self._lock:
            self._cache[key] = parser
        return parser

    def allowed(self, url: str) -> bool:
        scheme, _, rest = url.partition("://")
        host = rest.split("/", 1)[0]
        parser = self._parser(scheme, host)
        if parser is None:
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:
            return True

    def delay(self, url: str, default: float) -> float:
        scheme, _, rest = url.partition("://")
        host = rest.split("/", 1)[0]
        parser = self._parser(scheme, host)
        if parser is None:
            return default
        try:
            declared = parser.crawl_delay(self.user_agent)
        except Exception:
            declared = None
        return max(default, float(declared)) if declared else default


class HostThrottle:
    """Keeps at least ``delay`` seconds between requests to the same host."""

    def __init__(self, delay: float):
        self.delay = delay
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str, delay: float | None = None) -> None:
        delay = self.delay if delay is None else delay
        while True:
            with self._lock:
                now = time.monotonic()
                ready = self._next.get(host, 0.0)
                if now >= ready:
                    self._next[host] = now + delay
                    return
                sleep_for = ready - now
            time.sleep(min(sleep_for, 5.0))


class Crawler:
    """Fetches pages into a :class:`~shaurya.store.Store`."""

    def __init__(self, store: Store, config: Config | None = None, on_page=None):
        self.store = store
        self.config = config or Config()
        self.robots = RobotsCache(self.config.user_agent, self.config.request_timeout)
        self.throttle = HostThrottle(self.config.crawl_delay)
        self.stats = CrawlStats()
        self.on_page = on_page          # optional callback(url, title, status)
        self._deny = [re.compile(p) for p in self.config.deny_patterns]
        self._seed_hosts: set[str] = set()
        self._stop = threading.Event()
        self._budget_lock = threading.Lock()

    # -- seeding ----------------------------------------------------------
    def seed(self, seeds) -> int:
        added = 0
        for raw in seeds:
            url = urlutil.normalize(raw)
            if not url:
                continue
            host = urlutil.host(url)
            self._seed_hosts.add(urlutil.registrable(host))
            if self.store.enqueue(url, host, 0):
                added += 1
        return added

    # -- policy -----------------------------------------------------------
    def allowed(self, url: str) -> bool:
        if urlutil.is_probably_binary(url):
            return False
        if any(pattern.search(url) for pattern in self._deny):
            return False
        host = urlutil.host(url)
        if self.config.allow_hosts and not any(
            host == h or host.endswith("." + h) for h in self.config.allow_hosts
        ):
            return False
        if self.config.same_host_only and self._seed_hosts:
            if urlutil.registrable(host) not in self._seed_hosts:
                return False
        if self.config.obey_robots and not self.robots.allowed(url):
            return False
        return True

    # -- fetching ---------------------------------------------------------
    def fetch(self, url: str) -> tuple[int, str, bytes, str]:
        """Return (status, content_type, body, final_url)."""
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": self.config.user_agent,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "en;q=0.9,*;q=0.5",
            },
        )
        with urllib.request.urlopen(request, timeout=self.config.request_timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            if not any(t in content_type.lower() for t in _TEXT_TYPES) and content_type:
                return response.status, content_type, b"", response.geturl()
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > self.config.max_bytes:
                return response.status, content_type, b"", response.geturl()
            raw = response.read(self.config.max_bytes + 1)
            encoding = (response.headers.get("Content-Encoding") or "").lower()
            if encoding == "gzip":
                raw = gzip.decompress(raw)
            elif encoding == "deflate":
                raw = zlib.decompress(raw, -zlib.MAX_WBITS)
            if len(raw) > self.config.max_bytes:
                raw = raw[: self.config.max_bytes]
            return response.status, content_type, raw, response.geturl()

    # -- one page ---------------------------------------------------------
    def process(self, url: str, depth: int) -> bool:
        """Fetch, extract and store one page.  True when it was stored."""
        host = urlutil.host(url)
        self.throttle.wait(host, self.robots.delay(url, self.config.crawl_delay))
        status, content_type, raw, final_url = self.fetch(url)
        self.stats.fetched += 1
        self.stats.bytes += len(raw)

        if not raw:
            self.stats.skipped += 1
            return False

        final_url = urlutil.normalize(final_url) or url
        text = decode(raw, content_type)
        if "html" in content_type.lower() or text.lstrip()[:200].lower().startswith(
            ("<!doctype html", "<html")
        ):
            doc = parse_html(text, final_url)
        else:
            doc = parse_text(text, final_url)

        if doc.noindex:
            self.stats.skipped += 1
            return False

        canonical = urlutil.normalize(doc.canonical) if doc.canonical else ""
        store_url = canonical or final_url
        content_hash = hashlib.sha256(doc.text.encode("utf-8", "replace")).hexdigest()[:32]
        if doc.text and self.store.has_content_hash(content_hash, store_url):
            self.stats.duplicates += 1
            return False

        doc_id = self.store.put_doc(
            url=store_url,
            host=urlutil.host(store_url),
            title=doc.title[:500],
            description=doc.description[:1000],
            headings="\n".join(doc.headings[:50]),
            body=doc.text,
            lang=doc.lang,
            content_type=content_type.split(";")[0].strip(),
            content_hash=content_hash,
            status=status,
            fetched_at=time.time(),
        )

        outgoing: list[tuple[str, str]] = []
        if not doc.nofollow:
            seen: set[str] = set()
            for link, anchor in doc.links:
                target = urlutil.normalize(link, final_url)
                if not target or target in seen:
                    continue
                seen.add(target)
                outgoing.append((target, anchor))
                if depth + 1 <= self.config.max_depth and self.allowed(target):
                    if self._frontier_has_room():
                        self.store.enqueue(target, urlutil.host(target), depth + 1)
        self.store.add_links(doc_id, outgoing)

        self.stats.stored += 1
        if self.on_page:
            self.on_page(store_url, doc.title, status)
        return True

    def _frontier_has_room(self) -> bool:
        """The frontier may grow to a few times the page budget, no further."""
        counts = self.store.frontier_counts()
        return counts["pending"] + counts["in_flight"] < self.config.max_pages * 4

    # -- the loop ---------------------------------------------------------
    def run(self, seeds=None, max_pages: int | None = None) -> CrawlStats:
        """Crawl until the budget is spent or the frontier runs dry.

        ``max_pages`` bounds the number of URLs taken off the frontier, so a
        crawl always terminates even on a site that links in circles.
        """
        if seeds:
            self.seed(seeds)
        budget = max_pages if max_pages is not None else self.config.max_pages
        workers = max(1, self.config.threads)
        self.store.reset_in_flight()
        self.stats = CrawlStats()
        self._stop.clear()

        lock = threading.Lock()
        state = {"claimed": 0, "idle": 0}

        def worker() -> None:
            while not self._stop.is_set():
                with lock:
                    if state["claimed"] >= budget:
                        return
                    state["claimed"] += 1
                rows = self.store.claim(1)
                if not rows:
                    with lock:
                        state["claimed"] -= 1
                        state["idle"] += 1
                        everyone_waiting = state["idle"] >= workers
                    try:
                        # Nobody is fetching and nothing is queued: the crawl
                        # is finished, not merely slow.
                        if everyone_waiting and self._idle():
                            self._stop.set()
                            return
                        time.sleep(0.2)
                    finally:
                        with lock:
                            state["idle"] -= 1
                    continue

                url, depth = rows[0]["url"], rows[0]["depth"]
                try:
                    if not self.allowed(url):
                        self.stats.skipped += 1
                        self.store.finish(url, DONE, "filtered")
                        continue
                    self.process(url, depth)
                    self.store.finish(url, DONE)
                except urllib.error.HTTPError as exc:
                    self.stats.failed += 1
                    self.store.finish(url, FAILED, f"http {exc.code}")
                except Exception as exc:  # network, decoding, malformed pages
                    self.stats.failed += 1
                    self.store.finish(url, FAILED, f"{type(exc).__name__}: {exc}"[:200])

        threads = [
            threading.Thread(target=worker, daemon=True, name=f"shaurya-crawl-{i}")
            for i in range(workers)
        ]
        for thread in threads:
            thread.start()
        try:
            for thread in threads:
                thread.join()
        except KeyboardInterrupt:
            self._stop.set()
            for thread in threads:
                thread.join(timeout=2.0)
        self.store.reset_in_flight()
        return self.stats

    def _idle(self) -> bool:
        counts = self.store.frontier_counts()
        return counts["pending"] == 0 and counts["in_flight"] == 0

    def stop(self) -> None:
        self._stop.set()
