package dev.shaurya.browser.search

/**
 * Shaurya Search.
 *
 * An honest note on what this is, because the name could imply more than it
 * delivers: Shaurya has no web index of its own. Nobody builds one of those
 * as a feature. What it does have is the two things an external engine
 * structurally cannot do —
 *
 *  1. answer locally, with no query leaving the device at all, and
 *  2. search *your* pages: the history and bookmarks on this phone.
 *
 * — and it does both before anything is sent anywhere. Web results are then
 * a deliberate, labelled hand-off to the provider you chose in settings. The
 * screen says whose results they are; it never presents someone else's index
 * as ours.
 *
 * Everything here is a pure function of its inputs so the ranking can be
 * tested without a device.
 */
object ShauryaSearch {

    /** One thing worth offering for a query. */
    sealed interface Result {
        /** Computed on the device; no query left the phone. */
        data class Instant(val answer: dev.shaurya.browser.search.Instant.Answer) : Result

        /** A page already in this profile's history or bookmarks. */
        data class Local(
            val url: String,
            val title: String,
            val bookmarked: Boolean,
            val visits: Int,
        ) : Result

        /** A hand-off to an external engine. */
        data class Web(val provider: String, val label: String, val url: String) : Result
    }

    /** A page this profile already knows about. */
    data class Known(
        val url: String,
        val title: String,
        val visits: Int,
        val lastVisit: Long,
        val bookmarked: Boolean,
    )

    /** Everything worth showing for a query, in the order to show it. */
    data class Results(
        val instant: Result.Instant?,
        val local: List<Result.Local>,
        val web: List<Result.Web>,
    )

    /**
     * Rank the pages this profile already has against a query.
     *
     * A bookmark outranks a page merely visited the same number of times: one
     * was a deliberate act, the other might have been a mis-click. A title
     * match outranks a URL match, because someone searching "kotlin" means
     * the page about Kotlin, not every URL with the substring in it.
     */
    fun localMatches(query: String, known: List<Known>, limit: Int = 6): List<Result.Local> {
        val q = query.trim().lowercase()
        if (q.length < 2) return emptyList()
        // Tokenised, because people type phrases. Matching the whole query as
        // one substring means "kotlin coroutines" finds nothing even when the
        // page you want is called exactly that with a dash in between.
        val tokens = q.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return emptyList()

        return known.asSequence()
            .mapNotNull { entry ->
                val title = entry.title.lowercase()
                val url = entry.url.lowercase()
                // Every word has to appear somewhere, or a second word stops
                // narrowing anything and the query means less the more you
                // type — the opposite of what typing more should do.
                if (tokens.any { !title.contains(it) && !url.contains(it) }) return@mapNotNull null

                var score = 0
                when {
                    title.startsWith(tokens.first()) -> score += 100
                    title.contains(q) -> score += 80   // the whole phrase, in order
                }
                score += tokens.count { title.contains(it) } * 20
                score += tokens.count { url.contains(it) } * 8
                if (entry.bookmarked) score += 25
                score += minOf(entry.visits, 10) * 2
                score to entry
            }
            .sortedWith(compareByDescending<Pair<Int, Known>> { it.first }.thenByDescending { it.second.lastVisit })
            .take(limit)
            .map { (_, e) -> Result.Local(e.url, e.title, e.bookmarked, e.visits) }
            .toList()
    }

    /** The external engines a query can be handed to, in menu order. */
    fun webHandoffs(query: String, preferred: String): List<Result.Web> {
        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
        val all = listOf(
            Triple("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q=$encoded"),
            Triple("startpage", "Startpage", "https://www.startpage.com/sp/search?query=$encoded"),
            Triple("brave", "Brave Search", "https://search.brave.com/search?q=$encoded"),
            Triple("wikipedia", "Wikipedia", "https://en.wikipedia.org/w/index.php?search=$encoded"),
            Triple("google", "Google", "https://www.google.com/search?q=$encoded"),
        )
        // The preferred provider leads; the rest keep their order behind it,
        // so the list does not reshuffle under the user between searches.
        return all.sortedByDescending { it.first == preferred }
            .map { (id, label, url) -> Result.Web(id, label, url) }
    }

    fun search(
        query: String,
        known: List<Known>,
        preferredProvider: String,
    ): Results = Results(
        instant = Instant.answer(query)?.let { Result.Instant(it) },
        local = localMatches(query, known),
        web = webHandoffs(query, preferredProvider),
    )
}
