"""Query assistance: autocomplete and "did you mean".

Both work off the index's own vocabulary, so SHAURYA only ever suggests words
that would actually find something.
"""

from __future__ import annotations

from .store import Store
from .text import stem, tokenize


def edit_distance(a: str, b: str, limit: int = 2) -> int:
    """Damerau-Levenshtein distance, abandoned once it exceeds ``limit``."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous_previous: list[int] = []
    previous = list(range(len(b) + 1))
    for i, ch_a in enumerate(a, start=1):
        current = [i]
        best = i
        for j, ch_b in enumerate(b, start=1):
            cost = 0 if ch_a == ch_b else 1
            value = min(
                previous[j] + 1,          # deletion
                current[j - 1] + 1,       # insertion
                previous[j - 1] + cost,   # substitution
            )
            if (
                i > 1 and j > 1
                and ch_a == b[j - 2] and a[i - 2] == ch_b
            ):
                value = min(value, previous_previous[j - 2] + 1)  # transposition
            current.append(value)
            best = min(best, value)
        if best > limit:
            return limit + 1
        previous_previous = previous
        previous = current
    return previous[-1]


class Suggester:
    """Vocabulary-backed suggestions for a single index."""

    def __init__(self, store: Store, min_df: int = 1):
        self.store = store
        self.min_df = min_df
        self._vocab: list[tuple[str, int]] | None = None
        self._by_length: dict[int, list[tuple[str, int]]] = {}

    def vocabulary(self) -> list[tuple[str, int]]:
        if self._vocab is None:
            self._vocab = self.store.surface_vocabulary(min_df=self.min_df)
            for term, df in self._vocab:
                self._by_length.setdefault(len(term), []).append((term, df))
        return self._vocab

    def invalidate(self) -> None:
        self._vocab = None
        self._by_length = {}

    # -- did you mean -----------------------------------------------------
    def correct_term(self, word: str) -> str | None:
        """Closest higher-frequency vocabulary term, or None."""
        word = word.casefold()
        if len(word) < 3:
            return None
        self.vocabulary()
        target_df = self.store.doc_frequency(stem(word))
        best: tuple[int, int, str] | None = None   # (distance, -df, term)
        for length in range(len(word) - 2, len(word) + 3):
            for term, df in self._by_length.get(length, ()):
                if df <= target_df or term == word:
                    continue
                if term[0] != word[0] and abs(len(term) - len(word)) > 1:
                    continue      # cheap prefilter: keep the candidate set small
                distance = edit_distance(word, term, limit=2)
                if distance > 2:
                    continue
                candidate = (distance, -df, term)
                if best is None or candidate < best:
                    best = candidate
        return best[2] if best else None

    def correct_query(self, text: str) -> str | None:
        """Suggest a corrected spelling for a whole query, or None."""
        words = tokenize(text)
        if not words:
            return None
        corrected: list[str] = []
        changed = False
        for word in words:
            # A word the corpus actually uses is not a misspelling, however
            # rare it is.  Only unknown words are candidates for correction.
            if self.store.doc_frequency(stem(word)) > 0:
                corrected.append(word)
                continue
            fix = self.correct_term(word)
            if fix and fix != word:
                corrected.append(fix)
                changed = True
            else:
                corrected.append(word)
        if not changed:
            return None
        suggestion = " ".join(corrected)
        return suggestion if suggestion.casefold() != text.casefold() else None

    # -- autocomplete -----------------------------------------------------
    def complete(self, prefix: str, limit: int = 8) -> list[str]:
        """Completions for what the user has typed so far."""
        prefix = (prefix or "").strip()
        if not prefix:
            return []
        out: list[str] = []
        seen: set[str] = set()
        for query in self.store.popular_queries(prefix.casefold(), limit):
            if query.casefold() not in seen:
                seen.add(query.casefold())
                out.append(query)

        words = prefix.split()
        head, last = " ".join(words[:-1]), words[-1].casefold()
        if len(last) >= 2:
            matches = [
                (term, df) for term, df in self.vocabulary()
                if term.startswith(last) and term != last
            ]
            matches.sort(key=lambda kv: (-kv[1], kv[0]))
            for term, _ in matches:
                candidate = f"{head} {term}".strip()
                if candidate.casefold() not in seen:
                    seen.add(candidate.casefold())
                    out.append(candidate)
                if len(out) >= limit:
                    break
        return out[:limit]
