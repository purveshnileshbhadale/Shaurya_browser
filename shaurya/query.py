"""The SHAURYA query language.

Supported syntax::

    coffee brewing          all words, ranked by relevance
    "french press"          exact phrase
    coffee -instant         exclude a word
    site:example.com        restrict to a site
    -site:spam.example      exclude a site
    intitle:brewing         the word must appear in the title
    inurl:docs              the word must appear in the URL
    lang:en                 restrict by declared language
    coffee OR tea           either word satisfies the query
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass, field

from .text import STOPWORDS, stem, tokenize

_FILTER_RE = re.compile(
    r"^(?P<neg>-)?(?P<key>site|intitle|inurl|lang|filetype|host)::?(?P<value>.+)$", re.I
)


@dataclass
class Term:
    """One searchable word."""

    raw: str            # as the user typed it
    stem: str           # as it appears in the index
    required: bool = True
    is_stopword: bool = False


@dataclass
class Phrase:
    raw: str
    stems: list[str]
    negated: bool = False


@dataclass
class Query:
    """A parsed query, ready for the searcher."""

    raw: str = ""
    terms: list[Term] = field(default_factory=list)
    phrases: list[Phrase] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)
    sites: list[str] = field(default_factory=list)
    not_sites: list[str] = field(default_factory=list)
    intitle: list[str] = field(default_factory=list)
    inurl: list[str] = field(default_factory=list)
    lang: str = ""
    filetype: str = ""

    @property
    def is_empty(self) -> bool:
        return not (self.terms or self.phrases or self.sites or self.intitle
                    or self.inurl)

    @property
    def stems(self) -> list[str]:
        """Every stem the query looks for, phrases included, in order."""
        seen: dict[str, None] = {}
        for term in self.terms:
            seen.setdefault(term.stem, None)
        for phrase in self.phrases:
            if not phrase.negated:
                for token in phrase.stems:
                    seen.setdefault(token, None)
        return list(seen)

    @property
    def required_stems(self) -> list[str]:
        """Stems a good match should contain (stopwords do not count)."""
        return [t.stem for t in self.terms if t.required and not t.is_stopword]

    @property
    def words(self) -> list[str]:
        """Original words, used for highlighting snippets."""
        out = [t.raw for t in self.terms]
        for phrase in self.phrases:
            if not phrase.negated:
                out.extend(tokenize(phrase.raw))
        return out

    def describe(self) -> str:
        parts = []
        if self.terms:
            parts.append(" ".join(t.raw for t in self.terms))
        parts += [f'"{p.raw}"' for p in self.phrases if not p.negated]
        parts += [f"site:{s}" for s in self.sites]
        parts += [f"-{w}" for w in self.excluded]
        return " ".join(parts)


def _split(text: str) -> list[str]:
    """Split on whitespace while keeping quoted runs together."""
    lexer = shlex.shlex(text, posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    lexer.quotes = '"'
    try:
        return list(lexer)
    except ValueError:
        # An unbalanced quote: treat the rest as literal words.
        return text.replace('"', " ").split()


def parse(text: str) -> Query:
    """Parse a query string into a :class:`Query`."""
    query = Query(raw=(text or "").strip())
    if not query.raw:
        return query

    # shlex drops the quotes, so remember which pieces were quoted.
    quoted: set[str] = set()
    for match in re.finditer(r'"([^"]+)"', query.raw):
        quoted.add(match.group(1).strip())

    pending_or = False
    for token in _split(query.raw):
        if not token.strip():
            continue
        upper = token.upper()
        if upper in ("OR", "|"):
            pending_or = True
            if query.terms:
                query.terms[-1].required = False
            continue
        if upper == "AND":
            continue

        negated = token.startswith("-") and len(token) > 1
        body = token[1:] if negated else token

        filter_match = _FILTER_RE.match(token)
        if filter_match:
            key = filter_match.group("key").lower()
            value = filter_match.group("value").strip().strip('"').lower()
            is_neg = bool(filter_match.group("neg"))
            if not value:
                continue
            if key in ("site", "host"):
                (query.not_sites if is_neg else query.sites).append(
                    value.removeprefix("www.")
                )
            elif key == "intitle":
                query.intitle.append(stem(value))
            elif key == "inurl":
                query.inurl.append(value)
            elif key == "lang":
                query.lang = value[:5]
            elif key == "filetype":
                query.filetype = value.lstrip(".")
            continue

        if body in quoted or " " in body:
            stems = [stem(t) for t in tokenize(body)]
            if stems:
                query.phrases.append(Phrase(raw=body, stems=stems, negated=negated))
                if not negated:
                    for raw_token, token_stem in zip(tokenize(body), stems):
                        query.terms.append(
                            Term(
                                raw=raw_token,
                                stem=token_stem,
                                required=True,
                                is_stopword=raw_token in STOPWORDS,
                            )
                        )
            continue

        for raw_token in tokenize(body):
            token_stem = stem(raw_token)
            if negated:
                query.excluded.append(token_stem)
            else:
                query.terms.append(
                    Term(
                        raw=raw_token,
                        stem=token_stem,
                        required=not pending_or,
                        is_stopword=raw_token in STOPWORDS,
                    )
                )
        pending_or = False

    return query
