package dev.shaurya.browser.tools

import dev.shaurya.browser.modes.ModeTools
import dev.shaurya.browser.modes.Modes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.GregorianCalendar

class CitationsTest {

    private fun source(url: String, title: String) =
        Citations.sourceFor(url, title, GregorianCalendar(2026, Calendar.MARCH, 9))

    @Test
    fun `the site is the host, without www or a port`() {
        assertEquals("theguardian.com", Citations.site("https://www.theguardian.com/uk/tech?x=1"))
        assertEquals("localhost", Citations.site("http://localhost:8080/page"))
        assertEquals("evil.com", Citations.site("http://user@evil.com/p"))
    }

    @Test
    fun `APA marks the missing date rather than inventing one`() {
        val text = Citations.format(source("https://a.com/p", "A Title"), Citations.Style.APA)
        // "n.d." is the standard marker, and the point of this tool: a
        // fabricated publication year would be handed in as fact.
        assertTrue(text, text.contains("(n.d.)"))
        assertTrue(text, text.contains("Retrieved March 9, 2026"))
        assertTrue(text, text.contains("https://a.com/p"))
    }

    @Test
    fun `MLA carries the access date and the container`() {
        val text = Citations.format(source("https://www.a.com/p", "A Title"), Citations.Style.MLA)
        assertTrue(text, text.startsWith("\"A Title.\" a.com,"))
        assertTrue(text, text.contains("Accessed 9 Mar. 2026."))
    }

    @Test
    fun `BibTeX keys off the site and year`() {
        val s = source("https://www.nature.com/articles/x", "Paper")
        assertEquals("nature2026", Citations.key(s))
        val text = Citations.format(s, Citations.Style.BIBTEX)
        assertTrue(text, text.startsWith("@misc{nature2026,"))
        assertTrue(text, text.contains("howpublished = {\\url{https://www.nature.com/articles/x}}"))
    }

    @Test
    fun `a blank title falls back to the URL rather than an empty quote`() {
        val text = Citations.format(source("https://a.com/p", "   "), Citations.Style.APA)
        assertTrue(text, text.startsWith("https://a.com/p."))
    }

    @Test
    fun `a URL with no recognisable host still produces a key`() {
        val s = Citations.sourceFor("not a url", "T", GregorianCalendar(2026, Calendar.JUNE, 1))
        assertEquals("page2026", Citations.key(s))
    }
}

class ReaderTest {

    @Test
    fun `sentences are grouped into paragraphs`() {
        val text = "One. Two. Three. Four. Five. Six."
        assertEquals(listOf("One. Two. Three.", "Four. Five. Six."), Reader.paragraphs(text))
    }

    @Test
    fun `an abbreviation does not end a sentence`() {
        // The bug this guards: "Dr." splitting a sentence in half, which turns
        // readable prose into a column of fragments.
        val text = "Dr. Smith arrived. He was late. It rained."
        assertEquals(listOf("Dr. Smith arrived. He was late. It rained."), Reader.paragraphs(text))
    }

    @Test
    fun `initials do not end a sentence`() {
        val text = "J. R. R. Tolkien wrote it. Nobody minded. It sold well."
        assertEquals(1, Reader.paragraphs(text).size)
    }

    @Test
    fun `whitespace is collapsed and empty input yields nothing`() {
        assertEquals(listOf("A b c."), Reader.paragraphs("  A\n\n  b\t c.  "))
        assertEquals(emptyList<String>(), Reader.paragraphs("   "))
    }

    @Test
    fun `a short extraction is reported as empty rather than shown`() {
        val thin = Reader.Article("T", "", listOf("Six words is not an article here."))
        assertTrue(Reader.looksEmpty(thin))

        val real = Reader.Article("T", "", List(20) { "This sentence has exactly six words." })
        assertFalse(real.words.toString(), Reader.looksEmpty(real))
    }

    @Test
    fun `reading time rounds up and is never zero for real text`() {
        assertEquals(0, Reader.readingMinutes(0))
        assertEquals(1, Reader.readingMinutes(1))
        assertEquals(1, Reader.readingMinutes(220))
        assertEquals(2, Reader.readingMinutes(221))
    }

    @Test
    fun `the injected script returns a value and touches nothing`() {
        // It runs inside someone else's page. Assigning to the DOM would mean
        // reader view could break the page it is reading.
        assertTrue(Reader.EXTRACT_JS.contains("JSON.stringify"))
        assertFalse(Reader.EXTRACT_JS.contains("document.write"))
        assertFalse(Reader.EXTRACT_JS.contains("innerHTML ="))
    }
}

