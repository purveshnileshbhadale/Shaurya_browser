package dev.shaurya.browser.ui

/**
 * Per-site colour and the time-aware greeting.
 *
 * The start page draws each frequent site as a coloured disc rather than a
 * grey square. The colour has to be *derived* from the site, not assigned by
 * position: a tile that changes hue when the ranking reshuffles is worse than
 * no colour at all, because the colour stops being a way to recognise the
 * site and starts being noise.
 *
 * Pure Kotlin, so every claim below is exercised by a JVM test.
 */
object Accents {

    /**
     * A stable hue in [0, 360) for a URL.
     *
     * FNV-1a over the registrable name — not the full URL, so every page on a
     * site shares its colour, and not `hashCode()`, whose value is not
     * guaranteed stable across JVM versions and which clusters badly for
     * short lowercase strings.
     */
    fun hueFor(url: String): Float {
        val name = Stats.tileLabel(url).lowercase()
        var hash = 0x811C9DC5u
        for (ch in name) {
            hash = hash xor ch.code.toUInt()
            hash *= 0x01000193u
        }
        return (hash % 360u).toFloat()
    }

    /**
     * Start and end colours for a site tile's gradient, as ARGB ints.
     *
     * Saturation and lightness are fixed so that every tile carries the same
     * visual weight and white initials stay readable on all of them; only the
     * hue varies. Letting all three vary is how a colourful grid turns into a
     * grid where three tiles are unreadable.
     */
    fun tileColors(url: String): Pair<Int, Int> {
        val seed = Palette.fromHsl(hueFor(url), 0.70f, 0.5f)
        return Palette.tone(seed, TILE_TOP) to Palette.tone(seed, TILE_BOTTOM)
    }

    /** A single flat colour for the small favicon discs in a list. */
    fun listColor(url: String): Int =
        Palette.tone(Palette.fromHsl(hueFor(url), 0.70f, 0.5f), TILE_BOTTOM + 6)

    /**
     * Tile tones, as CIE L\* rather than HSL lightness.
     *
     * This is the same trap as the palette: fixing HSL lightness at 0.55
     * makes a yellow-green tile perceptually near-white while a blue one
     * stays dark, so white initials disappear on some sites and not others.
     * A tone is perceived lightness, so tone 48 is equally dark at every hue
     * and the initials clear 4.5:1 all the way round the wheel.
     */
    private const val TILE_TOP = 48
    private const val TILE_BOTTOM = 34

    /**
     * The greeting, by hour of day.
     *
     * Boundaries chosen so nothing reads as wrong to someone glancing at it:
     * "evening" starts at 17:00 rather than 18:00 because a browser opened at
     * half five is not being opened in the afternoon, and "night" exists so a
     * 2am tab does not say "Good morning".
     */
    fun greeting(hour: Int): String = when (hour) {
        in 5..11 -> "Good morning"
        in 12..16 -> "Good afternoon"
        in 17..21 -> "Good evening"
        else -> "Good night"
    }
}
