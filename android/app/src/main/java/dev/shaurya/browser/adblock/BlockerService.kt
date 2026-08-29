package dev.shaurya.browser.adblock

import android.content.Context
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Filter list management and the WebView request hook.
 *
 * Blocking is done in `shouldInterceptRequest`, which is WebView's equivalent
 * of the desktop's `onBeforeRequest`: returning a response here means the
 * network request is never made. Returning an *empty* response rather than
 * null is what actually cancels it — null means "carry on and fetch it".
 */
class BlockerService(private val context: Context) {

    /**
     * The live index.
     *
     * `@Volatile` and replaced wholesale rather than mutated: `intercept`
     * runs on WebView's IO thread for every subresource, so a rebuild that
     * cleared this one in place would leave a window — hundreds of
     * milliseconds, with a hundred thousand rules to parse — in which every
     * request on every tab sailed through an empty index.
     */
    @Volatile
    var engine = FilterEngine()
        private set

    /** True while the only rules loaded are the ones bundled with the app. */
    @Volatile
    var usingSeed: Boolean = false
        private set

    /** Per-tab blocked counts, for the shield badge. */
    private val counts = HashMap<Long, Int>()

    /**
     * Blocks not yet added to the lifetime total on disk.
     *
     * Accumulated here and drained by the caller at page-load boundaries. A
     * file write per blocked request would put disk IO on the hot path of
     * every subresource on an ad-heavy page, for a number nobody reads more
     * than once a session.
     */
    private val pendingTotal = java.util.concurrent.atomic.AtomicLong(0)

    /** Take the blocks accumulated since the last call, and reset. */
    fun drainBlockedTotal(): Long = pendingTotal.getAndSet(0)

    @Volatile
    var enabled: Boolean = true

    @Volatile
    var ready: Boolean = false
        private set

    /** Hosts the user turned blocking off for. */
    private val siteExceptions = HashSet<String>()

    /**
     * Called whenever the index is replaced.
     *
     * The UI needs to know when protection goes from "seed only" to real
     * lists, and that transition happens on a background thread minutes
     * after launch — too late for anything that read the flag once at
     * startup.
     */
    var onIndexChanged: (() -> Unit)? = null

    private val cacheDir: File
        get() = File(context.filesDir, "filters").apply { mkdirs() }

    /**
     * Load cached lists, then refresh from the network if they are stale.
     *
     * Cached lists load first so protection is active within milliseconds of
     * launch rather than after a download.
     */
    suspend fun initialise() = withContext(Dispatchers.IO) {
        rebuild()
        ready = true

        val newest = DEFAULT_LISTS.maxOfOrNull { File(cacheDir, "${it.id}.txt").lastModified() } ?: 0
        val stale = System.currentTimeMillis() - newest > UPDATE_INTERVAL_MS

        // Refresh when the lists are stale *or* when nothing has ever
        // downloaded. Without the second condition a first launch with no
        // signal — a phone on the underground, a captive wifi portal —
        // leaves the browser running on the seed for the whole session with
        // no further attempt.
        if (stale || usingSeed) retryUntilFetched()
    }

    /**
     * Keep trying to acquire the lists, backing off as it fails.
     *
     * A browser is opened far more often than it is left running, and the
     * failure that matters is the launch where the network was not up yet.
     * Waiting for the next twelve-hourly tick means a whole session
     * unprotected; a handful of retries costs nothing and usually succeeds
     * on the second.
     */
    private suspend fun retryUntilFetched() {
        var delayMs = RETRY_BASE_MS
        repeat(RETRY_ATTEMPTS) { attempt ->
            if (updateLists() > 0) return
            if (attempt == RETRY_ATTEMPTS - 1) return
            Log.i(TAG, "no list downloaded; retrying in ${delayMs / 1000}s")
            kotlinx.coroutines.delay(delayMs)
            delayMs = (delayMs * 2).coerceAtMost(RETRY_MAX_MS)
        }
    }

