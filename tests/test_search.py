"""Searching: filters, ranking behaviour, snippets and suggestions."""

import unittest

from shaurya.indexer import Indexer, index_text
from shaurya.search import Searcher
from shaurya.snippet import make_snippet, plain
from tests.support import IndexTestCase


class SearchTests(IndexTestCase):
    def setUp(self):
        super().setUp()
        self.searcher = Searcher(self.store, self.config)

    def search(self, query, **kwargs):
        return self.searcher.search(query, **kwargs)

    # -- matching ---------------------------------------------------------
    def test_finds_the_obvious_document(self):
        response = self.search("french press")
        self.assertEqual(self.urls(response)[0], "https://brew.test/french-press")

    def test_stemming_bridges_query_and_document(self):
        # The page says "brews"; the query says "brewing".
        self.assertIn("https://brew.test/french-press", self.urls(self.search("brewing")))

    def test_unknown_words_find_nothing(self):
        self.assertEqual(self.search("zzzznotaword").total, 0)

    def test_empty_query_is_not_an_error(self):
        response = self.search("   ")
        self.assertEqual(response.total, 0)
        self.assertTrue(response.is_empty)

    def test_all_query_words_beat_some(self):
        # A page with both words must outrank a page with only one.
        response = self.search("coffee grinder")
        self.assertEqual(self.urls(response)[0], "https://brew.test/grinders")

    def test_title_matches_outrank_body_matches(self):
        response = self.search("espresso")
        self.assertEqual(self.urls(response)[0], "https://brew.test/espresso")

    # -- operators --------------------------------------------------------
    def test_phrase_requires_adjacency(self):
        self.assertEqual(self.search('"french press"').total, 1)
        # The words exist in the corpus but never in this order, adjacent.
        self.assertEqual(self.search('"press french"').total, 0)

    def test_exclusion_removes_documents(self):
        with_espresso = set(self.urls(self.search("coffee", size=50)))
        without = set(self.urls(self.search("coffee -espresso", size=50)))
        self.assertIn("https://brew.test/espresso", with_espresso)
        self.assertNotIn("https://brew.test/espresso", without)

    def test_site_filter(self):
        response = self.search("site:brew.test", size=50)
        self.assertEqual(response.total, 3)
        self.assertTrue(all("brew.test" in url for url in self.urls(response)))

    def test_negative_site_filter(self):
        response = self.search("-site:brew.test water", size=50)
        self.assertTrue(all("brew.test" not in url for url in self.urls(response)))

    def test_site_filter_narrows_a_word_search(self):
        response = self.search("site:brew.test grinder", size=50)
        self.assertEqual(self.urls(response)[0], "https://brew.test/grinders")

    def test_intitle_filter(self):
        response = self.search("intitle:tea", size=50)
        self.assertEqual(self.urls(response), ["https://tea.test/green-tea"])

    def test_intitle_rejects_body_only_matches(self):
        # "plunger" appears in the body of the french press page, never a title.
        self.assertEqual(self.search("intitle:plunger").total, 0)

    def test_inurl_filter(self):
        self.assertEqual(self.urls(self.search("inurl:beans")),
                         ["https://garden.test/beans"])

    def test_or_widens_the_search(self):
        response = self.search("grinder OR tea", size=50)
        urls = self.urls(response)
        self.assertIn("https://brew.test/grinders", urls)
        self.assertIn("https://tea.test/green-tea", urls)

    def test_filters_combine(self):
        response = self.search("site:brew.test -grinder coffee", size=50)
        urls = self.urls(response)
        self.assertNotIn("https://brew.test/grinders", urls)
        self.assertTrue(all("brew.test" in url for url in urls))

    # -- presentation -----------------------------------------------------
    def test_results_carry_a_marked_snippet(self):
        result = self.search("plunger").results[0]
        self.assertIn("<mark>plunger</mark>", result.snippet)
        self.assertIn("plunger", plain(result.snippet))

    def test_titles_are_highlighted_and_escaped(self):
        index_text(self.store, "https://x.test/esc", "Coffee <script> & tea",
                   "coffee body", config=self.config)
        result = next(r for r in self.search("coffee", size=50).results
                      if r.url == "https://x.test/esc")
        self.assertIn("&lt;script&gt;", result.title_html)
        self.assertNotIn("<script>", result.title_html)

    def test_display_url_is_readable(self):
        result = self.search("french press").results[0]
        self.assertEqual(result.display_url, "brew.test › french-press")

    def test_pagination_splits_results_without_overlap(self):
        first = self.search("coffee OR tea OR beans", page=1, size=2)
        second = self.search("coffee OR tea OR beans", page=2, size=2)
        self.assertEqual(len(first.results), 2)
        self.assertGreater(first.pages, 1)
        self.assertFalse(set(self.urls(first)) & set(self.urls(second)))

    def test_page_beyond_the_end_is_empty_but_valid(self):
        response = self.search("coffee", page=99)
        self.assertEqual(response.results, [])
        self.assertGreater(response.total, 0)

    # -- suggestions ------------------------------------------------------
    def test_misspelling_gets_a_suggestion(self):
        self.assertEqual(self.search("cofee").suggestion, "coffee")

    def test_known_words_are_never_second_guessed(self):
        self.assertIsNone(self.search("french press").suggestion)
        self.assertIsNone(self.search("tea").suggestion)

    def test_suggestions_are_words_that_actually_find_something(self):
        # Whatever we suggest must return results when searched: this is the
        # invariant that stems-as-suggestions used to break.
        for query in ("cofee", "grindr", "expreso", "beens"):
            suggestion = self.search(query).suggestion
            if suggestion:
                self.assertGreater(self.search(suggestion).total, 0, suggestion)

    def test_nonsense_gets_no_suggestion(self):
        self.assertIsNone(self.search("qqqqzzzz").suggestion)

    # -- explain ----------------------------------------------------------
    def test_explain_reports_the_ranking_factors(self):
        result = self.searcher.explain("french press", "https://brew.test/french-press")
        self.assertEqual(result["position"], 1)
        for factor in ("bm25", "proximity", "phrase", "link", "freshness"):
            self.assertIn(factor, result["factors"])

    def test_explain_on_an_unindexed_url(self):
        self.assertIn("error", self.searcher.explain("coffee", "https://nope.test/"))

    # -- api shape --------------------------------------------------------
    def test_response_serialises_to_json_friendly_data(self):
        payload = self.search("coffee").to_dict()
        self.assertEqual(payload["engine"], "SHAURYA")
        self.assertEqual(payload["query"], "coffee")
        self.assertIn("results", payload)
        self.assertIn("text", payload["results"][0])


