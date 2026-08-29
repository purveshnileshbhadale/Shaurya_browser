package dev.aether.browser.adblock

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The bundled seed list, against the engine that will actually use it.
 *
 * The Kotlin matcher is a separate port from the desktop one, so "the seed
 * parses on desktop" proves nothing here. A seed that parsed to zero rules
 * would leave every fresh install unprotected while the log cheerfully
 * reported that it had loaded — which is the exact failure mode this whole
 * seed exists to prevent, reintroduced one layer down.
 *
 * Runs as a plain JVM test: `FilterEngine` has no Android dependencies, and
 * the asset is read from the source tree rather than through a `Context`.
 */
class SeedListTest {

    private val engine = FilterEngine().apply {
        // JVM unit tests run with the module directory as the working dir.
        addList(File("src/main/assets/filters/seed.txt").readText())
    }

    private val page = "https://news.example.org/article"

    private fun blocks(url: String, type: ResourceType = ResourceType.SCRIPT) =
        engine.match(url, page, type).block

    @Test
    fun `the seed parses into a usable number of rules`() {
        assertTrue(
            "only ${engine.networkRuleCount} rules parsed — the seed is not being understood",
            engine.networkRuleCount > 50,
        )
    }

    @Test
    fun `the largest ad and tracking endpoints are blocked`() {
        val mustBlock = listOf(
            "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
            "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
            "https://www.google-analytics.com/analytics.js",
            "https://connect.facebook.net/en_US/fbevents.js",
            "https://static.hotjar.com/c/hotjar-1.js",
            "https://cdn.taboola.com/libtrc/loader.js",
            "https://sb.scorecardresearch.com/beacon.js",
            "https://bat.bing.com/bat.js",
            "https://www.clarity.ms/tag/abc",
            "https://c.amazon-adsystem.com/aax2/apstag.js",
            "https://analytics.tiktok.com/i18n/pixel/events.js",
        )
        for (url in mustBlock) assertTrue("not blocked: $url", blocks(url))

        assertTrue(blocks("https://ib.adnxs.com/ttj?id=123", ResourceType.XHR))
    }

    @Test
    fun `ordinary page resources are left alone`() {
        // A seed shipped to every user with no way to review it first must be
        // far more afraid of false positives than of misses. A rule that
        // breaks a real site is worse than a tracker that gets through for
        // the few seconds before the real lists arrive.
        assertFalse(blocks("https://news.example.org/assets/app.js"))
        assertFalse(blocks("https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js"))
        assertFalse(blocks("https://news.example.org/images/header.png", ResourceType.IMAGE))
        assertFalse(blocks("https://fonts.googleapis.com/css2?family=Inter", ResourceType.STYLESHEET))
        assertFalse(blocks("https://news.example.org/api/comments", ResourceType.XHR))
    }

    @Test
    fun `visiting an ad company's own website still works`() {
        // Several seed rules name domains that are also a real company's
        // site. `BlockerService.intercept` exempts main-frame navigation, so
        // this is belt and braces — but the rules themselves should say what
        // they mean, and an unqualified `||criteo.com^` here means "nobody
        // can open criteo.com", which is not what a blocker is for.
        val mustLoad = listOf(
            "https://www.criteo.com/careers",
            "https://www.hotjar.com/pricing",
            "https://www.taboola.com/",
            "https://www.outbrain.com/",
            "https://amplitude.com/blog",
            "https://segment.com/docs/",
            "https://www.newrelic.com/pricing",
            "https://branch.io/about",
            // And the big products that merely share a domain with a pixel.
            "https://www.facebook.com/somepage",
            "https://www.amazon.com/dp/B0000",
            "https://www.google.com/search?q=test",
            "https://www.linkedin.com/feed/",
            "https://www.tiktok.com/@someone",
            "https://www.bing.com/search?q=test",
            "https://github.com/explore",
        )
        for (url in mustLoad) {
            assertFalse("navigating to $url was blocked", blocks(url, ResourceType.MAIN_FRAME))
        }
    }

    @Test
    fun `those same companies are still blocked as third-party beacons`() {
        // The other half of the scoping: `$third-party` must narrow where the
        // rule applies, not switch it off.
        assertTrue(blocks("https://static.hotjar.com/c/hotjar-1.js"))
        assertTrue(blocks("https://cdn.taboola.com/libtrc/loader.js"))
        assertTrue(blocks("https://static.criteo.net/js/ld/publishertag.js"))
    }
}
