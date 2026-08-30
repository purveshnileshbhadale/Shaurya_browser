package dev.shaurya.browser.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Site colours and the greeting.
 *
 * The property that matters is stability: a tile whose colour changes between
 * launches, or between two pages of the same site, is worse than a grey one.
 */
class AccentsTest {

    @Test
    fun `a site keeps its colour across its pages`() {
        val home = Accents.hueFor("https://github.com/")
        for (url in listOf(
            "https://github.com/explore",
            "https://github.com/anthropics/sdk?tab=readme",
            "http://www.github.com/",
            "https://GITHUB.com/Some/Path",
        )) {
            assertEquals("$url drifted off github's hue", home, Accents.hueFor(url), 0.001f)
        }
    }

    @Test
    fun `the colour does not depend on position or run`() {
        // Called twice, and interleaved with other sites, to catch any
        // accidental statefulness in the hash.
        val a = Accents.hueFor("https://wikipedia.org")
        Accents.hueFor("https://example.com")
        val b = Accents.hueFor("https://wikipedia.org")
        assertEquals(a, b, 0.0f)
    }

    @Test
    fun `different sites get visibly different hues`() {
        val sites = listOf(
            "https://github.com", "https://wikipedia.org", "https://theguardian.com",
            "https://reddit.com", "https://youtube.com", "https://stackoverflow.com",
            "https://bbc.co.uk", "https://maps.google.com",
        )
        val hues = sites.map { Accents.hueFor(it) }
        assertEquals("two sites collided on the same hue", hues.size, hues.toSet().size)

        // Not a spread guarantee — a hash cannot promise one — but a sanity
        // check that they are not all bunched in one corner of the wheel.
        assertTrue("hues span only ${hues.max() - hues.min()} degrees",
            hues.max() - hues.min() > 120f)
    }

    @Test
    fun `hues stay in range for odd input`() {
        for (url in listOf("", "not a url", "http://localhost:3000", "https://a.b.c.d.e/")) {
            val h = Accents.hueFor(url)
            assertTrue("hue $h out of range for '$url'", h >= 0f && h < 360f)
        }
    }

    @Test
    fun `every tile is dark enough for white initials`() {
        // The initials are drawn white on the gradient. If any hue produces a
        // pale tile the letter vanishes, which is exactly the kind of defect
        // that only shows up on the one site a user actually has.
        for (hueSite in 0..359) {
            val (start, end) = Accents.tileColors("https://x$hueSite.com")
            for (c in listOf(start, end)) {
                val contrast = (1.0f + 0.05f) / (Palette.luminance(c) + 0.05f)
                assertTrue(
                    "white on ${"#%06X".format(c and 0xFFFFFF)} is only " +
                        "${"%.2f".format(contrast)}:1",
                    contrast >= 3.0f,
                )
            }
        }
    }

    @Test
    fun `the gradient end is darker than its start`() {
        for (site in listOf("https://github.com", "https://bbc.co.uk", "https://x.dev")) {
            val (start, end) = Accents.tileColors(site)
            assertTrue("$site: gradient does not descend",
                Palette.luminance(end) < Palette.luminance(start))
        }
    }

    @Test
    fun `the greeting matches the hour`() {
        assertEquals("Good night", Accents.greeting(2))
        assertEquals("Good morning", Accents.greeting(5))
        assertEquals("Good morning", Accents.greeting(11))
        assertEquals("Good afternoon", Accents.greeting(12))
        assertEquals("Good afternoon", Accents.greeting(16))
        assertEquals("Good evening", Accents.greeting(17))
        assertEquals("Good evening", Accents.greeting(21))
        assertEquals("Good night", Accents.greeting(22))
        // Every hour of the day must produce something.
        for (h in 0..23) assertTrue(Accents.greeting(h).startsWith("Good "))
    }
}
