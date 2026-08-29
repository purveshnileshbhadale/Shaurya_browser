"""The command line interface."""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from shaurya.cli import main


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="shaurya-cli-")
        self.index = os.path.join(self.tmpdir, "index.db")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def run_cli(self, *args):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = main(["--index", self.index, "--no-colour", *args])
        return code, buffer.getvalue()

    def test_demo_then_search(self):
        code, output = self.run_cli("demo")
        self.assertEqual(code, 0)
        self.assertIn("demo documents", output)

        code, output = self.run_cli("search", "inverted", "index")
        self.assertEqual(code, 0)
        self.assertIn("The inverted index", output)

    def test_search_json_output_is_parseable(self):
        self.run_cli("demo")
        _code, output = self.run_cli("search", "--json", "bm25")
        payload = json.loads(output)
        self.assertEqual(payload["engine"], "SHAURYA")
        self.assertGreater(payload["total"], 0)

    def test_search_with_no_matches_exits_nonzero(self):
        self.run_cli("demo")
        code, output = self.run_cli("search", "zzzznotaword")
        self.assertEqual(code, 1)
        self.assertIn("no matches", output)

    def test_stats(self):
        self.run_cli("demo")
        _code, output = self.run_cli("stats", "--json")
        self.assertGreater(json.loads(output)["indexed"], 0)

    def test_add_local_files(self):
        notes = os.path.join(self.tmpdir, "notes")
        os.makedirs(notes)
        with open(os.path.join(notes, "tea.md"), "w") as handle:
            handle.write("# Tea notes\n\nSteep gyokuro at sixty degrees.")
        with open(os.path.join(notes, "ignored.bin"), "w") as handle:
            handle.write("binary-ish content")

        code, output = self.run_cli("add", notes)
        self.assertEqual(code, 0)
        self.assertIn("added 1 document", output)

        _code, output = self.run_cli("search", "gyokuro")
        self.assertIn("Tea notes", output)

    def test_add_html_file_uses_its_title(self):
        page = os.path.join(self.tmpdir, "page.html")
        with open(page, "w") as handle:
            handle.write("<html><head><title>Kettle Guide</title></head>"
                         "<body><p>A gooseneck kettle pours slowly.</p></body></html>")
        self.run_cli("add", page)
        _code, output = self.run_cli("search", "gooseneck")
        self.assertIn("Kettle Guide", output)

    def test_explain(self):
        self.run_cli("demo")
        _code, output = self.run_cli("explain", "https://shaurya.local/docs/bm25",
                                     "ranking")
        self.assertIn("factors", json.loads(output))

    def test_clear_empties_the_index(self):
        self.run_cli("demo")
        code, _output = self.run_cli("clear", "--yes")
        self.assertEqual(code, 0)
        _code, output = self.run_cli("stats", "--json")
        self.assertEqual(json.loads(output)["documents"], 0)

    def test_index_rebuild(self):
        self.run_cli("demo")
        code, output = self.run_cli("index", "--rebuild", "--quiet")
        self.assertEqual(code, 0)
        self.assertIn("documents", output)

    def test_rank(self):
        self.run_cli("demo")
        code, output = self.run_cli("rank")
        self.assertEqual(code, 0)
        self.assertIn("PageRank", output)

    def test_piping_into_a_closed_stream_exits_quietly(self):
        # `shaurya search ... | head` closes the pipe early; that must not
        # produce a traceback.
        class ClosedPipe(io.StringIO):
            def write(self, _text):
                raise BrokenPipeError(32, "Broken pipe")

        self.run_cli("demo")
        with contextlib.redirect_stdout(ClosedPipe()):
            code = main(["--index", self.index, "--no-colour", "search", "index"])
        self.assertEqual(code, 141)

    def test_no_command_prints_help(self):
        code, output = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("usage", output.lower())


if __name__ == "__main__":
    unittest.main()
