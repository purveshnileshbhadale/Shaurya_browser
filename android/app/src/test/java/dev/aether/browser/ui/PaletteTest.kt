package dev.aether.browser.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Tonal palette derivation.
 *
 * The properties tested here are the ones a broken palette breaks silently:
 * text that no longer contrasts with the surface it sits on, and a "themed"
 * app that quietly reverts to Material's default purple.
 */
class PaletteTest {

    // ---- parsing ---------------------------------------------------------

    @Test
    fun `parses six and eight digit hex, with or without a hash`() {
        assertEquals(0xFF6C8CFF.toInt(), Palette.parseHex("#6C8CFF"))
        assertEquals(0xFF6C8CFF.toInt(), Palette.parseHex("6c8cff"))
        assertEquals(0x806C8CFF.toInt(), Palette.parseHex("#806C8CFF"))
        assertEquals(0xFF6C8CFF.toInt(), Palette.parseHex("  #6C8CFF  "))
    }

    @Test
    fun `rejects anything that is not a hex colour`() {
        // Each of these would otherwise reach a colour parser that throws, or
        // worse, be silently mangled into a colour nobody chose.
        assertNull(Palette.parseHex(null))
        assertNull(Palette.parseHex(""))
        assertNull(Palette.parseHex("#abc"))
        assertNull(Palette.parseHex("rebeccapurple"))
        assertNull(Palette.parseHex("#gggggg"))
        assertNull(Palette.parseHex("#6C8CFF00FF"))
    }

    @Test
    fun `a malformed accent falls back to the brand colour, not to black`() {
        // Black would technically render; it would also silently discard the
        // user's theme and look deliberate.
        assertEquals(Palette.DEFAULT_ACCENT, Palette.seedOf("not a colour"))
        assertEquals(Palette.DEFAULT_ACCENT, Palette.seedOf(null))
    }

    // ---- the HSL round trip ---------------------------------------------

    @Test
    fun `hue and saturation survive a round trip through HSL`() {
        for (seed in listOf(0xFF6C8CFF, 0xFFE53935, 0xFF43A047, 0xFFFDD835, 0xFF00ACC1)) {
            val (hue, saturation) = Palette.hueAndSaturation(seed.toInt())
            val back = Palette.fromHsl(hue, saturation, lightnessOf(seed.toInt()))
            assertTrue(
                "round trip of ${hex(seed.toInt())} produced ${hex(back)}",
                channelsWithin(seed.toInt(), back, tolerance = 2),
            )
        }
    }

    @Test
    fun `grey has no hue to preserve and stays grey at every tone`() {
        val grey = 0xFF808080.toInt()
        for (t in listOf(10, 40, 90)) {
            val toned = Palette.tone(grey, t)
            val r = (toned shr 16) and 0xFF
            val g = (toned shr 8) and 0xFF
            val b = toned and 0xFF
            assertEquals("tone $t drifted off grey", r, g)
            assertEquals("tone $t drifted off grey", g, b)
        }
    }

    // ---- tonal ramp ------------------------------------------------------

    @Test
    fun `tones get monotonically lighter, at every chroma the theme uses`() {
        // A non-monotonic ramp would put surfaceContainerHigh *below*
        // surfaceContainer, inverting the depth cue that a dark theme uses
        // instead of borders.
        for (seed in listOf(0xFF6C8CFF, 0xFFFFEB3B, 0xFF7B1FA2)) {
            for (chroma in listOf(1f, 0.33f, 0.13f, 0.045f)) {
                val ramp = (0..100 step 5).map {
                    Palette.luminance(Palette.tone(seed.toInt(), it, chroma))
                }
                ramp.zipWithNext().forEach { (lower, higher) ->
                    assertTrue(
                        "${hex(seed.toInt())} at chroma $chroma: $lower then $higher",
                        higher > lower,
                    )
                }
            }
        }
    }

    @Test
    fun `tone 0 is black and tone 100 is white, whatever the seed`() {
        for (seed in listOf(0xFF6C8CFF, 0xFFE53935, 0xFF000000, 0xFFFFFFFF)) {
            assertEquals(0xFF000000.toInt(), Palette.tone(seed.toInt(), 0))
            assertEquals(0xFFFFFFFF.toInt(), Palette.tone(seed.toInt(), 100))
        }
    }

    @Test
    fun `tones outside the range are clamped rather than wrapping`() {
        val seed = 0xFF6C8CFF.toInt()
        assertEquals(Palette.tone(seed, 0), Palette.tone(seed, -20))
        assertEquals(Palette.tone(seed, 100), Palette.tone(seed, 320))
    }

    @Test
    fun `chroma scaling drains colour without moving the tone`() {
        val seed = 0xFFE53935.toInt()
        val full = Palette.tone(seed, 40, chromaScale = 1f)
        val neutral = Palette.tone(seed, 40, chromaScale = 0.045f)

        assertTrue("a neutral must be far less saturated than the accent",
            Palette.hueAndSaturation(neutral).second < Palette.hueAndSaturation(full).second)
        // Same tone means the same perceived lightness, which is what lets a
        // surface and an accent at the same tone be swapped without redoing
        // the contrast sums.
        assertTrue(
            "tone moved: ${Palette.lStar(full)} vs ${Palette.lStar(neutral)}",
            abs(Palette.lStar(full) - Palette.lStar(neutral)) < 1f,
        )
    }

