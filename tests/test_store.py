"""Storage, the postings codec and index bookkeeping."""

import os
import shutil
import tempfile
import unittest

from shaurya.store import DONE, PENDING, Store, decode_positions, encode_positions


class PositionCodecTests(unittest.TestCase):
    def test_round_trip(self):
        for positions in ([], [0], [0, 1, 5, 300, 70000, 70001],
                          list(range(0, 5000, 7))):
            self.assertEqual(decode_positions(encode_positions(positions)), positions)

    def test_empty_blob(self):
        self.assertEqual(decode_positions(b""), [])
        self.assertEqual(decode_positions(None), [])

    def test_encoding_is_compact(self):
        # Delta + varint should beat four bytes per position comfortably.
        positions = list(range(1000))
        self.assertLess(len(encode_positions(positions)), len(positions) * 2)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="shaurya-store-")
        self.store = Store(os.path.join(self.tmpdir, "index.db"))

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _doc(self, url="https://x.test/a", content_hash="hash-a"):
        return self.store.put_doc(
            url=url, host="x.test", title="Title", description="", headings="",
            body="body text", lang="en", content_type="text/html",
            content_hash=content_hash, status=200, fetched_at=1000.0,
        )

    def test_put_doc_is_idempotent_on_url(self):
        first = self._doc()
        second = self._doc()
        self.assertEqual(first, second)
        self.assertEqual(self.store.stats()["documents"], 1)

    def test_reindexing_does_not_inflate_document_frequency(self):
        doc_id = self._doc()
        self.store.write_postings(doc_id, {"alpha": (1, 1, [0]), "beta": (2, 16, [1, 4])})
        self.assertEqual(self.store.doc_frequency("alpha"), 1)
        self.assertEqual(self.store.doc_frequency("beta"), 1)

        # Re-indexing the same document must replace, not accumulate.
        self.store.write_postings(doc_id, {"alpha": (1, 1, [0])})
        self.assertEqual(self.store.doc_frequency("alpha"), 1)
        self.assertEqual(self.store.doc_frequency("beta"), 0)

    def test_document_frequency_counts_documents_not_occurrences(self):
        for i in range(3):
            doc_id = self._doc(f"https://x.test/{i}", f"hash-{i}")
            self.store.write_postings(doc_id, {"shared": (5, 16, [0, 1, 2, 3, 4])})
        self.assertEqual(self.store.doc_frequency("shared"), 3)

    def test_deleting_a_document_removes_its_postings(self):
        doc_id = self._doc()
        self.store.write_postings(doc_id, {"gone": (1, 16, [0])})
        self.store.delete_doc(doc_id)
        self.assertEqual(self.store.doc_frequency("gone"), 0)
        self.assertEqual(self.store.postings_for("gone"), [])
        self.assertIsNone(self.store.get_doc(doc_id))

    def test_duplicate_content_is_detectable(self):
        self._doc("https://x.test/a", "same")
        self.assertTrue(self.store.has_content_hash("same", "https://x.test/b"))
        self.assertFalse(self.store.has_content_hash("same", "https://x.test/a"))

    def test_frontier_claim_is_exclusive(self):
        self.store.enqueue("https://x.test/1", "x.test", 0)
        self.store.enqueue("https://x.test/2", "x.test", 0)
        first = self.store.claim(1)
        second = self.store.claim(1)
        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertNotEqual(first[0]["url"], second[0]["url"])
        self.assertEqual(self.store.claim(1), [])
        self.assertEqual(self.store.frontier_counts()["in_flight"], 2)

    def test_enqueue_is_deduplicated(self):
        self.assertTrue(self.store.enqueue("https://x.test/1", "x.test", 0))
        self.assertFalse(self.store.enqueue("https://x.test/1", "x.test", 0))

    def test_frontier_prefers_shallow_urls(self):
        self.store.enqueue("https://x.test/deep", "x.test", 3)
        self.store.enqueue("https://x.test/shallow", "x.test", 0)
        self.assertEqual(self.store.claim(1)[0]["url"], "https://x.test/shallow")

    def test_reset_in_flight_recovers_an_interrupted_crawl(self):
        self.store.enqueue("https://x.test/1", "x.test", 0)
        self.store.claim(1)
        self.assertEqual(self.store.reset_in_flight(), 1)
        self.assertEqual(self.store.frontier_counts()["pending"], 1)

    def test_finished_urls_are_not_reclaimed(self):
        self.store.enqueue("https://x.test/1", "x.test", 0)
        self.store.claim(1)
        self.store.finish("https://x.test/1", DONE)
        self.store.reset_in_flight()
        self.assertEqual(self.store.claim(1), [])

    def test_surface_forms_record_real_spellings(self):
        self.store.add_forms({("run", "running"): 3, ("run", "runs"): 1})
        self.assertEqual(self.store.best_form("run"), "running")
        self.assertEqual(self.store.best_form("unseen"), "unseen")

    def test_docs_meta_excludes_the_body(self):
        doc_id = self._doc()
        meta = self.store.docs_meta([doc_id])[doc_id]
        self.assertNotIn("body", meta.keys())
        self.assertEqual(meta["url"], "https://x.test/a")

    def test_query_log_feeds_popular_queries(self):
        self.store.log_query("coffee")
        self.store.log_query("coffee")
        self.store.log_query("cocoa")
        self.assertEqual(self.store.popular_queries("co")[0], "coffee")
        self.assertEqual(self.store.popular_queries("zzz"), [])

    def test_stats_shape(self):
        stats = self.store.stats()
        for key in ("documents", "indexed", "hosts", "terms", "postings",
                    "tokens", "avg_doc_length", "frontier", "index_bytes"):
            self.assertIn(key, stats)


if __name__ == "__main__":
    unittest.main()
