package dev.aether.browser.ui

import kotlin.math.roundToLong

/**
 * The numbers on the new tab page.
 *
 * A shield count is only meaningful if a person can tell what it bought them,
 * which is why every browser that blocks things also shows a saving. The
 * hazard is that the saving is not measured — nobody downloads the ad to find
 * out how big it was — so it is an estimate dressed as a fact.
 *
 * This file keeps that honest in two ways. The blocked *count* is real: it is
 * incremented once per cancelled request. Everything derived from it is
 * labelled an estimate in the UI and carries its constant here in the open,
 * so the arithmetic can be argued with rather than believed.
 *
 * Pure Kotlin so it can be executed in a JVM unit test.
 */
object Stats {

    /**
     * Assumed weight of one blocked request, in bytes.
     *
     * The HTTP Archive's long-running page-weight report puts the median
     * third-party script near 30 KB and ad creatives well above that. 45 KB
     * is a deliberately middle figure: high enough not to undersell a
     * display-ad-heavy page, low enough that it is not flattering nonsense.
     *
     * If this ever needs to be defended precisely, the right fix is to record
     * `Content-Length` on the requests actually cancelled and stop estimating.
     */
    const val BYTES_PER_BLOCKED_REQUEST = 45_000L

    /** Estimated bytes not transferred, for a given number of blocks. */
    fun bytesSaved(blocked: Long): Long =
        if (blocked <= 0) 0 else blocked * BYTES_PER_BLOCKED_REQUEST

    /**
     * Human-readable byte size.
     *
     * Decimal units (kB = 1000), because that is what network transfer is
     * quoted in everywhere a person would compare this against — a data plan,
     * a speed test, a browser's own network panel.
     */
    fun formatBytes(bytes: Long): String {
        if (bytes < 1_000) return "$bytes B"
        val units = listOf("kB", "MB", "GB", "TB")
        var value = bytes.toDouble() / 1_000.0
        var unit = 0
        while (value >= 1_000.0 && unit < units.lastIndex) {
            value /= 1_000.0
            unit++
        }
        // One decimal below 10 so "1.4 MB" does not collapse to "1 MB", none
        // above it where the extra digit is noise at a glance.
        return if (value < 10) "${round1(value)} ${units[unit]}" else "${value.roundToLong()} ${units[unit]}"
    }

    /**
     * Compact count for a stat tile: 1200 -> "1.2K".
     *
     * The tile has room for about five characters. A blocked counter reaches
     * five figures within a week of ordinary use, and "18,432" in that space
     * either truncates or shrinks the type until it cannot be read across a
     * desk.
     */
    fun formatCount(n: Long): String = when {
        n < 1_000 -> n.toString()
        n < 1_000_000 -> {
            val k = n / 1_000.0
            if (k < 10) "${round1(k)}K" else "${k.roundToLong()}K"
        }
        else -> {
            val m = n / 1_000_000.0
            if (m < 10) "${round1(m)}M" else "${m.roundToLong()}M"
        }
    }

    /** One decimal place, with a trailing ".0" trimmed. */
    private fun round1(value: Double): String {
        val rounded = (value * 10).roundToLong() / 10.0
        return if (rounded == rounded.toLong().toDouble()) rounded.toLong().toString()
        else rounded.toString()
    }

    /**
     * The label under a site tile.
     *
     * A tile is about 64dp wide, so this has to be the shortest string that
     * still identifies the site: the registrable name without `www.` and
     * without the suffix. "theguardian" beats "www.theguardian.com" truncated
     * to "www.thegu…", which identifies nothing.
     */
    fun tileLabel(url: String): String {
        val host = url.substringAfter("://", url)
            .substringBefore('/')
            // A port is not part of the name. Without this, a dev server at
            // localhost:3000 labels its tile "localhost:30".
            .substringBefore(':')
            .removePrefix("www.")
        if (host.isBlank()) return url.take(12)
        val parts = host.split('.')
        val name = when {
            parts.size <= 1 -> parts[0]
            // co.uk, com.au and friends: the name is the third label from the
            // end, not the second.
            parts.size >= 3 && parts[parts.size - 2].length <= 3 && parts.last().length == 2 ->
                parts[parts.size - 3]
            else -> parts[parts.size - 2]
        }
        return name.take(12)
    }

    /** The single letter drawn in a site tile when there is no icon. */
    fun tileInitial(url: String): String =
        tileLabel(url).firstOrNull()?.uppercase() ?: "?"
}