    /**
     * Download each list, trying mirrors in order.
     *
     * Filter-list hosts are blocked on plenty of mobile networks, so a
     * single-URL fetcher would silently leave a user unprotected.
     */
    suspend fun updateLists(): Int = withContext(Dispatchers.IO) {
        var updated = 0
        for (list in DEFAULT_LISTS) {
            if (!list.enabledByDefault) continue
            for (url in list.urls) {
                val body = runCatching { download(url) }.getOrNull() ?: continue
                if (!looksLikeFilterList(body)) continue
                File(cacheDir, "${list.id}.txt").writeText(body)
                updated++
                Log.i(TAG, "fetched ${list.id} from ${URL(url).host}")
                break
            }
        }
        if (updated > 0) rebuild()
        updated
    }


    private fun rebuild() {
        val next = FilterEngine()
        var loaded = 0
        for (list in DEFAULT_LISTS) {
            val file = File(cacheDir, "${list.id}.txt")
            if (!file.exists()) continue
            runCatching { next.addList(file.readText()) }
                .onSuccess { loaded++ }
                .onFailure { Log.w(TAG, "could not parse ${list.id}: ${it.message}") }
        }

        // Nothing cached: a fresh install, or one that has never had a
        // network. The bundled seed keeps the largest trackers blocked
        // instead of leaving the browser wide open while it looks fine.
        val seeded = loaded == 0
        if (seeded) {
            runCatching { next.addList(context.assets.open(SEED_ASSET).bufferedReader().readText()) }
                .onFailure { Log.e(TAG, "bundled seed list unreadable: ${it.message}") }
        }

        usingSeed = seeded
        engine = next
        onIndexChanged?.invoke()
        Log.i(
            TAG,
            "index rebuilt from $loaded list(s): ${next.networkRuleCount} rules"
                + if (seeded) " (bundled seed only)" else ""
        )
    }

