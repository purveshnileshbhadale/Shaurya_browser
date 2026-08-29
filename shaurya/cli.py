"""Command line interface for SHAURYA.

    shaurya demo                     index the built-in corpus and serve it
    shaurya crawl https://site/      fetch, index and rank a site
    shaurya add ./notes              index local files
    shaurya search "french press"    query from the terminal
    shaurya serve                    open the web interface
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import textwrap
import time

from . import __version__, demo
from .config import Config
from .crawler import Crawler
from .indexer import Indexer, index_text
from .linkgraph import update_ranks
from .search import Searcher
from .snippet import plain
from .store import Store

TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".rst", ".html", ".htm", ".xhtml"}


# --------------------------------------------------------------------------
# terminal helpers
# --------------------------------------------------------------------------

def _colour(enabled: bool):
    if not enabled or not sys.stdout.isatty():
        return lambda text, _code="": text
    return lambda text, code="0": f"\033[{code}m{text}\033[0m"


def _banner(paint) -> str:
    return paint("SHAURYA", "1;33") + paint(f" v{__version__}", "2")


def _human(number: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if number < 1024 or unit == "GB":
            return f"{number:.0f} {unit}" if unit == "B" else f"{number:.1f} {unit}"
        number /= 1024
    return f"{number:.1f} GB"


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_crawl(args, store: Store, config: Config, paint) -> int:
    config.max_pages = args.max_pages
    config.max_depth = args.depth
    config.threads = args.threads
    config.crawl_delay = args.delay
    config.same_host_only = args.same_host
    config.obey_robots = not args.ignore_robots
    config.allow_hosts = tuple(args.allow or ())
    config.deny_patterns = tuple(args.deny or ())

    seen = [0]

    def on_page(url: str, title: str, status: int) -> None:
        seen[0] += 1
        if not args.quiet:
            label = (title or url)[:64]
            print(f"  {paint(f'{seen[0]:4}', '2')} {label}\n       {paint(url, '2')}")

    crawler = Crawler(store, config, on_page=on_page)
    print(f"{_banner(paint)} crawling {len(args.seeds)} seed(s), "
          f"budget {config.max_pages} pages, depth {config.max_depth}")
    stats = crawler.run(args.seeds)
    print(f"\n{paint('crawled', '1')}: {json.dumps(stats.as_dict())}")

    if not args.no_index:
        result = Indexer(store, config).run()
        print(f"{paint('indexed', '1')}: {json.dumps(result)}")
        ranks = update_ranks(store)
        print(f"{paint('ranked', '1')}:  {ranks['documents']} documents")
    return 0


def cmd_index(args, store: Store, config: Config, paint) -> int:
    def progress(count: int) -> None:
        print(f"  indexed {count} documents", end="\r", flush=True)

    result = Indexer(store, config).run(rebuild=args.rebuild,
                                        progress=None if args.quiet else progress)
    print(" " * 40, end="\r")
    print(f"{_banner(paint)} {json.dumps(result)}")
    if not args.no_rank:
        ranks = update_ranks(store)
        print(f"ranked {ranks['documents']} documents")
    return 0


def cmd_rank(args, store: Store, config: Config, paint) -> int:
    result = update_ranks(store)
    print(f"{_banner(paint)} PageRank over {result['documents']} documents")
    for entry in result["top"]:
        print(f"  {entry['rank']:.4f}  {entry['url']}")
    return 0


def cmd_add(args, store: Store, config: Config, paint) -> int:
    added = 0
    for target in args.paths:
        for path in _walk(target):
            try:
                text = path_read(path)
            except OSError as exc:
                print(f"  skipped {path}: {exc}", file=sys.stderr)
                continue
            if not text.strip():
                continue
            url = "file://" + os.path.abspath(path)
            title = os.path.basename(path)
            if path.lower().endswith((".html", ".htm", ".xhtml")):
                from .htmlparse import parse_html
                parsed = parse_html(text, url)
                index_text(store, url, parsed.title or title, parsed.text,
                           description=parsed.description,
                           headings="\n".join(parsed.headings), config=config)
            else:
                index_text(store, url, _title_of(text, title), text, config=config)
            added += 1
            if not args.quiet:
                print(f"  + {path}")
    print(f"{_banner(paint)} added {added} document(s)")
    return 0


def _title_of(text: str, fallback: str) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped[:200]
    return fallback


def path_read(path: str) -> str:
    with open(path, "rb") as handle:
        return handle.read(4 * 1024 * 1024).decode("utf-8", "replace")


def _walk(target: str):
    if os.path.isfile(target):
        yield target
        return
    for root, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in sorted(files):
            if os.path.splitext(name)[1].lower() in TEXT_SUFFIXES:
                yield os.path.join(root, name)


def cmd_search(args, store: Store, config: Config, paint) -> int:
    searcher = Searcher(store, config)
    query = " ".join(args.query)
    response = searcher.search(query, page=args.page, size=args.number,
                               explain=args.explain)
    if args.json:
        print(json.dumps(response.to_dict(), indent=2))
        return 0

    print(f"{_banner(paint)} {response.total} result(s) for "
          f"{paint(query, '1')} in {response.elapsed_ms:.1f} ms")
    if response.suggestion:
        print(f"  did you mean: {paint(response.suggestion, '1;33')}")
    if not response.results:
        print("  no matches")
        return 1
    print()
    offset = (response.page - 1) * response.size
    for number, result in enumerate(response.results, start=offset + 1):
        print(f"{paint(f'{number:2}.', '2')} {paint(result.title, '1')}")
        print(f"    {paint(result.url, '4;36')}")
        text = plain(result.snippet)
        if text:
            for line in textwrap.wrap(text, width=94)[:3]:
                print(f"    {paint(line, '2')}")
        if args.explain:
            print(f"    {paint(json.dumps(result.explain), '2')}")
        print()
    if response.pages > 1:
        print(paint(f"page {response.page} of {response.pages} "
                    f"(--page {response.page + 1} for more)", "2"))
    return 0


def cmd_serve(args, store: Store, config: Config, paint) -> int:
    from .server import serve

    config.host = args.host
    config.port = args.port
    stats = store.stats()
    if stats["indexed"] == 0:
        print(paint("The index is empty. Try 'shaurya demo' or "
                    "'shaurya crawl <url>' first.", "1;33"))
    serve(store, config)
    return 0


def cmd_demo(args, store: Store, config: Config, paint) -> int:
    count = demo.load(store)
    update_ranks(store)
    print(f"{_banner(paint)} loaded {count} demo documents into {store.path}")
    if args.serve:
        from .server import serve
        config.host, config.port = args.host, args.port
        serve(store, config)
    else:
        print("Try:  shaurya search \"inverted index\"   |   shaurya serve")
    return 0


def cmd_stats(args, store: Store, config: Config, paint) -> int:
    stats = store.stats()
    if args.json:
        print(json.dumps(stats, indent=2))
        return 0
    print(_banner(paint) + f"  index: {store.path}")
    rows = [
        ("documents", f"{stats['documents']:,}"),
        ("indexed", f"{stats['indexed']:,}"),
        ("sites", f"{stats['hosts']:,}"),
        ("unique terms", f"{stats['terms']:,}"),
        ("postings", f"{stats['postings']:,}"),
        ("tokens", f"{stats['tokens']:,}"),
        ("avg doc length", f"{stats['avg_doc_length']:.0f} tokens"),
        ("index size", _human(stats["index_bytes"])),
        ("frontier", ", ".join(f"{k}={v}" for k, v in stats["frontier"].items())),
    ]
    width = max(len(label) for label, _ in rows)
    for label, value in rows:
        print(f"  {label.rjust(width)}  {paint(value, '1')}")
    return 0


def cmd_explain(args, store: Store, config: Config, paint) -> int:
    searcher = Searcher(store, config)
    print(json.dumps(searcher.explain(" ".join(args.query), args.url), indent=2))
    return 0


def cmd_clear(args, store: Store, config: Config, paint) -> int:
    if not args.yes:
        answer = input(f"Delete every document in {store.path}? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("cancelled")
            return 1
    conn = store.conn
    for table in ("postings", "terms", "links", "docs", "frontier", "forms", "queries"):
        conn.execute(f"DELETE FROM {table}")
    conn.execute("VACUUM")
    print(f"{_banner(paint)} index cleared")
    return 0


# --------------------------------------------------------------------------
# argument parsing
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shaurya",
        description="SHAURYA - a search engine you can run yourself.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent(
            """\
            examples:
              shaurya demo --serve                 try it immediately
              shaurya crawl https://example.com    crawl, index and rank a site
              shaurya add ./docs                   index local text files
              shaurya search '"french press" -instant'
              shaurya serve --port 8080            open the web interface
            """
        ),
    )
    parser.add_argument("--index", default=Config.index_path,
                        help="path to the index database (default: %(default)s)")
    parser.add_argument("--no-colour", action="store_true", help="plain output")
    parser.add_argument("--version", action="version", version=f"SHAURYA {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="command")

    crawl = sub.add_parser("crawl", help="fetch pages and add them to the index")
    crawl.add_argument("seeds", nargs="+", help="one or more start URLs")
    crawl.add_argument("-n", "--max-pages", type=int, default=200)
    crawl.add_argument("-d", "--depth", type=int, default=3)
    crawl.add_argument("-t", "--threads", type=int, default=8)
    crawl.add_argument("--delay", type=float, default=0.5,
                       help="seconds between requests to one host")
    crawl.add_argument("--same-host", action="store_true",
                       help="never leave the seed sites")
    crawl.add_argument("--allow", action="append", metavar="HOST")
    crawl.add_argument("--deny", action="append", metavar="REGEX")
    crawl.add_argument("--ignore-robots", action="store_true",
                       help="do not read robots.txt (use only on your own sites)")
    crawl.add_argument("--no-index", action="store_true",
                       help="fetch only; run 'shaurya index' later")
    crawl.add_argument("-q", "--quiet", action="store_true")
    crawl.set_defaults(func=cmd_crawl)

    index = sub.add_parser("index", help="build the inverted index")
    index.add_argument("--rebuild", action="store_true",
                       help="re-index every document, not just new ones")
    index.add_argument("--no-rank", action="store_true", help="skip PageRank")
    index.add_argument("-q", "--quiet", action="store_true")
    index.set_defaults(func=cmd_index)

    rank = sub.add_parser("rank", help="recompute PageRank over the link graph")
    rank.set_defaults(func=cmd_rank)

    add = sub.add_parser("add", help="index local files or directories")
    add.add_argument("paths", nargs="+")
    add.add_argument("-q", "--quiet", action="store_true")
    add.set_defaults(func=cmd_add)

    search = sub.add_parser("search", help="query the index")
    search.add_argument("query", nargs="+")
    search.add_argument("-n", "--number", type=int, default=10)
    search.add_argument("-p", "--page", type=int, default=1)
    search.add_argument("--json", action="store_true")
    search.add_argument("--explain", action="store_true",
                        help="show the ranking factors for each result")
    search.set_defaults(func=cmd_search)

    serve_cmd = sub.add_parser("serve", help="run the web interface")
    serve_cmd.add_argument("--host", default="127.0.0.1")
    serve_cmd.add_argument("--port", type=int, default=8080)
    serve_cmd.set_defaults(func=cmd_serve)

    demo_cmd = sub.add_parser("demo", help="load the built-in corpus")
    demo_cmd.add_argument("--serve", action="store_true", help="then start the server")
    demo_cmd.add_argument("--host", default="127.0.0.1")
    demo_cmd.add_argument("--port", type=int, default=8080)
    demo_cmd.set_defaults(func=cmd_demo)

    stats = sub.add_parser("stats", help="describe the index")
    stats.add_argument("--json", action="store_true")
    stats.set_defaults(func=cmd_stats)

    explain = sub.add_parser("explain", help="show why a URL ranks where it does")
    explain.add_argument("url")
    explain.add_argument("query", nargs="+")
    explain.set_defaults(func=cmd_explain)

    clear = sub.add_parser("clear", help="empty the index")
    clear.add_argument("-y", "--yes", action="store_true")
    clear.set_defaults(func=cmd_clear)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0

    paint = _colour(not args.no_colour)
    config = Config(index_path=args.index)
    store = Store(config.index_path)
    started = time.time()
    try:
        return args.func(args, store, config, paint)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except BrokenPipeError:
        # Something downstream (head, less) stopped reading.  Point stdout at
        # /dev/null so the interpreter does not report the same error again
        # while flushing at exit, then leave quietly.  Stdout is not always a
        # real file descriptor, so this is best effort.
        try:
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        except (OSError, ValueError, AttributeError, io.UnsupportedOperation):
            pass
        return 141
    finally:
        if os.environ.get("SHAURYA_TIMING"):
            print(f"[{time.time() - started:.2f}s]", file=sys.stderr)
        store.close()


if __name__ == "__main__":
    sys.exit(main())
