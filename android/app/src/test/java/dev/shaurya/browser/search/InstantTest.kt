package dev.shaurya.browser.search

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * Instant answers.
 *
 * Two kinds of failure matter here. Getting an answer wrong is obvious. The
 * subtler one is answering at all when the input was not a question — an
 * "answer" card above the results for a query like "9 to 5 jobs" makes the
 * whole feature look broken, so most of these assert silence.
 */
class InstantTest {

    private fun value(q: String) = Instant.answer(q)?.value

    // ---- arithmetic -------------------------------------------------------

    @Test
    fun `basic arithmetic`() {
        assertEquals("4", value("2+2"))
        assertEquals("6", value("2 * 3"))
        assertEquals("2.5", value("5/2"))
        assertEquals("54", value("45 * 1.2"))
        assertEquals("-3", value("2 - 5"))
    }

    @Test
    fun `precedence and brackets`() {
        assertEquals("14", value("2 + 3 * 4"))
        assertEquals("20", value("(2 + 3) * 4"))
        assertEquals("8", value("2 ^ 3"))
        // Right-associative, as in every language that has the operator.
        assertEquals("512", value("2 ^ 3 ^ 2"))
        assertEquals("1", value("10 % 3"))
    }

    @Test
    fun `unary minus`() {
        assertEquals("-4", value("-2 * 2"))
        assertEquals("6", value("-(2) * -3"))
    }

    @Test
    fun `floating point noise never reaches the screen`() {
        // The single most visible way a calculator looks amateur.
        assertEquals("0.3", value("0.1 + 0.2"))
        assertEquals("3", value("1.5 * 2"))
    }

    @Test
    fun `division by zero does not produce a card`() {
        assertNull(Instant.answer("1/0"))
        assertNull(Instant.answer("0/0"))
    }

    @Test
    fun `text that merely contains an operator is not a calculation`() {
        // Every one of these is a real thing to search for.
        assertNull(Instant.answer("rock + roll music"))
        assertNull(Instant.answer("c++ tutorial"))
        assertNull(Instant.answer("covid-19"))
        assertNull(Instant.answer("hello world"))
        assertNull(Instant.answer("2+"))
        assertNull(Instant.answer(""))
    }

    @Test
    fun `a bare number is not an answer`() {
        assertNull(Instant.answer("42"))
        assertNull(Instant.answer("2024"))
    }

    // ---- unit conversion --------------------------------------------------

    @Test
    fun `length converts both ways`() {
        assertEquals("8.04672 km", value("5 mi in km"))
        assertEquals("100 cm", value("1 m to cm"))
        assertEquals("12 inches", value("1 ft in inches"))
    }

    @Test
    fun `mass converts`() {
        assertEquals("2.204623 lb", value("1 kg in lb"))
        assertEquals("1000 g", value("1 kg to g"))
    }

    @Test
    fun `temperature respects the offset, not just a factor`() {
        // The case a naive "multiply by a factor" converter gets wrong.
        assertEquals("100 c", value("212 f in c"))
        assertEquals("0 c", value("32 f to c"))
        assertEquals("0 k", value("-273.15 c in k"))
    }

    @Test
    fun `decimal and binary data units stay distinct`() {
        // A browser that claims 1 MB is 1048576 bytes is wrong about every
        // download it reports.
        assertEquals("1000000 bytes", value("1 mb in bytes"))
        assertEquals("1048576 bytes", value("1 mib in bytes"))
    }

    @Test
    fun `time converts`() {
        assertEquals("90 min", value("1.5 h in min"))
        assertEquals("48 hours", value("2 days to hours"))
    }

    @Test
    fun `nonsense conversions are refused rather than answered`() {
        assertNull(Instant.answer("5 km in kg"))
        assertNull(Instant.answer("3 apples in oranges"))
        assertNull(Instant.answer("10 c in miles"))
    }

    @Test
    fun `a conversion-shaped phrase that is not one stays silent`() {
        assertNull(Instant.answer("how to in python"))
        assertNull(Instant.answer("best restaurants in london"))
    }

    // ---- bases ------------------------------------------------------------

    @Test
    fun `number bases`() {
        assertEquals("0xFF", value("255 in hex"))
        assertEquals("0b11111111", value("255 to binary"))
        assertEquals("255", value("0xff in decimal"))
        assertEquals("255", value("0b11111111 to dec"))
    }

    // ---- robustness -------------------------------------------------------

    @Test
    fun `hostile and malformed input never throws`() {
        val nasty = listOf(
            "((((((((((", "1/", "*", "^^^", "()", "1 + (2", "- -", ".",
            "0x", "0b2 in hex", "1e999999 * 2", "999999999999^999999",
            "1".repeat(500), "( ".repeat(200) + "1",
        )
        for (q in nasty) {
            // The contract is only that it returns; a null is a fine answer.
            Instant.answer(q)
        }
    }

    @Test
    fun `an overflowing result is not shown as a number`() {
        assertNull(Instant.answer("9^9^9"))
    }

    @Test
    fun `answers carry the working, not just the result`() {
        val a = Instant.answer("5 mi in km")
        assertNotNull(a)
        assertEquals("5 mi", a!!.detail)
    }
}
