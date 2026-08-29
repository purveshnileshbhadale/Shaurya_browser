"""URL normalisation.

Two URLs that fetch the same page should collapse to one index entry, or the
crawler wastes its budget and the results list shows duplicates.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin

# Parameters that identify a campaign, not a document.
_TRACKING = re.compile(
    r"^(utm_\w+|fbclid|gclid|gclsrc|dclid|msclkid|mc_[ce]id|_ga|ref|ref_src|"
    r"igshid|yclid|si|s_kwcid|vero_id|spm|scm)$",
    re.I,
)
_DEFAULT_PORTS = {"http": "80", "https": "443"}
_INDEX_FILES = re.compile(r"/(index|default|home)\.(html?|php|aspx?|jsp)$", re.I)


def normalize(url: str, base: str = "") -> str:
    """Canonicalise a URL; returns '' when it is not a crawlable http(s) URL."""
    if not url:
        return ""
    url = url.strip().replace(" ", "%20")
    if base:
        try:
            url = urljoin(base, url)
        except ValueError:
            return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""

    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        return ""

    host = parts.hostname or ""
    try:
        host = host.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        host = host.lower()
    if not host:
        return ""

    netloc = host
    if parts.port and str(parts.port) != _DEFAULT_PORTS.get(scheme):
        netloc = f"{host}:{parts.port}"

    path = _resolve_dots(parts.path or "/")
    path = _INDEX_FILES.sub("/", path)
    if not path:
        path = "/"

    query = urlencode(
        [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if not _TRACKING.match(k)],
        doseq=True,
    )
    return urlunsplit((scheme, netloc, path, query, ""))


def _resolve_dots(path: str) -> str:
    """Collapse '.' and '..' segments and repeated slashes."""
    trailing = path.endswith("/")
    out: list[str] = []
    for segment in path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if out:
                out.pop()
            continue
        out.append(segment)
    resolved = "/" + "/".join(out)
    if trailing and not resolved.endswith("/"):
        resolved += "/"
    return resolved


def host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def registrable(url_or_host: str) -> str:
    """Best-effort site name: 'docs.python.org' -> 'python.org'."""
    h = url_or_host if "/" not in url_or_host else host(url_or_host)
    parts = h.split(".")
    if len(parts) <= 2:
        return h
    # Handle the common two-level public suffixes without a full PSL.
    if parts[-2] in ("co", "com", "org", "net", "gov", "ac", "edu") and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def same_site(a: str, b: str) -> bool:
    return registrable(a) == registrable(b)


def words(url: str) -> str:
    """The indexable words hiding inside a URL."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    raw = f"{parts.hostname or ''} {parts.path} {parts.query}"
    return re.sub(r"\s+", " ", re.sub(r"[/._\-+=&?%~,:]+", " ", raw)).strip()


def is_probably_binary(url: str) -> bool:
    """Skip links that clearly point at things we cannot index as text."""
    path = urlsplit(url).path.lower()
    return path.endswith((
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff",
        ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".webm", ".wav", ".flac", ".ogg",
        ".zip", ".gz", ".tar", ".bz2", ".xz", ".7z", ".rar", ".dmg", ".iso",
        ".exe", ".msi", ".deb", ".rpm", ".apk", ".jar", ".bin", ".woff", ".woff2",
        ".ttf", ".otf", ".eot", ".css", ".js", ".mjs", ".map", ".wasm",
    ))