    @Test
    fun `a tone number is CIE L-star, not HSL lightness`() {
        // The invariant the whole file exists to hold. Setting HSL lightness
        // to tone/100 is the obvious implementation, and it makes tone 40 a
        // different brightness at every hue — which is how white text ends up
        // on a yellow button at 2.2:1.
        for (seed in listOf(0xFF6C8CFF, 0xFFFFEB3B, 0xFF00ACC1, 0xFF7B1FA2, 0xFF808080)) {
            for (t in listOf(6, 10, 30, 40, 80, 90, 99)) {
                val measured = Palette.lStar(Palette.tone(seed.toInt(), t))
                assertTrue(
                    "seed ${hex(seed.toInt())}: asked for tone $t, got L* $measured",
                    abs(measured - t) < 1f,
                )
            }
        }
    }

    // ---- the properties the UI actually depends on -----------------------

    @Test
    fun `every Material on-colour pairing stays readable`() {
        // Material's tone pairs are supposed to guarantee contrast. This
        // asserts they still do after going through HSL rather than HCT,
        // which is the one place that substitution could have cost something
        // that matters.
        val pairs = listOf(40 to 100, 90 to 10, 80 to 20, 30 to 90, 99 to 10, 6 to 90)
        for (seed in listOf(0xFF6C8CFF, 0xFFE53935, 0xFFFDD835, 0xFF43A047, 0xFF7B1FA2)) {
            for ((background, foreground) in pairs) {
                val ratio = contrast(
                    Palette.tone(seed.toInt(), background),
                    Palette.tone(seed.toInt(), foreground),
                )
                assertTrue(
                    "seed ${hex(seed.toInt())}: tone $foreground on tone $background " +
                        "is only ${"%.2f".format(ratio)}:1",
                    ratio >= 4.5f,
                )
            }
        }
    }

    @Test
    fun `bright hues are the hard case and still pass`() {
        // Yellow, cyan and green are where HSL lightness diverges most from
        // perceived lightness. Before the solver, white on this yellow's tone
        // 40 measured 2.18:1 — text no one could read, on the palette a user
        // gets for picking a cheerful accent.
        for (seed in listOf(0xFFFFEB3B, 0xFF00ACC1, 0xFF43A047, 0xFFFDD835)) {
            assertTrue(
                "white on ${hex(seed.toInt())} tone 40",
                contrast(Palette.tone(seed.toInt(), 40), Palette.tone(seed.toInt(), 100)) >= 4.5f,
            )
            assertTrue(
                "${hex(seed.toInt())} tone 10 on tone 90",
                contrast(Palette.tone(seed.toInt(), 90), Palette.tone(seed.toInt(), 10)) >= 4.5f,
            )
        }
    }

    @Test
    fun `the tertiary hue is distinguishable from the accent`() {
        val seed = 0xFF6C8CFF.toInt()
        val tertiary = Palette.rotate(seed, 60f)
        val (seedHue, _) = Palette.hueAndSaturation(seed)
        val (tertiaryHue, _) = Palette.hueAndSaturation(tertiary)

        val separation = abs(((tertiaryHue - seedHue + 540f) % 360f) - 180f).let { 180f - it }
        assertTrue("the tertiary is $separation degrees from the accent", separation > 45f)
    }

    @Test
    fun `hue rotation wraps rather than clipping at 360`() {
        val nearWrap = Palette.fromHsl(350f, 0.8f, 0.5f)
        val rotated = Palette.rotate(nearWrap, 60f)
        val (hue, _) = Palette.hueAndSaturation(rotated)
        assertTrue("expected roughly 50 degrees, got $hue", hue < 90f)
    }

    @Test
    fun `system bar icons are chosen by luminance, not by the theme flag`() {
        // Edge-to-edge means our own surface shows through the status bar, so
        // this decides whether the clock is visible.
        assertTrue(Palette.isLight(0xFFFFFFFF.toInt()))
        assertTrue(!Palette.isLight(0xFF000000.toInt()))
        // Mid-green reads bright; a naive channel average would call it dark
        // and put white icons on it.
        assertTrue(Palette.isLight(0xFF00FF00.toInt()))
        assertTrue(!Palette.isLight(0xFF0000FF.toInt()))
    }

    // ---- helpers ---------------------------------------------------------

    private fun lightnessOf(argb: Int): Float {
        val r = ((argb shr 16) and 0xFF) / 255f
        val g = ((argb shr 8) and 0xFF) / 255f
        val b = (argb and 0xFF) / 255f
        return (maxOf(r, g, b) + minOf(r, g, b)) / 2f
    }

    private fun channelsWithin(a: Int, b: Int, tolerance: Int): Boolean =
        (0..2).all { i ->
            val shift = i * 8
            abs(((a shr shift) and 0xFF) - ((b shr shift) and 0xFF)) <= tolerance
        }

    /** WCAG contrast ratio between two opaque colours. */
    private fun contrast(a: Int, b: Int): Float {
        val la = Palette.luminance(a)
        val lb = Palette.luminance(b)
        return (maxOf(la, lb) + 0.05f) / (minOf(la, lb) + 0.05f)
    }

    private fun hex(argb: Int) = "#%08X".format(argb)
}
