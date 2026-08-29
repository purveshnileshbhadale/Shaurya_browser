"""The query language."""

import unittest

from shaurya.query import parse


class ParseTests(unittest.TestCase):
    def test_plain_words(self):
        query = parse("coffee brewing")
        self.assertEqual([t.raw for t in query.terms], ["coffee", "brewing"])
        self.assertTrue(all(t.required for t in query.terms))
        self.assertFalse(query.is_empty)

    def test_quoted_phrase(self):
        query = parse('"french press" coffee')
        self.assertEqual(len(query.phrases), 1)
        self.assertEqual(query.phrases[0].stems, ["french", "press"])
        # The phrase words are also ordinary searchable terms.
        self.assertIn("coffe", query.stems)

    def test_exclusion(self):
        query = parse("coffee -instant")
        self.assertEqual(query.excluded, ["instant"])
        self.assertEqual([t.raw for t in query.terms], ["coffee"])

    def test_site_filters(self):
        query = parse("beans site:Example.COM -site:spam.test")
        self.assertEqual(query.sites, ["example.com"])
        self.assertEqual(query.not_sites, ["spam.test"])

    def test_www_prefix_is_stripped_from_site_filter(self):
        self.assertEqual(parse("x site:www.example.com").sites, ["example.com"])

    def test_field_filters(self):
        query = parse("intitle:brewing inurl:docs lang:en filetype:html beans")
        self.assertEqual(query.intitle, ["brew"])
        self.assertEqual(query.inurl, ["docs"])
        self.assertEqual(query.lang, "en")
        self.assertEqual(query.filetype, "html")
        self.assertEqual([t.raw for t in query.terms], ["beans"])

    def test_or_makes_terms_optional(self):
        query = parse("coffee OR tea")
        self.assertFalse(any(t.required for t in query.terms))

    def test_unbalanced_quote_does_not_raise(self):
        query = parse('unbalanced "quote here')
        self.assertEqual([t.raw for t in query.terms],
                         ["unbalanced", "quote", "here"])

    def test_empty_and_filter_only_queries(self):
        self.assertTrue(parse("").is_empty)
        self.assertTrue(parse("   ").is_empty)
        # A filter on its own is a real query, not an empty one.
        self.assertFalse(parse("site:example.com").is_empty)
        self.assertFalse(parse("intitle:tea").is_empty)

    def test_stopwords_are_marked_but_kept(self):
        query = parse("the art of war")
        self.assertIn("the", [t.raw for t in query.terms])
        self.assertNotIn("the", query.required_stems)

    def test_words_are_available_for_highlighting(self):
        self.assertEqual(parse('"green tea" beans').words,
                         ["green", "tea", "beans", "green", "tea"])


if __name__ == "__main__":
    unittest.main()
