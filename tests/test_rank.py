"""Ranking primitives."""

import unittest

from shaurya import rank


class ScoringTests(unittest.TestCase):
    def test_rare_terms_carry_more_weight(self):
        self.assertGreater(rank.idf(1000, 1), rank.idf(1000, 900))

    def test_idf_is_never_negative(self):
        for df in (0, 1, 500, 1000, 5000):
            self.assertGreaterEqual(rank.idf(1000, df), 0.0)

    def test_idf_of_an_empty_corpus(self):
        self.assertEqual(rank.idf(0, 0), 0.0)

    def test_term_frequency_saturates(self):
        scores = [rank.bm25(tf, 100, 100, 1.0) for tf in (1, 2, 5, 50, 500)]
        self.assertTrue(all(b > a for a, b in zip(scores, scores[1:])))
        # The step from 1->2 must dwarf the step from 50->500.
        self.assertGreater(scores[1] - scores[0], scores[4] - scores[3])

    def test_long_documents_are_normalised_down(self):
        short = rank.bm25(3, 50, 100, 1.0)
        long = rank.bm25(3, 400, 100, 1.0)
        self.assertGreater(short, long)

    def test_zero_frequency_scores_nothing(self):
        self.assertEqual(rank.bm25(0, 100, 100, 1.0), 0.0)

    def test_coverage_rewards_complete_matches(self):
        self.assertEqual(rank.coverage_factor(3, 3), 1.0)
        self.assertLess(rank.coverage_factor(1, 3), rank.coverage_factor(2, 3))
        self.assertEqual(rank.coverage_factor(0, 0), 1.0)


class PositionTests(unittest.TestCase):
    def test_shortest_span(self):
        self.assertEqual(rank.shortest_span([[1, 50], [3, 60], [5, 61]]), 5)
        self.assertEqual(rank.shortest_span([[0], [1], [2]]), 3)
        self.assertEqual(rank.shortest_span([[0, 100], [99]]), 2)

    def test_shortest_span_with_a_missing_term(self):
        self.assertIsNone(rank.shortest_span([[1, 2], []]))

    def test_phrase_hits_requires_order_and_adjacency(self):
        self.assertEqual(rank.phrase_hits([[0, 10], [1, 11], [2, 99]]), 1)
        self.assertEqual(rank.phrase_hits([[0], [5]]), 0)      # not adjacent
        self.assertEqual(rank.phrase_hits([[5], [4]]), 0)      # wrong order
        self.assertEqual(rank.phrase_hits([[0, 10], [1, 11]]), 2)

    def test_phrase_hits_with_a_missing_term(self):
        self.assertEqual(rank.phrase_hits([[1], []]), 0)

    def test_proximity_prefers_nearby_terms(self):
        near = rank.proximity_factor([[0], [1], [2]], 1.5)
        far = rank.proximity_factor([[0], [400], [900]], 1.5)
        self.assertGreater(near, far)
        self.assertAlmostEqual(far, 1.0, places=2)

    def test_proximity_is_neutral_for_single_terms(self):
        self.assertEqual(rank.proximity_factor([[0, 5]], 1.5), 1.0)


class SignalTests(unittest.TestCase):
    def test_freshness_prefers_recent_pages(self):
        now = 1_000_000_000.0
        fresh = rank.freshness_factor(now - 3600, 0.15, now)
        stale = rank.freshness_factor(now - 400 * 86400, 0.15, now)
        self.assertGreater(fresh, stale)
        self.assertEqual(rank.freshness_factor(None, 0.15, now), 1.0)
        self.assertEqual(rank.freshness_factor(now, 0.0, now), 1.0)

    def test_link_factor_is_bounded(self):
        self.assertEqual(rank.link_factor(0.0, 2.0), 1.0)
        self.assertEqual(rank.link_factor(1.0, 2.0), 3.0)
        self.assertEqual(rank.link_factor(5.0, 2.0), 3.0)   # clamped
        self.assertEqual(rank.link_factor(None, 2.0), 1.0)


if __name__ == "__main__":
    unittest.main()
