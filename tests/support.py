"""Shared helpers for the SHAURYA test suite."""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

from shaurya.config import Config
from shaurya.indexer import index_text
from shaurya.store import Store

CORPUS = [
    ("https://brew.test/french-press", "How to use a French Press",
     "A french press brews coffee by steeping coarse ground beans in hot water "
     "for four minutes. Press the plunger down slowly."),
    ("https://brew.test/espresso", "Espresso Basics",
     "Espresso forces hot water through finely ground coffee under nine bars of "
     "pressure. A good shot takes 25 seconds."),
    ("https://brew.test/grinders", "Choosing a Coffee Grinder",
     "A burr grinder gives an even grind for coffee. Blade grinders make dust."),
    ("https://tea.test/green-tea", "Brewing Green Tea",
     "Green tea should steep at 80 degrees for two minutes. Boiling water "
     "scorches the leaves and makes the tea bitter."),
    ("https://garden.test/beans", "Growing Beans",
     "Beans are easy to grow. Plant beans after the last frost and water them "
     "well. Runner beans climb a frame."),
]


class IndexTestCase(unittest.TestCase):
    """A test case with a throwaway index preloaded with :data:`CORPUS`."""

    corpus = CORPUS

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="shaurya-test-")
        self.config = Config(index_path=os.path.join(self.tmpdir, "index.db"))
        self.store = Store(self.config.index_path)
        for url, title, body in self.corpus:
            index_text(self.store, url, title, body, config=self.config)

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def urls(self, response) -> list[str]:
        return [result.url for result in response.results]
