package dev.shaurya.browser.modes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModesTest {

    @Test
    fun `every mode is complete and distinct`() {
        assertEquals("duplicate ids", Modes.ALL.size, Modes.ALL.map { it.id }.toSet().size)
        assertEquals("duplicate accents", Modes.ALL.size, Modes.ALL.map { it.accent }.toSet().size)
        for (m in Modes.ALL) {
            assertTrue("${m.id} has no name", m.name.isNotBlank())
            assertTrue("${m.id} has no tagline", m.tagline.isNotBlank())
            assertTrue("${m.id} claims nothing", m.changes.isNotEmpty())
            assertEquals("${m.id} accent is not opaque", 0xFF, (m.accent ushr 24) and 0xFF)
        }
    }

    @Test
    fun `an unknown or missing id falls back rather than throwing`() {
        // A mode removed in a later build must not brick a profile that
        // still has its id stored.
        assertEquals(Modes.DEFAULT, Modes.byId("deleted-long-ago"))
        assertEquals(Modes.DEFAULT, Modes.byId(null))
        assertEquals(Modes.DEFAULT, Modes.byId(""))
    }

    @Test
    fun `default changes nothing at all`() {
        val d = Modes.DEFAULT
        assertTrue(d.keepHistory)
        assertTrue(d.keepThumbnails)
        assertFalse(d.ignoreSiteExceptions)
        assertFalse(d.forceHttps)
        assertFalse(Modes.altersBehaviour(d))
    }

    @Test
    fun `ghost actually leaves nothing behind`() {
        val g = Modes.byId("ghost")
        assertFalse("ghost must not write history", g.keepHistory)
        assertFalse("a thumbnail is a picture of what was on screen", g.keepThumbnails)
        assertTrue(g.ignoreSiteExceptions)
        assertTrue(g.forceHttps)
        assertTrue(Modes.altersBehaviour(g))
    }

    @Test
    fun `only ghost claims to alter behaviour`() {
        // The honesty check. If another mode ever gains a real effect it must
        // also gain the wording, and this test forces that pairing.
        val altering = Modes.ALL.filter { Modes.altersBehaviour(it) }.map { it.id }
        assertEquals(listOf("ghost"), altering)
    }

    @Test
    fun `a mode that alters behaviour spells out each change`() {
        for (m in Modes.ALL.filter { Modes.altersBehaviour(it) }) {
            if (!m.keepHistory) assertTrue("${m.id}: history change unstated",
                m.changes.any { it.contains("history", true) })
            if (!m.keepThumbnails) assertTrue("${m.id}: thumbnail change unstated",
                m.changes.any { it.contains("thumbnail", true) })
            if (m.ignoreSiteExceptions) assertTrue("${m.id}: exception change unstated",
                m.changes.any { it.contains("exception", true) })
            if (m.forceHttps) assertTrue("${m.id}: HTTPS change unstated",
                m.changes.any { it.contains("HTTPS", true) })
        }
    }
}
