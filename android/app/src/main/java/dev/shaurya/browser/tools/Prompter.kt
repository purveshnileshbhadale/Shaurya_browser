package dev.shaurya.browser.tools

/**
 * Teleprompter arithmetic.
 *
 * The only genuinely tricky part of a prompter is the scroll rate, and it is
 * tricky because the honest unit is words per minute while the thing being
 * animated is pixels. Converting between them needs the laid-out height,
 * which only the UI knows — so the UI passes it in and this stays testable.
 */
object Prompter {

    /** A comfortable read-aloud pace. Slower than reading silently. */
    const val DEFAULT_WPM = 130

    fun words(script: String): Int = script.split(Regex("\\s+")).count { it.isNotBlank() }

    /** Seconds to speak the script at [wpm]. Zero for an empty script. */
    fun durationSeconds(script: String, wpm: Int = DEFAULT_WPM): Int {
        val count = words(script)
        if (count == 0 || wpm <= 0) return 0
        return ((count * 60.0) / wpm).toInt().coerceAtLeast(1)
    }

    /**
     * Pixels per second, given how tall the script laid out.
     *
     * [scrollablePixels] is the content height minus the viewport — the
     * distance there actually is to travel. A script that fits on screen has
     * nowhere to scroll, and returning zero for it is right: the alternative
     * is a prompter that jitters a stationary paragraph.
     */
    fun pixelsPerSecond(scrollablePixels: Int, script: String, wpm: Int = DEFAULT_WPM): Float {
        if (scrollablePixels <= 0) return 0f
        val seconds = durationSeconds(script, wpm)
        if (seconds <= 0) return 0f
        return scrollablePixels.toFloat() / seconds
    }

    /** "2:05" — how long this will take to say. */
    fun readingTime(script: String, wpm: Int = DEFAULT_WPM): String =
        FocusTimer.clock(durationSeconds(script, wpm))
}