class EmptyIndexTests(unittest.TestCase):
    def test_searching_an_empty_index(self):
        import os, shutil, tempfile
        from shaurya.config import Config
        from shaurya.store import Store

        tmpdir = tempfile.mkdtemp(prefix="shaurya-empty-")
        try:
            store = Store(os.path.join(tmpdir, "index.db"))
            response = Searcher(store, Config()).search("anything")
            self.assertEqual(response.total, 0)
            self.assertIsNone(response.suggestion)
            store.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class IncrementalIndexTests(IndexTestCase):
    def test_new_documents_become_searchable(self):
        searcher = Searcher(self.store, self.config)
        self.assertEqual(searcher.search("chicory").total, 0)
        index_text(self.store, "https://brew.test/chicory", "Chicory",
                   "Chicory root is roasted as a coffee substitute.", config=self.config)
        self.assertEqual(searcher.search("chicory").total, 1)

    def test_rebuild_reproduces_the_same_index(self):
        before = self.store.stats()
        Indexer(self.store, self.config).run(rebuild=True)
        after = self.store.stats()
        for key in ("documents", "indexed", "terms", "postings", "tokens"):
            self.assertEqual(before[key], after[key], key)

    def test_reindexing_keeps_search_results_stable(self):
        searcher = Searcher(self.store, self.config)
        before = self.urls(searcher.search("coffee", size=50))
        Indexer(self.store, self.config).run(rebuild=True)
        self.assertEqual(before, self.urls(searcher.search("coffee", size=50)))


class SnippetTests(unittest.TestCase):
    def test_snippet_picks_the_passage_with_the_query_terms(self):
        # The matching sentence is buried in the middle of a long document.
        text = ("Filler about gardening. " * 20 +
                "A french press brews coffee with hot water. " +
                "More filler about tea. " * 20)
        snippet = make_snippet(text, ["coffee", "press"], width=140)
        self.assertIn("<mark>coffee</mark>", snippet)
        self.assertIn("<mark>press</mark>", snippet)
        self.assertIn("A french press brews coffee with hot water.", plain(snippet))
        # A little context on either side is welcome; a whole document is not.
        self.assertLessEqual(len(plain(snippet)), 140 + 8)

    def test_snippet_marks_every_query_term_it_shows(self):
        snippet = make_snippet("Beans and coffee and tea.", ["beans", "tea"])
        self.assertIn("<mark>Beans</mark>", snippet)
        self.assertIn("<mark>tea</mark>", snippet)
        self.assertNotIn("<mark>coffee</mark>", snippet)

    def test_snippet_escapes_html(self):
        snippet = make_snippet("<script>alert(1)</script> coffee", ["coffee"])
        self.assertNotIn("<script>", snippet)
        self.assertIn("&lt;script&gt;", snippet)

    def test_snippet_of_empty_text(self):
        self.assertEqual(make_snippet("", ["x"]), "")

    def test_snippet_without_any_match_still_shows_context(self):
        self.assertIn("no hits", make_snippet("no hits in this text", ["zebra"]))


if __name__ == "__main__":
    unittest.main()
