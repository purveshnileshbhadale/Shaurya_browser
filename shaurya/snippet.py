"""Result snippets.

A snippet is the passage of a document that best answers the query: the window
of text containing the most distinct query words, with those words marked.
"""

from __future__ import annotations

import html
import re

from .text import stem

_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*")


def _words_with_offsets(text: str) -> list[tuple[str, int, int]]:
    return [(m.group(0), m.start(), m.end()) for m in _WORD_RE.finditer(text)]


def best_window(text: str, query_stems: set[str], width: int = 260) -> tuple[int, int]:
    """Character range of the passage densest in query terms."""
    words = _words_with_offsets(text)
    if not words:
        return 0, min(len(text), width)

    hits = [i for i, (word, _, _) in enumerate(words) if stem(word.casefold()) in query_stems]
    if not hits:
        return 0, min(len(text), width)

    best_start_word = hits[0]
    best_score = -1.0
    # Slide a window over the hit positions and keep the densest one.
    for i, start_word in enumerate(hits):
        start_char = words[start_word][1]
        distinct: set[str] = set()
        count = 0
        for j in range(i, len(hits)):
            if words[hits[j]][2] - start_char > width:
                break
            distinct.add(stem(words[hits[j]][0].casefold()))
            count += 1
        score = len(distinct) * 2 + count
        if score > best_score:
            best_score = score
            best_start_word = start_word

    center = words[best_start_word][1]
    start = max(0, center - width // 4)
    end = min(len(text), start + width)
    # Snap to word boundaries so snippets never start mid-word.
    if start > 0:
        space = text.find(" ", start)
        start = space + 1 if 0 <= space < start + 40 else start
    if end < len(text):
        space = text.rfind(" ", start, end)
        if space > start:
            end = space
    return start, end


def make_snippet(text: str, query_words, width: int = 260,
                 mark: bool = True) -> str:
    """Build an HTML-escaped snippet with ``<mark>`` around query terms."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return ""
    stems = {stem(w.casefold()) for w in query_words if w}
    stems.discard("")
    start, end = best_window(text, stems, width)
    fragment = text[start:end].strip()
    if not fragment:
        return ""

    escaped = html.escape(fragment)
    if mark and stems:
        def replace(match: re.Match) -> str:
            word = match.group(0)
            return f"<mark>{word}</mark>" if stem(word.casefold()) in stems else word

        escaped = _WORD_RE.sub(replace, escaped)

    prefix = "… " if start > 0 else ""
    suffix = " …" if end < len(text) else ""
    return prefix + escaped + suffix


def highlight(text: str, query_words) -> str:
    """Escape ``text`` and mark the query words inside it (used for titles)."""
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return ""
    stems = {stem(w.casefold()) for w in query_words if w}
    escaped = html.escape(text)
    if not stems:
        return escaped

    def replace(match: re.Match) -> str:
        word = match.group(0)
        return f"<mark>{word}</mark>" if stem(word.casefold()) in stems else word

    return _WORD_RE.sub(replace, escaped)


def plain(snippet_html: str) -> str:
    """Strip the markup again, for terminal output."""
    return html.unescape(re.sub(r"</?mark>", "", snippet_html))