class FocusTimerTest {

    private val plan = FocusTimer.Plan()

    @Test
    fun `a fresh timer is at the top of a work block`() {
        val state = FocusTimer.stateAt(0)
        assertEquals(FocusTimer.Phase.WORK, state.phase)
        assertEquals(25 * 60, state.remaining)
        assertEquals(0, state.completedBlocks)
    }

    @Test
    fun `the first break follows the first work block`() {
        val state = FocusTimer.stateAt(25 * 60L)
        assertEquals(FocusTimer.Phase.SHORT_BREAK, state.phase)
        assertEquals(5 * 60, state.remaining)
        assertEquals(1, state.completedBlocks)
    }

    @Test
    fun `the fourth break is the long one`() {
        // Three work blocks and three short breaks, then the fourth work
        // block, is 4*25 + 3*5 = 115 minutes.
        val state = FocusTimer.stateAt(115 * 60L)
        assertEquals(FocusTimer.Phase.LONG_BREAK, state.phase)
        assertEquals(15 * 60, state.remaining)
        assertEquals(4, state.completedBlocks)
    }

    @Test
    fun `the cycle repeats and blocks keep counting`() {
        val cycle = plan.cycleSeconds.toLong()
        assertEquals(130 * 60, plan.cycleSeconds)
        val state = FocusTimer.stateAt(cycle)
        assertEquals(FocusTimer.Phase.WORK, state.phase)
        assertEquals(25 * 60, state.remaining)
        // A second cycle starts having done four blocks, not zero: the count
        // is the session's, not the cycle's.
        assertEquals(4, state.completedBlocks)
    }

    @Test
    fun `negative elapsed time is treated as not started`() {
        // Clocks move backwards — an NTP correction is enough.
        val state = FocusTimer.stateAt(-500)
        assertEquals(FocusTimer.Phase.WORK, state.phase)
        assertEquals(25 * 60, state.remaining)
    }

    @Test
    fun `every second of a cycle lands in some phase`() {
        // The walk-the-cycle implementation ends in error() if it falls
        // through, so this also proves it never does.
        for (t in 0 until plan.cycleSeconds step 37) {
            assertNotNull(FocusTimer.stateAt(t.toLong()))
        }
    }

    @Test
    fun `the clock pads seconds`() {
        assertEquals("0:00", FocusTimer.clock(0))
        assertEquals("0:09", FocusTimer.clock(9))
        assertEquals("1:05", FocusTimer.clock(65))
        assertEquals("25:00", FocusTimer.clock(1500))
        assertEquals("0:00", FocusTimer.clock(-5))
    }
}

class PrompterTest {

    @Test
    fun `words ignore runs of whitespace`() {
        assertEquals(0, Prompter.words("   "))
        assertEquals(3, Prompter.words("  one\n\ntwo\t three "))
    }

    @Test
    fun `duration follows the pace`() {
        val script = List(130) { "word" }.joinToString(" ")
        assertEquals(60, Prompter.durationSeconds(script, 130))
        assertEquals(30, Prompter.durationSeconds(script, 260))
        assertEquals(0, Prompter.durationSeconds("", 130))
    }

    @Test
    fun `a script that fits on screen does not scroll`() {
        // Returning a rate here would jitter a stationary paragraph.
        assertEquals(0f, Prompter.pixelsPerSecond(0, "some words here"), 0f)
        assertEquals(0f, Prompter.pixelsPerSecond(-40, "some words here"), 0f)
    }

    @Test
    fun `the rate covers the scrollable distance in the reading time`() {
        val script = List(130) { "word" }.joinToString(" ")
        // 60 seconds of script over 600 scrollable pixels.
        assertEquals(10f, Prompter.pixelsPerSecond(600, script, 130), 0.01f)
    }

    @Test
    fun `an empty script has no rate and no time`() {
        assertEquals(0f, Prompter.pixelsPerSecond(600, "   "), 0f)
        assertEquals("0:00", Prompter.readingTime(""))
    }
}

class JsonTest {

    private fun ok(input: String): Json.Result.Ok =
        Json.format(input) as Json.Result.Ok

    private fun err(input: String): Json.Result.Error =
        Json.format(input) as Json.Result.Error

    @Test
    fun `an object is indented and minified`() {
        val r = ok("""{"b":1,"a":[1,2]}""")
        assertEquals("{\n  \"b\": 1,\n  \"a\": [\n    1,\n    2\n  ]\n}", r.pretty)
        assertEquals("""{"b":1,"a":[1,2]}""", r.minified)
    }

