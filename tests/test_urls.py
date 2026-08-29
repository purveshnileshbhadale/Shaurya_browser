"""URL normalisation."""

import unittest

from shaurya import urls


class NormalizeTests(unittest.TestCase):
    def test_case_port_fragment_and_tracking(self):
        self.assertEqual(
            urls.normalize("HTTP://Example.COM:80/a/../b/./c?utm_source=x&q=1#frag"),
            "http://example.com/b/c?q=1",
        )

    def test_relative_urls_resolve_against_the_base(self):
        self.assertEqual(urls.normalize("../up", "https://base.test/a/b/c"),
                         "https://base.test/a/up")
        self.assertEqual(urls.normalize("//other.test/x", "https://base.test/p/"),
                         "https://other.test/x")

    def test_index_files_and_empty_paths_collapse(self):
        self.assertEqual(urls.normalize("https://example.com/index.html"),
                         "https://example.com/")
        self.assertEqual(urls.normalize("https://example.com"),
                         "https://example.com/")

    def test_duplicate_slashes_removed(self):
        self.assertEqual(urls.normalize("https://example.com/a//b/"),
                         "https://example.com/a/b/")

    def test_non_http_schemes_rejected(self):
        for url in ("mailto:a@b.c", "javascript:alert(1)", "ftp://x.test/f",
                    "", "   ", "not a url"):
            self.assertEqual(urls.normalize(url), "", url)

    def test_https_and_http_are_distinct_documents(self):
        self.assertNotEqual(urls.normalize("http://x.test/a"),
                            urls.normalize("https://x.test/a"))

    def test_two_spellings_of_one_page_collapse_together(self):
        first = urls.normalize("https://Example.com:443/docs/index.html?utm_medium=ads")
        second = urls.normalize("https://example.com/docs/")
        self.assertEqual(first, second)


class SiteTests(unittest.TestCase):
    def test_registrable_domain(self):
        self.assertEqual(urls.registrable("docs.python.org"), "python.org")
        self.assertEqual(urls.registrable("a.b.bbc.co.uk"), "bbc.co.uk")
        self.assertEqual(urls.registrable("example.com"), "example.com")

    def test_same_site(self):
        self.assertTrue(urls.same_site("https://docs.python.org/3/", "https://python.org/"))
        self.assertFalse(urls.same_site("https://a.test/", "https://b.test/"))

    def test_url_words_are_searchable(self):
        self.assertEqual(urls.words("https://docs.python.org/3/library/re.html"),
                         "docs python org 3 library re html")

    def test_binary_links_are_skipped(self):
        self.assertTrue(urls.is_probably_binary("https://x.test/photo.PNG"))
        self.assertTrue(urls.is_probably_binary("https://x.test/app.js"))
        self.assertFalse(urls.is_probably_binary("https://x.test/page.html"))
        self.assertFalse(urls.is_probably_binary("https://x.test/page"))


if __name__ == "__main__":
    unittest.main()
