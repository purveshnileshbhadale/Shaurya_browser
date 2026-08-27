package dev.aether.browser.ui

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Tonal palettes, derived from a single seed colour.
 *
 * Material You generates a full scheme from one colour by building *tonal
 * palettes*: a ramp of the same hue at fixed lightness steps, from which every
 * role (primary, its container, the surfaces, the outlines) is drawn. Android
 * 12+ does this for us from the wallpaper; below that, and whenever the user
 * has picked their own accent, we have to build it ourselves.
 *
 * The alternative — the one the app shipped with — is
 * `lightColorScheme(primary = accent)`, which changes exactly one role and
 * leaves the other thirty at Material's default purple. Choosing an orange
 * accent then produced an orange button on a faintly purple surface, which
 * looks like a bug rather than a theme.
 *
 * ## What a tone number means
 *
 * A Material tone is **CIE L\***, perceived lightness — not the `L` of HSL.
 * The distinction is the whole ballgame. Picking the hue and setting HSL
 * lightness to `tone/100` is the obvious implementation and it is wrong: HSL
 * calls a saturated yellow at L=0.4 "mid", while the eye reads it as nearly
 * white. Tone 40 would then be a different brightness at every hue, and the
 * pairs Material guarantees would stop being readable — white on a yellow
 * tone-40 measures 2.2:1, well under the 4.5:1 that makes text legible.
 *
 * So [tone] solves for it instead: it binary-searches HSL lightness until the
 * result's measured L\* hits the requested tone. Perceived lightness rises
 * monotonically with HSL lightness at a fixed hue and saturation, so the
 * search always converges, and twenty iterations put it within a tenth of a
 * tone. Every Material pairing then clears 6:1 at every hue.
 *
 * This is still not full HCT: hue and chroma are HSL's, so two seeds at the
 * same nominal chroma are not equally colourful, and a tone unreachable at
 * high chroma is darkened towards it rather than having its chroma reduced.
 * Those affect how *vivid* the palette looks. Contrast — the part that
 * decides whether anyone can read the app — is exact.
 *
 * Everything here works in ARGB `Int`s rather than Compose `Color`s so that
 * it is plain arithmetic, unit-testable on the JVM without an emulator.
 */
object Palette {

    /** The seed used when a stored accent is missing or malformed. */
    const val DEFAULT_ACCENT = 0xFF6C8CFF.toInt()

    private const val BLACK = 0xFF000000.toInt()
    private const val WHITE = 0xFFFFFFFF.toInt()

    /**
     * Bisection steps for the tone solver.
     *
     * Twenty halvings of a unit interval land within a millionth, which is
     * far finer than the eight bits the answer is quantised to — the loop is
     * over long before the extra precision could matter, and twenty costs
     * about a microsecond.
     */
    private const val SOLVER_STEPS = 20

