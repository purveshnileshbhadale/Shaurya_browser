package dev.shaurya.browser.search

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ShauryaSearchTest {

    private fun known(url: String, title: String, visits: Int = 1, bookmarked: Boolean = false, age: Long = 0) =
        ShauryaSearch.Known(url, title, visits, System.currentTimeMillis() - age, bookmarked)

    private val library = listOf(
        known("https://kotlinlang.org/docs/home.html", "Kotlin Docs", visits = 9),
        known("https://en.wikipedia.org/wiki/Kotlin_(programming_language)", "Kotlin (programming language)", visits = 2),
        known("https://github.com/JetBrains/kotlin", "JetBrains/kotlin", visits = 3, bookmarked = true),
        known("https://example.com/unrelated", "Something else", visits = 40),
        known("https://blog.dev/why-i-left-scala", "Why I left Scala for kotlin", visits = 1),
    )

    @Test
    fun `a title prefix outranks a mention further in`() {
        val hits = ShauryaSearch.localMatches("kotlin", library)
        assertTrue(hits.isNotEmpty())
        assertEquals("Kotlin Docs", hits.first().title)
    }

    @Test
    fun `a bookmark outranks an equally-visited page`() {
        val pair = listOf(
            known("https://a.dev/x", "Widget guide", visits = 3),
            known("https://b.dev/x", "Widget guide", visits = 3, bookmarked = true),
        )
        assertEquals("https://b.dev/x", ShauryaSearch.localMatches("widget", pair).first().url)
    }

    @Test
    fun `an unrelated but heavily visited page is not dragged in`() {
        // Frecency must not override relevance, or the most-visited page in
        // the profile answers every query.
        val hits = ShauryaSearch.localMatches("kotlin", library)
        assertTrue(hits.none { it.title == "Something else" })
    }

    @Test
    fun `a url-only match still counts, below title matches`() {
        val hits = ShauryaSearch.localMatches("jetbrains", library)
        assertEquals(1, hits.size)
        assertEquals("https://github.com/JetBrains/kotlin", hits.first().url)
    }

    @Test
    fun `a one-character query matches nothing`() {
        // Otherwise the first keystroke floods the screen with every page
        // containing that letter.
        assertTrue(ShauryaSearch.localMatches("k", library).isEmpty())
        assertTrue(ShauryaSearch.localMatches("", library).isEmpty())
    }

    @Test
    fun `the preferred provider leads and the rest keep their order`() {
        val web = ShauryaSearch.webHandoffs("kotlin flows", "brave")
        assertEquals("brave", web.first().provider)
        val rest = web.drop(1).map { it.provider }
        assertEquals(listOf("duckduckgo", "startpage", "wikipedia", "google"), rest)
    }

    @Test
    fun `queries are encoded, so a query with spaces or symbols still works`() {
        val web = ShauryaSearch.webHandoffs("c++ & kotlin", "duckduckgo")
        val url = web.first().url
        assertTrue("unencoded query in $url", !url.contains(" "))
        assertTrue("unencoded ampersand would truncate the query: $url",
            !url.substringAfter("?q=").contains("&"))
    }

    @Test
    fun `a calculation produces an instant answer alongside web options`() {
        val r = ShauryaSearch.search("45 * 1.2", library, "duckduckgo")
        assertEquals("54", r.instant?.answer?.value)
        // The web hand-offs are still offered — the calculation might have
        // been a coincidence and the user may have meant to search.
        assertTrue(r.web.isNotEmpty())
    }

    @Test
    fun `an ordinary query has no instant answer`() {
        val r = ShauryaSearch.search("kotlin docs", library, "duckduckgo")
        assertEquals(null, r.instant)
        assertTrue(r.local.isNotEmpty())
    }

    @Test
    fun `a multi-word query matches a page containing all the words`() {
        // The whole-query-as-substring matcher failed this: no page is titled
        // literally "kotlin language", but one is about exactly that.
        val hits = ShauryaSearch.localMatches("kotlin language", library)
        assertEquals(1, hits.size)
        assertTrue(hits.first().title.contains("programming language"))
    }

    @Test
    fun `each extra word narrows the results`() {
        val broad = ShauryaSearch.localMatches("kotlin", library).size
        val narrow = ShauryaSearch.localMatches("kotlin jetbrains", library).size
        assertTrue("adding a word did not narrow: $broad then $narrow", narrow < broad)
    }

    @Test
    fun `a word that appears nowhere yields nothing`() {
        assertTrue(ShauryaSearch.localMatches("kotlin quantum", library).isEmpty())
    }
}