    @Test
    fun `key order is preserved`() {
        // Sorting keys would silently reorder a config file someone is about
        // to paste back.
        assertEquals("""{"z":1,"a":2,"m":3}""", ok("""{"z":1,"a":2,"m":3}""").minified)
    }

    @Test
    fun `empty containers stay on one line`() {
        assertEquals("""{"a":{},"b":[]}""", ok("""{"a":{},"b":[]}""").minified)
        assertEquals("{\n  \"a\": {},\n  \"b\": []\n}", ok("""{"a":{},"b":[]}""").pretty)
    }

    @Test
    fun `numbers keep the form they were written in`() {
        // Round-tripping through a Double would turn 1.0 into 1 and lose
        // precision on a long integer id.
        assertEquals("""[1.0,-2,3e5,1.5E-3,12345678901234567890]""",
            ok("""[1.0, -2, 3e5, 1.5E-3, 12345678901234567890]""").minified)
    }

    @Test
    fun `escapes survive the round trip`() {
        val r = ok("""{"a":"line\nbreak \" \\ é"}""")
        assertEquals("""{"a":"line\nbreak \" \\ é"}""", r.minified)
    }

    @Test
    fun `a missing brace is reported at its line and column`() {
        val e = err("{\n  \"a\": 1,\n  \"b\": 2\n")
        assertEquals(4, e.line)
        assertTrue(e.message, e.message.contains("','"))
    }

    @Test
    fun `a trailing comma is rejected where it appears`() {
        val e = err("""{"a":1,}""")
        assertEquals(1, e.line)
        assertEquals(8, e.column)
    }

    @Test
    fun `an unescaped newline in a string is named`() {
        val e = err("{\"a\":\"one\ntwo\"}")
        assertTrue(e.message, e.message.contains("control character"))
    }

    @Test
    fun `trailing content after a complete value is an error`() {
        // "{} {}" parses as a valid object followed by junk; accepting it
        // would silently drop half the input.
        val e = err("{} {}")
        assertTrue(e.message, e.message.contains("trailing"))
    }

    @Test
    fun `bare literals and empty input`() {
        assertEquals("true", ok("true").minified)
        assertEquals("null", ok(" null ").minified)
        assertTrue(Json.format("") is Json.Result.Error)
    }
}

class ModeToolsTest {

    @Test
    fun `every mode has tools, and every id resolves`() {
        for (mode in Modes.ALL) {
            val tools = ModeTools.toolsFor(mode.id)
            assertTrue(mode.id, tools.isNotEmpty())
            tools.forEach { assertNotNull(it.id, ModeTools.byId(it.id)) }
        }
    }

    @Test
    fun `reader is on every mode`() {
        // Gating the most useful thing a browser can do to a bad page behind
        // a mode would make the browser worse by default.
        for (mode in Modes.ALL) {
            assertTrue(mode.id, ModeTools.toolsFor(mode.id).any { it.id == "reader" })
        }
    }

    @Test
    fun `an unknown mode falls back rather than coming back empty`() {
        assertEquals(ModeTools.toolsFor("default"), ModeTools.toolsFor("a-mode-from-2019"))
    }

    @Test
    fun `each mode's tools are distinct`() {
        for (mode in Modes.ALL) {
            val ids = ModeTools.toolsFor(mode.id).map { it.id }
            assertEquals(mode.id, ids.size, ids.distinct().size)
        }
    }

    @Test
    fun `Ghost carries the destructive tools and nothing else does`() {
        val destructive = setOf("shredder", "panic")
        for (mode in Modes.ALL) {
            val has = ModeTools.toolsFor(mode.id).map { it.id }.any { it in destructive }
            assertEquals(mode.id, mode.id == "ghost", has)
        }
    }

    @Test
    fun `every missing feature carries a reason`() {
        // A list of absent features without reasons reads as a roadmap; with
        // them it reads as a boundary, which is what it is.
        for (mode in Modes.ALL) {
            ModeTools.unavailableFor(mode.id).forEach { missing ->
                assertTrue(missing.name, missing.reason.isNotBlank())
                assertTrue(missing.name, missing.name.isNotBlank())
            }
        }
    }

    @Test
    fun `Default promises nothing extra, so it is missing nothing`() {
        assertEquals(emptyList<Any>(), ModeTools.unavailableFor("default"))
    }
}
