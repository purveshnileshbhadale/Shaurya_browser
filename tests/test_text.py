"""Tokenisation and stemming."""

import unittest

from shaurya.text import STOPWORDS, analyze, analyze_pairs, normalize, stem, tokenize

# Vectors from Porter's 1980 paper, carried through to their final stems.
PORTER = {
    "caresses": "caress", "ponies": "poni", "ties": "ti", "caress": "caress",
    "cats": "cat", "feed": "feed", "agreed": "agre", "plastered": "plaster",
    "bled": "bled", "motoring": "motor", "sing": "sing", "conflated": "conflat",
    "troubled": "troubl", "sized": "size", "hopping": "hop", "tanned": "tan",
    "falling": "fall", "hissing": "hiss", "fizzed": "fizz", "failing": "fail",
    "filing": "file", "happy": "happi", "sky": "sky", "relational": "relat",
    "conditional": "condit", "rational": "ration", "digitizer": "digit",
    "conformably": "conform", "radically": "radic", "differently": "differ",
    "vilely": "vile", "vietnamization": "vietnam", "predication": "predic",
    "operator": "oper", "feudalism": "feudal", "decisiveness": "decis",
    "hopefulness": "hope", "callousness": "callous", "formaliti": "formal",
    "sensitiviti": "sensit", "sensibiliti": "sensibl", "triplicate": "triplic",
    "formative": "form", "formalize": "formal", "electrical": "electr",
    "hopeful": "hope", "goodness": "good", "revival": "reviv",
    "allowance": "allow", "inference": "infer", "airliner": "airlin",
    "gyroscopic": "gyroscop", "adjustable": "adjust", "defensible": "defens",
    "irritant": "irrit", "replacement": "replac", "adjustment": "adjust",
    "dependent": "depend", "adoption": "adopt", "communism": "commun",
    "activate": "activ", "angulariti": "angular", "homologous": "homolog",
    "effective": "effect", "bowdlerize": "bowdler", "probate": "probat",
    "rate": "rate", "cease": "ceas", "controll": "control", "roll": "roll",
}


class StemmerTests(unittest.TestCase):
    def test_porter_vectors(self):
        for word, expected in PORTER.items():
            with self.subTest(word=word):
                self.assertEqual(stem(word), expected)

    def test_short_words_are_left_alone(self):
        for word in ("a", "an", "is", "go"):
            self.assertEqual(stem(word), word)

    def test_inflections_share_a_stem(self):
        for group in (("run", "running", "runs"),
                      ("connect", "connected", "connecting", "connection"),
                      ("index", "indexes")):
            stems = {stem(word) for word in group}
            self.assertEqual(len(stems), 1, f"{group} -> {stems}")

    def test_stemming_is_not_idempotent(self):
        # Porter emits index keys, not words: a stem run through the stemmer
        # again can change.  The engine relies on only ever analysing raw text,
        # and on surface forms for anything shown back to the user.
        self.assertEqual(stem("agreed"), "agre")
        self.assertEqual(stem("agre"), "agr")

    def test_indexing_and_querying_agree(self):
        # The property the engine actually depends on: the same raw word
        # analysed at index time and at query time yields the same key.
        for word in ("Running", "running", "RUNNING", "runs", "ran"):
            self.assertEqual(analyze(word), [stem(word.casefold())])


class TokenizerTests(unittest.TestCase):
    def test_keeps_technical_tokens_intact(self):
        self.assertEqual(
            tokenize("Node.js and C++ over Wi-Fi, don't you know? 2024!"),
            ["node.js", "and", "c++", "over", "wi-fi", "don't", "you", "know", "2024"],
        )

    def test_strips_accents_and_case(self):
        self.assertEqual(tokenize("Café CRÈME"), ["cafe", "creme"])
        self.assertEqual(normalize("Ünicode"), "unicode")

    def test_empty_input(self):
        self.assertEqual(tokenize(""), [])
        self.assertEqual(analyze(None or ""), [])

    def test_analyze_can_drop_stopwords(self):
        self.assertNotIn("the", analyze("the running ponies", keep_stopwords=False))
        self.assertIn("the", analyze("the running ponies"))
        self.assertIn("the", STOPWORDS)

    def test_analyze_pairs_keeps_surface_forms(self):
        pairs = analyze_pairs("Running Ponies")
        self.assertEqual(pairs, [("running", "run"), ("ponies", "poni")])


if __name__ == "__main__":
    unittest.main()
