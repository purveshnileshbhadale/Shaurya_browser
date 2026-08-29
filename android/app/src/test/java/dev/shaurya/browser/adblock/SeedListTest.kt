package dev.shaurya.browser.adblock

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

    private val engine = FilterEngine().apply { addList(seedText()) }

    /**
     * Read the bundled seed from the source tree.
     *
     * A JVM unit test has no `Context`, so the asset is read as a file — and
     * Gradle does not promise which directory the test runs in (I assumed the
     * module directory and CI proved otherwise). So try the sensible
     * candidates, and if none match, say which were tried rather than failing
     * with a bare FileNotFoundException.
     */
    private fun seedText(): String {
        val relative = "src/main/assets/filters/seed.txt"
        val candidates = listOf(
            File(relative),                       // working dir = app/
            File("app/$relative"),                // working dir = android/
            File("android/app/$relative"),        // working dir = repo root
        )
        candidates.firstOrNull { it.isFile }?.let { return it.readText() }

        // Last resort: walk up from wherever we are and look for it.
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val found = File(dir, "app/$relative").takeIf { it.isFile }
                ?: File(dir, relative).takeIf { it.isFile }
            if (found != null) return found.readText()
            dir = dir.parentFile
        }

        throw AssertionError(
            "could not find the seed list. Working directory is "
                + File(".").absolutePath + "; tried "
                + candidates.joinToString { it.path }
        )
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
    fun `an ad company's own site loads its own resources`() {
        // Several seed rules name domains that are also a real company's
        // website. Once you are *on* that site its own requests are
        // first-party, so the third-party scoping must let them through —
        // otherwise the seed would render those sites unusable.
        //
        // Note what this deliberately does not test: whether *navigating* to
        // one is blocked. Both blockers exempt main-frame navigation before
        // the engine is consulted at all (`request.isForMainFrame` here,
        // `resourceType === 'mainFrame'` on desktop), so the engine is never
        // asked. Asking it anyway — with some other site as the page URL, as
        // an earlier version of this test did — models a request that cannot
        // occur, and fails for a reason that says nothing about the product.
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
            // The site as its own page URL: what a first-party request from
            // that page actually looks like.
            assertFalse(
                "$url was blocked while browsing that very site",
                engine.match(url, url, ResourceType.SCRIPT).block,
            )
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
