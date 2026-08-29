"""Text analysis: normalisation, tokenisation and stemming.

The same pipeline runs over documents at index time and over queries at search
time, which is what makes "Running Ponies" match a page that says "ran pony".
"""

from __future__ import annotations

import re
import unicodedata

# Words carried by almost every document.  They are still indexed (phrase
# queries need them) but the ranker leans on them far less.
STOPWORDS = frozenset("""
a about above after again against all am an and any are aren't as at be because
been before being below between both but by can cannot could couldn't did didn't
do does doesn't doing don't down during each few for from further had hadn't has
hasn't have haven't having he her here hers herself him himself his how i if in
into is isn't it its itself let's me more most mustn't my myself no nor not of
off on once only or other ought our ours ourselves out over own same shan't she
should shouldn't so some such than that the their theirs them themselves then
there these they this those through to too under until up very was wasn't we
were weren't what when where which while who whom why with won't would wouldn't
you your yours yourself yourselves
""".split())

# Letters, digits and the joiners that hold real tokens together (c++, node.js,
# don't, wi-fi).  Trailing punctuation is trimmed afterwards.
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[.'’+#_-][a-z0-9]+)*[+#]*")

_VOWELS = frozenset("aeiou")


def normalize(text: str) -> str:
    """Casefold, strip accents and collapse whitespace."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("’", "'").replace("­", "")
    return text.casefold()


def tokenize(text: str) -> list[str]:
    """Split normalised text into index tokens."""
    return _TOKEN_RE.findall(normalize(text))


def _is_consonant(word: str, i: int) -> bool:
    ch = word[i]
    if ch in _VOWELS:
        return False
    if ch == "y":
        # 'y' is a consonant only when the letter before it is a vowel.
        return i == 0 or not _is_consonant(word, i - 1)
    return True


def _measure(stem: str) -> int:
    """Porter's m: the number of vowel-consonant sequences in the stem."""
    m = 0
    i = 0
    n = len(stem)
    while i < n and _is_consonant(stem, i):
        i += 1
    while i < n:
        while i < n and not _is_consonant(stem, i):
            i += 1
        if i >= n:
            break
        m += 1
        while i < n and _is_consonant(stem, i):
            i += 1
    return m


def _has_vowel(stem: str) -> bool:
    return any(not _is_consonant(stem, i) for i in range(len(stem)))


def _double_consonant(stem: str) -> bool:
    return (
        len(stem) >= 2
        and stem[-1] == stem[-2]
        and _is_consonant(stem, len(stem) - 1)
    )


def _cvc(stem: str) -> bool:
    """True when the stem ends consonant-vowel-consonant, last not w/x/y."""
    if len(stem) < 3:
        return False
    if not (
        _is_consonant(stem, len(stem) - 3)
        and not _is_consonant(stem, len(stem) - 2)
        and _is_consonant(stem, len(stem) - 1)
    ):
        return False
    return stem[-1] not in "wxy"


_STEP2 = [
    ("ational", "ate"), ("tional", "tion"), ("enci", "ence"), ("anci", "ance"),
    ("izer", "ize"), ("abli", "able"), ("alli", "al"), ("entli", "ent"),
    ("eli", "e"), ("ousli", "ous"), ("ization", "ize"), ("ation", "ate"),
    ("ator", "ate"), ("alism", "al"), ("iveness", "ive"), ("fulness", "ful"),
    ("ousness", "ous"), ("aliti", "al"), ("iviti", "ive"), ("biliti", "ble"),
]

_STEP3 = [
    ("icate", "ic"), ("ative", ""), ("alize", "al"), ("iciti", "ic"),
    ("ical", "ic"), ("ful", ""), ("ness", ""),
]

_STEP4 = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment",
    "ent", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
]


def stem(word: str) -> str:
    """Porter (1980) suffix-stripping stemmer.

    Reduces inflected forms to a shared root so that a query for "connecting"
    finds documents that only ever say "connection".

    The result is an index key, not a word: stemming is *not* idempotent
    ("agreed" -> "agre" -> "agr"), so a stem must never be fed back through the
    analyser.  Text shown to a user, or turned back into a query, comes from
    :meth:`shaurya.store.Store.best_form` instead.
    """
    if len(word) <= 2 or not word.isalpha():
        return word
    w = word

    # --- step 1a: plurals -------------------------------------------------
    if w.endswith("sses"):
        w = w[:-2]
    elif w.endswith("ies"):
        w = w[:-2]
    elif w.endswith("ss"):
        pass
    elif w.endswith("s"):
        w = w[:-1]

    # --- step 1b: past tense and gerunds ----------------------------------
    step1b_applied = False
    if w.endswith("eed"):
        if _measure(w[:-3]) > 0:
            w = w[:-1]
    elif w.endswith("ed") and _has_vowel(w[:-2]):
        w = w[:-2]
        step1b_applied = True
    elif w.endswith("ing") and _has_vowel(w[:-3]):
        w = w[:-3]
        step1b_applied = True

    if step1b_applied:
        if w.endswith(("at", "bl", "iz")):
            w += "e"
        elif _double_consonant(w) and not w.endswith(("l", "s", "z")):
            w = w[:-1]
        elif _measure(w) == 1 and _cvc(w):
            w += "e"

    # --- step 1c: terminal y ----------------------------------------------
    if w.endswith("y") and _has_vowel(w[:-1]):
        w = w[:-1] + "i"

    # --- step 2 & 3: derivational suffixes --------------------------------
    for suffix, repl in _STEP2:
        if w.endswith(suffix):
            if _measure(w[: -len(suffix)]) > 0:
                w = w[: -len(suffix)] + repl
            break

    for suffix, repl in _STEP3:
        if w.endswith(suffix):
            if _measure(w[: -len(suffix)]) > 0:
                w = w[: -len(suffix)] + repl
            break

    # --- step 4: strip the suffix entirely --------------------------------
    for suffix in _STEP4:
        if w.endswith(suffix):
            stem_part = w[: -len(suffix)]
            if _measure(stem_part) > 1:
                w = stem_part
            break
    else:
        if w.endswith("ion"):
            stem_part = w[:-3]
            if _measure(stem_part) > 1 and stem_part.endswith(("s", "t")):
                w = stem_part

    # --- step 5: tidy up --------------------------------------------------
    if w.endswith("e"):
        m = _measure(w[:-1])
        if m > 1 or (m == 1 and not _cvc(w[:-1])):
            w = w[:-1]
    if _measure(w) > 1 and _double_consonant(w) and w.endswith("l"):
        w = w[:-1]

    return w


def analyze_pairs(text: str, keep_stopwords: bool = True) -> list[tuple[str, str]]:
    """Tokenise into (surface word, stem) pairs.

    The surface form is what SHAURYA shows in suggestions; the stem is what it
    stores in the index.
    """
    out = []
    for token in tokenize(text):
        if not keep_stopwords and token in STOPWORDS:
            continue
        out.append((token, stem(token)))
    return out


def analyze(text: str, keep_stopwords: bool = True) -> list[str]:
    """Full pipeline: normalise, tokenise, stem.

    Positions are preserved (stopwords are kept by default) so that phrase
    queries such as "to be or not to be" still work.
    """
    out = []
    for token in tokenize(text):
        if not keep_stopwords and token in STOPWORDS:
            continue
        out.append(stem(token))
    return out
