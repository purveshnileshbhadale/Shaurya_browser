"""The SHAURYA web server.

Serves the search UI and a small JSON API from the standard library's HTTP
server.  Every request is answered out of the local index; nothing leaves the
machine.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import web
from .config import Config
from .search import Searcher
from .store import Store

log = logging.getLogger("shaurya.server")

EXAMPLE_QUERIES = [
    "search engine",
    '"inverted index"',
    "ranking site:example.com",
    "crawler -robots",
]


class Handler(BaseHTTPRequestHandler):
    server_version = "SHAURYA/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------
    @property
    def searcher(self) -> Searcher:
        return self.server.searcher          # type: ignore[attr-defined]

    @property
    def store(self) -> Store:
        return self.server.store             # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, content_type: str,
              cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def html(self, markup: str, status: int = 200) -> None:
        self._send(status, markup.encode("utf-8"), "text/html; charset=utf-8")

    def json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:      # noqa: N802 - required by BaseHTTPRequestHandler
        parts = urlsplit(self.path)
        params = {k: v[0] for k, v in parse_qs(parts.query).items()}
        routes = {
            "/": self.home,
            "/search": self.search_page,
            "/api/search": self.api_search,
            "/api/suggest": self.api_suggest,
            "/api/stats": self.api_stats,
            "/api/explain": self.api_explain,
            "/opensearch.xml": self.opensearch,
            "/static/favicon.svg": self.favicon,
            "/healthz": self.healthz,
        }
        handler = routes.get(parts.path)
        if handler is None:
            self.not_found()
            return
        try:
            handler(params)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.exception("error handling %s", self.path)
            self.html(web.page("Error — SHAURYA",
                               "<main><h1>Something went wrong</h1>"
                               "<p><a href='/'>Back to search</a></p></main>"), 500)

    do_HEAD = do_GET

    # -- pages ------------------------------------------------------------
    def home(self, params: dict) -> None:
        if params.get("q"):
            self.search_page(params)
            return
        self.html(web.home(self.store.stats(), EXAMPLE_QUERIES))

    def search_page(self, params: dict) -> None:
        query = (params.get("q") or "").strip()
        if not query:
            self.redirect("/")
            return
        page = _int(params.get("p"), 1)
        size = min(_int(params.get("n"), self.searcher.config.page_size), 50)
        response = self.searcher.search(query, page=page, size=size)
        self.html(web.results(response, self.store.stats()))

    # -- api --------------------------------------------------------------
    def api_search(self, params: dict) -> None:
        query = (params.get("q") or "").strip()
        if not query:
            self.json({"error": "missing query parameter 'q'"}, 400)
            return
        response = self.searcher.search(
            query,
            page=_int(params.get("page") or params.get("p"), 1),
            size=min(_int(params.get("size") or params.get("n"), 10), 50),
            explain=params.get("explain") in ("1", "true", "yes"),
        )
        self.json(response.to_dict())

    def api_suggest(self, params: dict) -> None:
        query = (params.get("q") or "").strip()
        suggestions = self.searcher.suggester.complete(query, limit=8)
        if params.get("format") == "opensearch":
            # The shape browsers expect from a suggestions endpoint.
            self.json([query, suggestions])
            return
        self.json({"query": query, "suggestions": suggestions})

    def api_stats(self, params: dict) -> None:
        self.json({"engine": "SHAURYA", **self.store.stats()})

    def api_explain(self, params: dict) -> None:
        query = (params.get("q") or "").strip()
        url = (params.get("url") or "").strip()
        if not query or not url:
            self.json({"error": "both 'q' and 'url' are required"}, 400)
            return
        self.json(self.searcher.explain(query, url))

    def healthz(self, params: dict) -> None:
        self.json({"status": "ok", "engine": "SHAURYA"})

    def opensearch(self, params: dict) -> None:
        host = self.headers.get("Host") or f"{self.server.server_name}:{self.server.server_port}"
        body = web.opensearch(f"http://{host}").encode("utf-8")
        self._send(200, body, "application/opensearchdescription+xml; charset=utf-8",
                   cache="public, max-age=86400")

    def favicon(self, params: dict) -> None:
        self._send(200, web.FAVICON.encode("utf-8"), "image/svg+xml",
                   cache="public, max-age=86400")

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def not_found(self) -> None:
        self.html(
            web.page(
                "Not found — SHAURYA",
                "<main style='padding:3rem 1.5rem'><h1>404</h1>"
                "<p>No such page. <a href='/'>Search instead</a>.</p></main>",
            ),
            404,
        )


def _int(value, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


class SearchServer(ThreadingHTTPServer):
    """An HTTP server that carries the index along with it."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, store: Store, config: Config):
        super().__init__((config.host, config.port), Handler)
        self.store = store
        self.config = config
        self.searcher = Searcher(store, config)

    def server_bind(self) -> None:
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        super().server_bind()


def serve(store: Store, config: Config | None = None, background: bool = False):
    """Start the SHAURYA server."""
    config = config or Config()
    server = SearchServer(store, config)
    url = f"http://{config.host}:{server.server_port}"
    if background:
        thread = threading.Thread(target=server.serve_forever, daemon=True,
                                  name="shaurya-server")
        thread.start()
        return server, url
    print(f"SHAURYA is searching at {url}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSHAURYA stopped.")
    finally:
        server.shutdown()
        server.server_close()
    return server, url
