"""HTML extraction."""

import unittest

from shaurya.htmlparse import decode, parse_html, parse_text

PAGE = """<!doctype html><html lang="en-GB"><head>
<title>  Coffee &amp; Tea </title>
<meta name="description" content="All about brewing">
<link rel="canonical" href="/coffee">
<script>var hidden = "script text";</script><style>body{color:red}</style>
</head><body>
<nav><a href="/home">Home</a></nav>
<h1>Brewing Coffee</h1>
<p>Pour water over <b>ground</b> beans.</p>
<ul><li><a href="https://ex.org/beans">Bean guide</a></li></ul>
<img alt="a french press">
<footer>Copyright notice</footer>
</body></html>"""


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.doc = parse_html(PAGE, "https://cafe.test/page")

    def test_metadata(self):
        self.assertEqual(self.doc.title, "Coffee & Tea")
        self.assertEqual(self.doc.description, "All about brewing")
        self.assertEqual(self.doc.lang, "en")
        self.assertEqual(self.doc.canonical, "https://cafe.test/coffee")
        self.assertEqual(self.doc.headings, ["Brewing Coffee"])

    def test_script_and_style_text_is_dropped(self):
        self.assertNotIn("script text", self.doc.text)
        self.assertNotIn("color:red", self.doc.text)

    def test_chrome_text_is_dropped_but_its_links_are_kept(self):
        self.assertNotIn("Copyright notice", self.doc.text)
        self.assertIn(("https://cafe.test/home", "Home"), self.doc.links)

    def test_links_are_absolute_with_anchor_text(self):
        self.assertIn(("https://ex.org/beans", "Bean guide"), self.doc.links)

    def test_image_alt_text_is_indexed(self):
        self.assertIn("french press", self.doc.text)

    def test_adjacent_elements_do_not_run_together(self):
        text = parse_html('<p><a href="/">Home</a> <a href="/b">Beans</a></p>').text
        self.assertEqual(text, "Home Beans")

    def test_robots_meta(self):
        doc = parse_html('<meta name="robots" content="noindex, nofollow"><p>x</p>')
        self.assertTrue(doc.noindex)
        self.assertTrue(doc.nofollow)

    def test_unsafe_link_schemes_are_ignored(self):
        doc = parse_html('<a href="javascript:alert(1)">x</a><a href="#top">y</a>'
                         '<a href="mailto:a@b.c">z</a>', "https://x.test/")
        self.assertEqual(doc.links, [])

    def test_nofollow_links_are_not_followed(self):
        doc = parse_html('<a href="/paid" rel="nofollow">ad</a>', "https://x.test/")
        self.assertEqual(doc.links, [])

    def test_malformed_html_still_yields_text(self):
        doc = parse_html("<p>unclosed <b>bold <div>next")
        self.assertIn("unclosed", doc.text)
        self.assertIn("next", doc.text)

    def test_title_falls_back_to_first_line(self):
        doc = parse_html("<body><p>First line here</p><p>second</p></body>")
        self.assertEqual(doc.title, "First line here")


class DecodeTests(unittest.TestCase):
    def test_charset_from_meta_tag(self):
        self.assertTrue(decode(b'<meta charset="cp1252">caf\xe9').endswith("café"))

    def test_charset_from_header_wins(self):
        self.assertTrue(decode("café".encode("utf-8"), "text/html; charset=utf-8")
                        .endswith("café"))

    def test_undecodable_bytes_do_not_raise(self):
        self.assertIsInstance(decode(b"\xff\xfe\x00bad", "text/html; charset=bogus"), str)


class PlainTextTests(unittest.TestCase):
    def test_first_line_becomes_the_title(self):
        doc = parse_text("# Notes on tea\n\nSteep for two minutes.", "file:///notes.md")
        self.assertEqual(doc.title, "Notes on tea")
        self.assertIn("Steep", doc.text)


if __name__ == "__main__":
    unittest.main()
