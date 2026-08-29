"""The web interface and JSON API."""

import json
import os
import shutil
import tempfile
import unittest
import urllib.error
import urllib.request

from shaurya import demo
from shaurya.config import Config
from shaurya.server import serve
from shaurya.store import Store


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="shaurya-server-")
        cls.config = Config(index_path=os.path.join(cls.tmpdir, "index.db"),
                            host="127.0.0.1", port=0)
        cls.store = Store(cls.config.index_path)
        demo.load(cls.store)
        cls.server, cls.base = serve(cls.store, cls.config, background=True)
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.store.close()
        shutil.rmtree(cls.tmpdir, ignore_errors=True)

    def get(self, path):
        # A proxy must never be consulted for a localhost test server.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(self.base + path, timeout=10) as response:
            return response.status, response.headers, response.read().decode("utf-8")

    def get_json(self, path):
        _status, _headers, body = self.get(path)
        return json.loads(body)

    # -- pages ------------------------------------------------------------
    def test_home_page(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("SHAURYA", body)
        self.assertIn('name="q"', body)

    def test_results_page(self):
        status, _headers, body = self.get("/search?q=inverted+index")
        self.assertEqual(status, 200)
        self.assertIn("<mark>", body)
        self.assertIn("shaurya.local", body)

    def test_results_page_for_a_query_with_no_matches(self):
        _status, _headers, body = self.get("/search?q=zzzznotaword")
        self.assertIn("No results", body)

    def test_query_is_escaped_in_the_page(self):
        _status, _headers, body = self.get("/search?q=%3Cscript%3Ealert(1)%3C/script%3E")
        self.assertNotIn("<script>alert(1)</script>", body)
        self.assertIn("&lt;script&gt;", body)

    def test_unknown_path_is_a_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/no/such/page")
        self.assertEqual(caught.exception.code, 404)

    # -- api --------------------------------------------------------------
    def test_api_search(self):
        payload = self.get_json("/api/search?q=bm25")
        self.assertEqual(payload["engine"], "SHAURYA")
        self.assertGreater(payload["total"], 0)
        first = payload["results"][0]
        for key in ("url", "title", "snippet", "score", "text"):
            self.assertIn(key, first)

    def test_api_search_paginates(self):
        payload = self.get_json("/api/search?q=index&size=2&page=1")
        self.assertLessEqual(len(payload["results"]), 2)
        self.assertEqual(payload["size"], 2)

    def test_api_search_requires_a_query(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/api/search")
        self.assertEqual(caught.exception.code, 400)

    def test_api_suggest(self):
        payload = self.get_json("/api/suggest?q=craw")
        self.assertTrue(any(s.startswith("craw") for s in payload["suggestions"]))

    def test_api_suggest_opensearch_shape(self):
        payload = self.get_json("/api/suggest?q=craw&format=opensearch")
        self.assertEqual(payload[0], "craw")
        self.assertIsInstance(payload[1], list)

    def test_api_stats(self):
        payload = self.get_json("/api/stats")
        self.assertEqual(payload["indexed"], len(demo.DOCUMENTS))

    def test_api_explain(self):
        payload = self.get_json(
            "/api/explain?q=bm25&url=https://shaurya.local/docs/bm25")
        self.assertEqual(payload["position"], 1)

    def test_healthz(self):
        self.assertEqual(self.get_json("/healthz")["status"], "ok")

    # -- browser integration ---------------------------------------------
    def test_opensearch_description(self):
        status, headers, body = self.get("/opensearch.xml")
        self.assertEqual(status, 200)
        self.assertIn("opensearchdescription", headers["Content-Type"])
        self.assertIn("<ShortName>SHAURYA</ShortName>", body)
        self.assertIn("{searchTerms}", body)

    def test_favicon(self):
        status, headers, body = self.get("/static/favicon.svg")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertIn("<svg", body)

    def test_security_headers(self):
        _status, headers, _body = self.get("/")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")


if __name__ == "__main__":
    unittest.main()