    /**
     * Parse `#rrggbb` or `#aarrggbb`.
     *
     * Deliberately its own parser rather than `android.graphics.Color`:
     * that one throws on bad input, is unavailable in JVM unit tests, and
     * accepts named colours we do not want to support.
     *
     * @return an ARGB int, or null if the input is not a hex colour
     */
    fun parseHex(hex: String?): Int? {
        val raw = hex?.trim()?.removePrefix("#") ?: return null
        if (raw.length != 6 && raw.length != 8) return null
        if (!raw.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null

        val value = raw.toLong(16)
        return if (raw.length == 6) (0xFF000000L or value).toInt() else value.toInt()
    }

    /** Parse, falling back to the brand accent rather than failing a render. */
    fun seedOf(hex: String?): Int = parseHex(hex) ?: DEFAULT_ACCENT

    /**
     * One step of a tonal palette.
     *
     * @param seed        the colour whose hue defines the palette
     * @param tone        0 (black) to 100 (white), as Material numbers them
     * @param chromaScale how much of the seed's saturation to keep — 1.0 for
     *                    the accent palette, near zero for the neutrals that
     *                    make up surfaces
     */
    fun tone(seed: Int, tone: Int, chromaScale: Float = 1f): Int {
        val target = tone.coerceIn(0, 100)
        if (target == 0) return BLACK
        if (target == 100) return WHITE

        val (hue, saturation) = hueAndSaturation(seed)
        // Saturation is capped below 1.0 because a fully saturated surface at
        // any tone is uncomfortable to look at for the length of time someone
        // spends in a browser.
        val s = (saturation * chromaScale).coerceIn(0f, 0.92f)

        // Binary search HSL lightness for the requested *perceived*
        // lightness. See the class comment: doing this directly, with
        // `lightness = tone / 100`, is the bug this exists to avoid.
        var low = 0f
        var high = 1f
        repeat(SOLVER_STEPS) {
            val mid = (low + high) / 2f
            if (lStar(fromHsl(hue, s, mid)) < target) low = mid else high = mid
        }
        return fromHsl(hue, s, (low + high) / 2f)
    }

    /**
     * CIE L\*: perceived lightness, 0 (black) to 100 (white).
     *
     * The piecewise definition is not an optimisation — the cube root alone
     * misbehaves near black, which is exactly the range the dark theme's
     * surfaces live in.
     */
    fun lStar(argb: Int): Float {
        val y = luminance(argb)
        return if (y > 0.008856f) {
            116f * Math.cbrt(y.toDouble()).toFloat() - 16f
        } else {
            903.3f * y
        }
    }

    /** Hue in degrees and saturation in 0..1, from an ARGB int. */
    fun hueAndSaturation(argb: Int): Pair<Float, Float> {
        val r = ((argb shr 16) and 0xFF) / 255f
        val g = ((argb shr 8) and 0xFF) / 255f
        val b = (argb and 0xFF) / 255f

        val max = maxOf(r, g, b)
        val min = minOf(r, g, b)
        val delta = max - min
        val lightness = (max + min) / 2f

        if (delta == 0f) return 0f to 0f // grey has no hue to preserve

        val saturation = delta / (1f - abs(2f * lightness - 1f)).coerceAtLeast(1e-6f)
        val hue = when (max) {
            r -> 60f * (((g - b) / delta) % 6f)
            g -> 60f * (((b - r) / delta) + 2f)
            else -> 60f * (((r - g) / delta) + 4f)
        }
        return ((hue + 360f) % 360f) to saturation.coerceIn(0f, 1f)
    }

    /** HSL back to an opaque ARGB int. */
    fun fromHsl(hue: Float, saturation: Float, lightness: Float): Int {
        val h = ((hue % 360f) + 360f) % 360f
        val s = saturation.coerceIn(0f, 1f)
        val l = lightness.coerceIn(0f, 1f)

        val c = (1f - abs(2f * l - 1f)) * s
        val x = c * (1f - abs((h / 60f) % 2f - 1f))
        val m = l - c / 2f

        val (r, g, b) = when {
            h < 60f -> Triple(c, x, 0f)
            h < 120f -> Triple(x, c, 0f)
            h < 180f -> Triple(0f, c, x)
            h < 240f -> Triple(0f, x, c)
            h < 300f -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }

        fun channel(v: Float) = ((v + m) * 255f).roundToInt().coerceIn(0, 255)
        return (0xFF shl 24) or (channel(r) shl 16) or (channel(g) shl 8) or channel(b)
    }

    /** Shift the seed's hue, for the tertiary palette. */
    fun rotate(seed: Int, degrees: Float): Int {
        val (hue, saturation) = hueAndSaturation(seed)
        return fromHsl(hue + degrees, saturation, 0.5f)
    }

    /**
     * WCAG relative luminance, 0 (black) to 1 (white).
     *
     * Used to decide whether the system bars need light or dark icons: a
     * translucent bar over a light surface with light icons is unreadable,
     * and edge-to-edge means our surface *is* what shows through.
     */
    fun luminance(argb: Int): Float {
        fun channel(shift: Int): Float {
            val v = ((argb shr shift) and 0xFF) / 255f
            return if (v <= 0.03928f) v / 12.92f else
                Math.pow(((v + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
        }
        return 0.2126f * channel(16) + 0.7152f * channel(8) + 0.0722f * channel(0)
    }

    /** Is this colour light enough to need dark icons drawn on it? */
    fun isLight(argb: Int): Boolean = luminance(argb) > 0.5f
}
