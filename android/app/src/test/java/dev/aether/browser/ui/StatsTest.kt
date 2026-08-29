package dev.aether.browser.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The new tab page's numbers.
 *
 * Formatting bugs here are the embarrassing kind — a stat tile reading
 * "0.30000000000000004 MB", or a label that truncates every site to "www.".
 */
class StatsTest {

    @Test
    fun `byte sizes read the way a data plan is quoted`() {
        assertEquals("0 B", Stats.formatBytes(0))
        assertEquals("999 B", Stats.formatBytes(999))
        assertEquals("1 kB", Stats.formatBytes(1_000))
        assertEquals("1.5 kB", Stats.formatBytes(1_500))
        assertEquals("45 kB", Stats.formatBytes(45_000))
        assertEquals("1.4 MB", Stats.formatBytes(1_350_000))
        assertEquals("2.3 GB", Stats.formatBytes(2_250_000_000))
    }

    @Test
    fun `a decimal only appears where it carries information`() {
        // Below ten a tenth is a fifth of the value; above it, it is noise in
        // a space five characters wide.
        assertEquals("9.9 MB", Stats.formatBytes(9_900_000))
        assertEquals("45 MB", Stats.formatBytes(45_000_000))
        // And a whole number never shows a pointless ".0".
        assertEquals("2 MB", Stats.formatBytes(2_000_000))
    }

    @Test
    fun `counts stay inside a stat tile`() {
        assertEquals("0", Stats.formatCount(0))
        assertEquals("999", Stats.formatCount(999))
        assertEquals("1K", Stats.formatCount(1_000))
        assertEquals("1.2K", Stats.formatCount(1_200))
        assertEquals("18K", Stats.formatCount(18_432))
        assertEquals("1.5M", Stats.formatCount(1_500_000))
        for (n in listOf(0L, 999L, 1_000L, 18_432L, 4_500_000L)) {
            assertTrue("'${Stats.formatCount(n)}' is too wide for a tile",
                Stats.formatCount(n).length <= 5)
        }
    }

    @Test
    fun `nothing blocked saves nothing`() {
        // Guards against a friendly-looking "45 kB saved" on a fresh install
        // that has blocked nothing at all.
        assertEquals(0L, Stats.bytesSaved(0))
        assertEquals(0L, Stats.bytesSaved(-3))
        assertEquals("0 B", Stats.formatBytes(Stats.bytesSaved(0)))
    }

    @Test
    fun `the saving is the count times the documented constant`() {
        // Stated as a test so the estimate cannot drift into the UI without
        // someone changing a number that is written down.
        assertEquals(45_000L, Stats.bytesSaved(1))
        assertEquals(100 * Stats.BYTES_PER_BLOCKED_REQUEST, Stats.bytesSaved(100))
    }

    @Test
    fun `a tile label identifies the site`() {
        assertEquals("github", Stats.tileLabel("https://github.com/explore"))
        assertEquals("theguardian", Stats.tileLabel("https://www.theguardian.com/uk"))
        assertEquals("wikipedia", Stats.tileLabel("https://en.wikipedia.org/wiki/Kotlin"))
        // Two-level public suffixes: the name is a label further left.
        assertEquals("bbc", Stats.tileLabel("https://www.bbc.co.uk/news"))
        assertEquals("abc", Stats.tileLabel("https://shop.abc.com.au/"))
        // Never longer than the tile can draw.
        assertTrue(Stats.tileLabel("https://averyveryverylongdomainname.com/").length <= 12)
    }

    @Test
    fun `odd inputs produce something rather than crashing`() {
        assertEquals("localhost", Stats.tileLabel("http://localhost:3000/"))
        assertEquals("?", Stats.tileInitial(""))
        assertEquals("G", Stats.tileInitial("https://github.com"))
    }
}