    private fun download(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            setRequestProperty("User-Agent", "Shaurya-Android/1.0")
        }
        try {
            if (connection.responseCode != 200) error("HTTP ${connection.responseCode}")
            return connection.inputStream.bufferedReader().readText()
        } finally {
            connection.disconnect()
        }
    }

    private fun looksLikeFilterList(text: String): Boolean {
        if (text.length < 256) return false
        if (text.trimStart().startsWith("<")) return false
        return text.lineSequence().take(400).count {
            it.startsWith("||") || it.startsWith("@@") || it.startsWith("##") || it.startsWith("!")
        } >= 20
    }

    // -----------------------------------------------------------------------
    // Request interception
    // -----------------------------------------------------------------------

    /**
     * @return an empty response to block, or null to let the request proceed
     */
    fun intercept(request: WebResourceRequest, pageUrl: String?, tabId: Long): WebResourceResponse? {
        if (!enabled || !ready) return null
        if (request.isForMainFrame) return null // never block the document itself

        val url = request.url.toString()
        if (!url.startsWith("http")) return null

        val host = FilterEngine.hostOf(pageUrl?.lowercase() ?: "")
        if (host != null && FilterEngine.baseDomain(host) in siteExceptions) return null

        val verdict = engine.match(url, pageUrl, resourceTypeOf(request))
        if (!verdict.block) return null

        synchronized(counts) { counts[tabId] = (counts[tabId] ?: 0) + 1 }
        pendingTotal.incrementAndGet()

        // An empty 200 rather than an error: some sites break visibly on a
        // failed request but tolerate an empty one, and this is what desktop
        // blockers do too.
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }

    /**
     * Infer a resource type from the request.
     *
     * WebView gives no explicit type, so this comes from the `Accept` header
     * first (which the engine matches on) and the file extension second.
     */
    private fun resourceTypeOf(request: WebResourceRequest): ResourceType {
        if (request.isForMainFrame) return ResourceType.MAIN_FRAME

        val accept = request.requestHeaders["Accept"].orEmpty().lowercase()
        when {
            accept.contains("text/css") -> return ResourceType.STYLESHEET
            accept.contains("image/") -> return ResourceType.IMAGE
            accept.contains("text/html") -> return ResourceType.SUB_FRAME
            accept.contains("javascript") -> return ResourceType.SCRIPT
        }

        val path = request.url.path.orEmpty().lowercase()
        return when {
            path.endsWith(".js") || path.endsWith(".mjs") -> ResourceType.SCRIPT
            path.endsWith(".css") -> ResourceType.STYLESHEET
            path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") ||
                path.endsWith(".gif") || path.endsWith(".webp") || path.endsWith(".svg") ||
                path.endsWith(".ico") -> ResourceType.IMAGE
            path.endsWith(".woff") || path.endsWith(".woff2") || path.endsWith(".ttf") ->
                ResourceType.FONT
            path.endsWith(".mp4") || path.endsWith(".webm") || path.endsWith(".m3u8") ->
                ResourceType.MEDIA
            // XHR is the common case for anything without a file extension.
            path.substringAfterLast('/').contains('.').not() -> ResourceType.XHR
            else -> ResourceType.OTHER
        }
    }

    // -----------------------------------------------------------------------
    // Per-site policy and stats
    // -----------------------------------------------------------------------

    fun blockedCount(tabId: Long): Int = synchronized(counts) { counts[tabId] ?: 0 }

    fun resetCount(tabId: Long) {
        synchronized(counts) { counts.remove(tabId) }
    }

    fun isAllowed(host: String): Boolean = FilterEngine.baseDomain(host) in siteExceptions

    /** Every site the user has turned protection off for. */
    fun exceptions(): Set<String> = synchronized(siteExceptions) { siteExceptions.toSet() }

    /** Restore exceptions saved from a previous run. */
    fun restoreExceptions(hosts: Collection<String>) {
        synchronized(siteExceptions) {
            siteExceptions.clear()
            siteExceptions.addAll(hosts)
        }
    }

    fun setSiteEnabled(host: String, blockingEnabled: Boolean) {
        val key = FilterEngine.baseDomain(host)
        if (blockingEnabled) siteExceptions.remove(key) else siteExceptions.add(key)
    }

    data class ListSpec(
        val id: String,
        val name: String,
        val urls: List<String>,
        val enabledByDefault: Boolean = true,
    )

    companion object {
        private const val TAG = "ShauryaBlocker"
        private const val UPDATE_INTERVAL_MS = 12L * 60 * 60 * 1000

        /** Bundled starter rules, for before anything has downloaded. */
        private const val SEED_ASSET = "filters/seed.txt"

        /**
         * In-session retries after a failed download.
         *
         * Four attempts over roughly two minutes: long enough to cover a
         * phone that has not finished associating with wifi, short enough
         * that it is over before anyone has finished reading a page, and
         * bounded so a genuinely offline device stops burning radio.
         */
        private const val RETRY_ATTEMPTS = 4
        private const val RETRY_BASE_MS = 15_000L
        private const val RETRY_MAX_MS = 60_000L

        /**
         * The same subscriptions the desktop build uses, each with mirrors.
         */
        val DEFAULT_LISTS = listOf(
            ListSpec(
                "easylist", "EasyList",
                listOf(
                    "https://easylist.to/easylist/easylist.txt",
                    "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/easylist.txt",
                )
            ),
            ListSpec(
                "easyprivacy", "EasyPrivacy",
                listOf(
                    "https://easylist.to/easylist/easyprivacy.txt",
                    "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/thirdparties/easyprivacy.txt",
                )
            ),
            ListSpec(
                "ublock-filters", "uBlock filters",
                listOf(
                    "https://ublockorigin.github.io/uAssets/filters/filters.txt",
                    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
                )
            ),
            ListSpec(
                "ublock-privacy", "uBlock privacy",
                listOf(
                    "https://ublockorigin.github.io/uAssets/filters/privacy.txt",
                    "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
                )
            ),
        )
    }
}
