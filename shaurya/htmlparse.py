"""Turn a raw HTML byte string into the fields SHAURYA indexes.

The extractor is deliberately conservative: it drops chrome (scripts, styles,
nav, footers) and keeps the readable text, the headings, the description and
every outgoing link with its anchor text.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin

# Elements whose text is never content.
# ``head`` is not skipped: title, meta and canonical live there.
_SKIP_CONTENT = {"script", "style", "noscript", "template", "svg", "canvas"}
# Elements that usually hold site chrome rather than the page's own text.
_CHROME = {"nav", "footer", "aside", "form"}
# Elements that imply a line break in the extracted text.
_BLOCK = {
    "p", "div", "br", "li", "tr", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "td", "th", "hr",
}
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}

_WS = re.compile(r"[ \t\r\f\v]+")
_BLANKS = re.compile(r"\n{3,}")


@dataclass
class Document:
    """Everything extracted from one HTML page."""

    url: str = ""
    title: str = ""
    description: str = ""
    text: str = ""
    lang: str = ""
    canonical: str = ""
    headings: list[str] = field(default_factory=list)
    links: list[tuple[str, str]] = field(default_factory=list)  # (absolute url, anchor)
    noindex: bool = False
    nofollow: bool = False


class _Extractor(HTMLParser):
    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.doc = Document(url=base_url)
        self._base = base_url
        self._skip_depth = 0
        self._chrome_depth = 0
        self._in_title = False
        self._heading: str | None = None
        self._chunks: list[str] = []
        self._anchor: list[str] | None = None
        self._anchor_href = ""

    # -- helpers ----------------------------------------------------------
    def _emit(self, text: str) -> None:
        if self._chrome_depth == 0:
            self._chunks.append(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in _SKIP_CONTENT:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in _CHROME:
            self._chrome_depth += 1

        if tag == "html" and attrs.get("lang"):
            self.doc.lang = attrs["lang"].split("-")[0].strip().lower()
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            self._meta(attrs)
        elif tag == "link" and "canonical" in (attrs.get("rel") or "").lower():
            href = (attrs.get("href") or "").strip()
            if href:
                self.doc.canonical = urljoin(self._base, href)
        elif tag == "a":
            self._anchor_href = (attrs.get("href") or "").strip()
            self._anchor = []
            rel = (attrs.get("rel") or "").lower()
            if "nofollow" in rel:
                self._anchor_href = ""
        elif tag == "img" and attrs.get("alt"):
            self._emit(" " + attrs["alt"] + " ")
        elif tag in _HEADINGS:
            self._heading = ""

        if tag in _BLOCK:
            self._emit("\n")

    def _meta(self, attrs: dict) -> None:
        name = (attrs.get("name") or attrs.get("property") or "").lower()
        content = (attrs.get("content") or "").strip()
        if not content:
            return
        if name in ("description", "og:description", "twitter:description"):
            if not self.doc.description:
                self.doc.description = content
        elif name in ("og:title", "twitter:title") and not self.doc.title:
            self.doc.title = content
        elif name == "robots":
            directives = {d.strip() for d in content.lower().split(",")}
            self.doc.noindex = "noindex" in directives or "none" in directives
            self.doc.nofollow = "nofollow" in directives or "none" in directives

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in _SKIP_CONTENT and self._skip_depth:
            self._skip_depth -= 1

    def handle_endtag(self, tag):
        if tag in _SKIP_CONTENT:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == "title":
            self._in_title = False
        elif tag == "a":
            self._close_anchor()
        elif tag in _HEADINGS and self._heading is not None:
            heading = _WS.sub(" ", self._heading).strip()
            if heading:
                self.doc.headings.append(heading)
            self._heading = None
        if tag in _CHROME:
            self._chrome_depth = max(0, self._chrome_depth - 1)
        if tag in _BLOCK:
            self._emit("\n")

    def _close_anchor(self) -> None:
        if self._anchor is None:
            return
        anchor_text = _WS.sub(" ", "".join(self._anchor)).strip()[:200]
        href = self._anchor_href
        self._anchor = None
        self._anchor_href = ""
        if not href or href.startswith(("javascript:", "mailto:", "tel:", "#", "data:")):
            return
        try:
            absolute = urljoin(self._base, href)
        except ValueError:
            return
        if absolute.split(":", 1)[0].lower() in ("http", "https"):
            self.doc.links.append((absolute, anchor_text))

    def handle_data(self, data):
        if self._skip_depth or not data.strip():
            # Whitespace between two elements still separates their words.
            if not self._skip_depth and data:
                self._emit(" ")
            return
        if self._in_title:
            self.doc.title += data
            return
        if self._heading is not None:
            self._heading += data
        if self._anchor is not None:
            self._anchor.append(data)
        self._emit(data)

    def result(self) -> Document:
        text = "".join(self._chunks)
        text = _WS.sub(" ", text)
        text = "\n".join(line.strip() for line in text.split("\n"))
        self.doc.text = _BLANKS.sub("\n\n", text).strip()
        self.doc.title = _WS.sub(" ", self.doc.title).strip()
        self.doc.description = _WS.sub(" ", self.doc.description).strip()
        return self.doc


def parse_html(content: str, base_url: str = "") -> Document:
    """Extract title, text, headings and links from an HTML string."""
    parser = _Extractor(base_url)
    try:
        parser.feed(content)
        parser.close()
    except Exception:
        # A malformed page still yields whatever was parsed before the error.
        pass
    doc = parser.result()
    if not doc.title:
        first_line = next((l for l in doc.text.split("\n") if l.strip()), "")
        doc.title = first_line[:120]
    return doc


def parse_text(content: str, base_url: str = "") -> Document:
    """Wrap a plain-text document in the same structure."""
    lines = [l.strip() for l in content.splitlines()]
    title = next((l.lstrip("# ").strip() for l in lines if l.strip()), "")
    return Document(url=base_url, title=title[:200], text=content.strip())


def decode(raw: bytes, content_type: str = "") -> str:
    """Decode bytes using the charset from the header, then the meta tag."""
    charset = ""
    match = re.search(r"charset=([\w\-]+)", content_type or "", re.I)
    if match:
        charset = match.group(1)
    if not charset:
        head = raw[:4096].decode("latin-1", "replace")
        meta = re.search(r"charset=[\"']?([\w\-]+)", head, re.I)
        if meta:
            charset = meta.group(1)
    for candidate in (charset, "utf-8", "cp1252", "latin-1"):
        if not candidate:
            continue
        try:
            return raw.decode(candidate)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", "replace")


def unescape(text: str) -> str:
    return html.unescape(text)
