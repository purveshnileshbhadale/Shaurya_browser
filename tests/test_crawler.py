"""Crawler behaviour, exercised against a real HTTP server on localhost."""

import os
import shutil
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from shaurya.config import Config
from shaurya.crawler import Crawler
from shaurya.indexer import Indexer
from shaurya.linkgraph import compute_pagerank
from shaurya.search import Searcher
from shaurya.store import Store

PAGES = {
    "index.html": """<!doctype html><html lang="en"><head><title>Mountain Roasters</title>
        <meta name="description" content="Small batch coffee"></head><body>
        <h1>Mountain Roasters</h1><p>We roast single origin coffee every Tuesday.</p>
        <ul><li><a href="/guide/brewing.html">Brewing guide</a></li>
        <li><a href="/guide/beans.html">Our beans</a></li>
        <li><a href="/secret.html">Secret</a></li>
        <li><a href="/copy.html">A copy</a></li>
        <li><a href="/private.html">Private</a></li></ul></body></html>""",
    "guide/brewing.html": """<!doctype html><html lang="en"><head><title>Brewing Guide</title>
        </head><body><h1>Brewing Guide</h1><h2>French press</h2>
        <p>Steep coarse ground coffee in hot water for four minutes.</p>
        <p><a href="/">Home</a> <a href="/guide/beans.html">Beans</a></p></body></html>""",
    "guide/beans.html": """<!doctype html><html lang="en"><head><title>Our Beans</title></head>
        <body><h1>Our Beans</h1><p>Ethiopian beans taste of blueberry.</p>
        <a href="/">Home</a></body></html>""",
    "secret.html": "<html><head><title>Secret</title></head><body>Nothing here.</body></html>",
    # Byte-for-byte the same text as the home page, at a different address.
    "copy.html": """<!doctype html><html lang="en"><head><title>Mountain Roasters</title>
        <meta name="description" content="Small batch coffee"></head><body>
        <h1>Mountain Roasters</h1><p>We roast single origin coffee every Tuesday.</p>
        <ul><li><a href="/guide/brewing.html">Brewing guide</a></li>
        <li><a href="/guide/beans.html">Our beans</a></li>
        <li><a href="/secret.html">Secret</a></li>
        <li><a href="/copy.html">A copy</a></li>
        <li><a href="/private.html">Private</a></li></ul></body></html>""",
    "private.html": """<html><head><title>Private</title>
        <meta name="robots" content="noindex"></head><body>Do not index me.</body></html>""",
    "robots.txt": "User-agent: *\nDisallow: /secret.html\n",
}


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class CrawlerTestCase(unittest.TestCase):
    """Serves a small site on localhost and crawls it."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="shaurya-site-")
        for name, content in PAGES.items():
            path = os.path.join(cls.root, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(content)
        cls.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(_QuietHandler, directory=cls.root)
        )
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}/"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="shaurya-crawl-")
        self.config = Config(
            index_path=os.path.join(self.tmpdir, "index.db"),
            crawl_delay=0.0, threads=4, max_pages=20, max_depth=3,
            same_host_only=True,
        )
        self.store = Store(self.config.index_path)

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def crawl(self, **overrides):
        for key, value in overrides.items():
            setattr(self.config, key, value)
        crawler = Crawler(self.store, self.config)
        return crawler.run([self.base])

    def stored_urls(self):
        return sorted(row["url"] for row in self.store.conn.execute("SELECT url FROM docs"))

    # -- behaviour --------------------------------------------------------
    def test_crawls_the_site_and_stops(self):
        stats = self.crawl()
        self.assertGreaterEqual(stats.stored, 3)
        self.assertEqual(self.store.frontier_counts()["pending"], 0)
        self.assertIn(self.base, self.stored_urls())

    def test_robots_txt_is_obeyed(self):
        self.crawl()
        self.assertNotIn(f"{self.base}secret.html", self.stored_urls())

    def test_robots_can_be_overridden_explicitly(self):
        self.crawl(obey_robots=False)
        self.assertIn(f"{self.base}secret.html", self.stored_urls())

    def test_noindex_pages_are_fetched_but_not_stored(self):
        self.crawl()
        self.assertNotIn(f"{self.base}private.html", self.stored_urls())

    def test_duplicate_content_is_stored_once(self):
        stats = self.crawl()
        urls = self.stored_urls()
        self.assertGreaterEqual(stats.duplicates, 1)
        self.assertNotIn(f"{self.base}copy.html", urls)

    def test_page_budget_is_respected(self):
        stats = self.crawl(max_pages=2)
        self.assertLessEqual(stats.stored, 2)

    def test_depth_limit_keeps_the_crawl_shallow(self):
        self.crawl(max_depth=0)
        self.assertEqual(self.stored_urls(), [self.base])

    def test_links_and_anchors_are_recorded(self):
        self.crawl()
        links = list(self.store.iter_links())
        self.assertTrue(any(anchor == "Brewing guide" for _, _, anchor in links))

    def test_crawl_survives_a_dead_host(self):
        # An unreachable seed must fail that URL, not the whole crawl.
        crawler = Crawler(self.store, self.config)
        stats = crawler.run([self.base, "http://127.0.0.1:1/nothing"])
        self.assertGreaterEqual(stats.stored, 3)
        self.assertGreaterEqual(stats.failed, 1)

    def test_a_second_crawl_does_not_duplicate_documents(self):
        self.crawl()
        first = self.stored_urls()
        self.crawl()
        self.assertEqual(first, self.stored_urls())

    # -- the whole pipeline ----------------------------------------------
    def test_crawl_index_rank_then_search(self):
        self.crawl()
        Indexer(self.store, self.config).run()
        ranks = compute_pagerank(self.store)
        self.store.set_rank(ranks)

        searcher = Searcher(self.store, self.config)
        response = searcher.search("french press")
        self.assertGreater(response.total, 0)
        self.assertEqual(response.results[0].url, f"{self.base}guide/brewing.html")

        # The home page is linked from every other page, so it should carry the
        # most link weight.
        home_id = self.store.get_doc_by_url(self.base)["id"]
        self.assertEqual(max(ranks, key=ranks.get), home_id)

    def test_anchor_text_makes_a_page_findable(self):
        # "Ethiopian" is only in the beans page body, but "Our beans" is the
        # anchor text pointing at it from the home page.
        self.crawl()
        Indexer(self.store, self.config).run()
        response = Searcher(self.store, self.config).search("our beans")
        self.assertEqual(response.results[0].url, f"{self.base}guide/beans.html")


if __name__ == "__main__":
    unittest.main()
