package dev.shaurya.browser

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.shaurya.browser.adblock.BlockerService
import dev.shaurya.browser.ai.AiClient
import dev.shaurya.browser.data.ShauryaStore
import dev.shaurya.browser.data.SavedTab
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The browser's state, owned outside the UI so a rotation or a process
 * restart does not lose the user's tabs.
 */
class BrowserViewModel(app: Application) : AndroidViewModel(app) {

    val store = ShauryaStore(app)
    val blocker = BlockerService(app)
    val ai = AiClient(store)

    private val _tabs = MutableStateFlow<List<Tab>>(emptyList())
    val tabs: StateFlow<List<Tab>> = _tabs.asStateFlow()

    private val _activeTabId = MutableStateFlow(0L)
    val activeTabId: StateFlow<Long> = _activeTabId.asStateFlow()

    private val _assistant = MutableStateFlow(AssistantState())
    val assistant: StateFlow<AssistantState> = _assistant.asStateFlow()

    // -- background playback ------------------------------------------------
    // Reported by the media watcher injected into each page. Null means
    // nothing is playing anywhere, which is what lets the activity decide
    // whether backgrounding should pause the WebViews or hold a foreground
    // service.

    /**
     * True while the blocker is running on the bundled seed list alone.
     *
     * Surfaced because "nothing was blocked" and "nothing is loaded to block
     * with" look identical on a shield reading zero, and only one of them
     * means the page is clean.
     */
    private val _seedOnly = MutableStateFlow(false)
    val seedOnly: StateFlow<Boolean> = _seedOnly.asStateFlow()

    // -- shield totals and saved pages, for the new tab page and the sheets --
    // Held as flows so a bookmark added from the menu repaints the bottom bar
    // and the new tab page without either of them polling the store.

    private val _stats = MutableStateFlow(store.shieldStats)
    val stats: StateFlow<dev.shaurya.browser.data.ShieldStats> = _stats.asStateFlow()

    private val _bookmarks = MutableStateFlow(store.bookmarks.toList())
    val bookmarks: StateFlow<List<dev.shaurya.browser.data.Bookmark>> = _bookmarks.asStateFlow()

    private val _history = MutableStateFlow(store.history.toList())
    val history: StateFlow<List<dev.shaurya.browser.data.HistoryEntry>> = _history.asStateFlow()

    private val _settings = MutableStateFlow(store.settings)
    val settings: StateFlow<dev.shaurya.browser.data.Settings> = _settings.asStateFlow()

    /** Per-tab count of http:// URLs rewritten to https://. */
    private val httpsUpgrades = HashMap<Long, Int>()

    /**
     * Fold the blocks and upgrades accumulated during a page load into the
     * lifetime totals.
     *
     * Called at page-load boundaries rather than per event: the counters are
     * cheap in memory and expensive on disk.
     */
    fun flushStats() {
        val blocked = blocker.drainBlockedTotal()
        // Long throughout: these feed a persisted lifetime total, and mixing
        // Int and Long here is what broke the build last time.
        val upgrades: Long = synchronized(httpsUpgrades) {
            val total = pendingUpgrades.toLong()
            pendingUpgrades = 0
            total
        }
        if (blocked == 0L && upgrades == 0L) return
        store.addShieldStats(blocked = blocked, httpsUpgrades = upgrades)
        _stats.value = store.shieldStats
    }

    private var pendingUpgrades = 0

    /** A request was rewritten from http:// to https://. */
    fun recordHttpsUpgrade(tabId: Long) {
        synchronized(httpsUpgrades) {
            httpsUpgrades[tabId] = (httpsUpgrades[tabId] ?: 0) + 1
            pendingUpgrades++
        }
    }

    fun httpsUpgradesFor(tabId: Long): Int =
        synchronized(httpsUpgrades) { httpsUpgrades[tabId] ?: 0 }

    /** Most-visited sites for the new tab page. */
    fun topSites(): List<dev.shaurya.browser.ui.TopSite> =
        store.topSites().map { dev.shaurya.browser.ui.TopSite(it.url, it.title) }

    // -- shields, per site --------------------------------------------------

    fun shieldsOn(url: String?): Boolean {
        val host = dev.shaurya.browser.adblock.FilterEngine.hostOf((url ?: "").lowercase())
            ?: return true
        return !blocker.isAllowed(host)
    }

    fun setShieldsOn(url: String?, on: Boolean) {
        val host = dev.shaurya.browser.adblock.FilterEngine.hostOf((url ?: "").lowercase()) ?: return
        blocker.setSiteEnabled(host, on)
        updateSettings { it.copy(shieldExceptions = blocker.exceptions().toList()) }
    }

    // -- saved pages --------------------------------------------------------

    fun isBookmarked(url: String?): Boolean = url != null && store.isBookmarked(url)

    fun toggleBookmark(url: String, title: String): Boolean {
        val existing = store.bookmarks.firstOrNull { it.url == url }
        if (existing != null) store.removeBookmark(existing.id) else store.addBookmark(url, title)
        _bookmarks.value = store.bookmarks.toList()
        return existing == null
    }

    fun removeBookmark(id: String) {
        store.removeBookmark(id)
        _bookmarks.value = store.bookmarks.toList()
    }

    fun clearHistory() {
        store.clearHistory()
        _history.value = emptyList()
    }

    fun updateSettings(transform: (dev.shaurya.browser.data.Settings) -> dev.shaurya.browser.data.Settings) {
        store.updateSettings(transform)
        _settings.value = store.settings
        // The blocker reads this at request time, so a change has to reach it
        // rather than only the file.
        blocker.enabled = store.settings.adblockEnabled
    }

    private val _playingTabId = MutableStateFlow<Long?>(null)
    val playingTabId: StateFlow<Long?> = _playingTabId.asStateFlow()

    private val _playingTitle = MutableStateFlow("")
    val playingTitle: StateFlow<String> = _playingTitle.asStateFlow()

    private val _playingArtist = MutableStateFlow("")
    val playingArtist: StateFlow<String> = _playingArtist.asStateFlow()

    /**
     * A page announced its playback state.
     *
     * @param tabId  the tab that reported — never taken from the payload, so
     *               one page cannot claim to be another
     */
    fun reportPlayback(tabId: Long, playing: Boolean, title: String, artist: String) {
        if (playing) {
            _playingTabId.value = tabId
            _playingTitle.value = title
            _playingArtist.value = artist
        } else if (_playingTabId.value == tabId) {
            // Only the tab that owns the session may end it. Otherwise a
            // second tab pausing its silent background video would stop the
            // music playing in the first.
            _playingTabId.value = null
            _playingTitle.value = ""
            _playingArtist.value = ""
        }
    }

    /** A tab closed or navigated away; drop any session it held. */
    fun clearPlayback(tabId: Long) = reportPlayback(tabId, false, "", "")

    private var nextId = 1L

    val activeTab: Tab? get() = _tabs.value.firstOrNull { it.id == _activeTabId.value }

    init {
        blocker.enabled = store.settings.adblockEnabled
        blocker.onIndexChanged = { _seedOnly.value = blocker.usingSeed }
        // "Shields off for this site" must survive a restart, or the setting
        // is a gesture rather than a preference.
        blocker.restoreExceptions(store.settings.shieldExceptions)
        viewModelScope.launch { blocker.initialise() }
        restoreOrOpenBlank()
    }

    // -----------------------------------------------------------------------
    // Tabs
    // -----------------------------------------------------------------------

    data class Tab(
        val id: Long,
        val url: String,
        val title: String = "New tab",
        val loading: Boolean = false,
        val progress: Int = 0,
        val canGoBack: Boolean = false,
        val canGoForward: Boolean = false,
        val incognito: Boolean = false,
        val blockedCount: Int = 0,
    )

    private fun restoreOrOpenBlank() {
        val saved = if (store.settings.restoreTabs) store.loadSession() else emptyList()
        if (saved.isEmpty()) {
            newTab(HOME_URL)
        } else {
            saved.forEach { newTab(it.url, activate = false, title = it.title) }
            _activeTabId.value = _tabs.value.first().id
        }
    }

    fun newTab(url: String = HOME_URL, activate: Boolean = true, incognito: Boolean = false,
               title: String = "New tab"): Long {
        val id = nextId++
        _tabs.update { it + Tab(id = id, url = url, title = title, incognito = incognito) }
        if (activate) _activeTabId.value = id
        return id
    }

    fun closeTab(id: Long) {
        val current = _tabs.value
        val index = current.indexOfFirst { it.id == id }
        if (index < 0) return

        val remaining = current.filterNot { it.id == id }
        blocker.resetCount(id)

        if (remaining.isEmpty()) {
            _tabs.value = emptyList()
            newTab(HOME_URL)
            return
        }
        _tabs.value = remaining
        if (_activeTabId.value == id) {
            // Prefer the tab to the right, as every browser does.
            _activeTabId.value = (remaining.getOrNull(index) ?: remaining.last()).id
        }
        persistSession()
    }

    fun activateTab(id: Long) {
        _activeTabId.value = id
    }

    fun updateTab(id: Long, transform: (Tab) -> Tab) {
        _tabs.update { tabs -> tabs.map { if (it.id == id) transform(it) else it } }
    }

    /** Called on every committed navigation. */
    fun onNavigated(id: Long, url: String, title: String) {
        val tab = _tabs.value.firstOrNull { it.id == id } ?: return
        blocker.resetCount(id)
        updateTab(id) { it.copy(url = url, title = title) }
        store.recordVisit(url, title, tab.incognito)
        if (!tab.incognito) _history.value = store.history.toList()
        // The page is done, so fold its blocks into the lifetime totals.
        flushStats()
        persistSession()
    }

    private fun persistSession() {
        if (!store.settings.restoreTabs) return
        store.saveSession(
            _tabs.value.filterNot { it.incognito }.map { SavedTab(it.url, it.title) }
        )
    }

    // -----------------------------------------------------------------------
    // Omnibox
    // -----------------------------------------------------------------------

    /**
     * Decide whether input is a URL or a search — the same heuristic the
     * desktop uses, because getting it wrong is immediately visible.
     */
    fun resolveInput(input: String): String {
        val text = input.trim()
        if (text.isEmpty()) return HOME_URL
        if (text.matches(Regex("^(https?|file|about|data)://.*"))) return text
        if (text.contains(Regex("\\s"))) return searchUrl(text)

        if (text.matches(Regex("^(localhost|127\\.0\\.0\\.1)(:\\d+)?(/.*)?$"))) {
            return "http://$text"
        }
        if (text.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$"))) {
            return "http://$text"
        }

        val hostPart = text.substringBefore('/').substringBefore('?')
        val labels = hostPart.split(".")
        if (labels.size >= 2 && labels.all { it.isNotEmpty() && it.matches(Regex("[a-zA-Z0-9-]+")) }) {
            val tld = labels.last().lowercase()
            if (tld.length >= 2 && tld.all { it.isLetter() }) return "https://$text"
        }
        return searchUrl(text)
    }

    /** Is Shaurya Search the chosen engine? */
    val shauryaSearch: Boolean get() = store.settings.searchEngine == "shaurya"

    /** Which external engine a web hand-off should lead with. */
    val webProvider: String
        get() = store.settings.searchEngine.takeIf { it != "shaurya" } ?: "duckduckgo"

    /** Would this input be a web search rather than a URL? */
    fun isWebSearch(input: String): Boolean =
        resolveInput(input).startsWith(searchUrl(""))

    /** Everything Shaurya Search can offer for a query. */
    fun searchResults(query: String): dev.shaurya.browser.search.ShauryaSearch.Results {
        val bookmarked = store.bookmarks.mapTo(HashSet()) { it.url }
        val known = store.history.map {
            dev.shaurya.browser.search.ShauryaSearch.Known(
                url = it.url,
                title = it.title,
                visits = it.visits,
                lastVisit = it.lastVisit,
                bookmarked = it.url in bookmarked,
            )
        } + store.bookmarks
            .filter { it.url !in store.history.map { h -> h.url }.toSet() }
            .map {
                dev.shaurya.browser.search.ShauryaSearch.Known(
                    url = it.url, title = it.title, visits = 0,
                    lastVisit = it.created, bookmarked = true,
                )
            }
        return dev.shaurya.browser.search.ShauryaSearch.search(query, known, webProvider)
    }

    private fun searchUrl(query: String): String {
        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
        // Shaurya Search has no URL of its own; when it is the chosen engine
        // the caller shows the in-app results screen instead. This fallback
        // is what a web hand-off from that screen uses.
        return when (webProvider) {
            "google" -> "https://www.google.com/search?q=$encoded"
            "brave" -> "https://search.brave.com/search?q=$encoded"
            "startpage" -> "https://www.startpage.com/sp/search?query=$encoded"
            else -> "https://duckduckgo.com/?q=$encoded"
        }
    }

    /** Suggestions for the address bar: history and bookmarks. */
    fun suggestions(query: String): List<Suggestion> {
        if (query.isBlank()) return emptyList()
        val q = query.lowercase()
        val results = mutableListOf<Suggestion>()

        store.bookmarks
            .filter { it.title.lowercase().contains(q) || it.url.lowercase().contains(q) }
            .take(4)
            .forEach { results.add(Suggestion(it.title, it.url, SuggestionKind.BOOKMARK)) }

        store.searchHistory(query, 6)
            .forEach { results.add(Suggestion(it.title, it.url, SuggestionKind.HISTORY)) }

        val resolved = resolveInput(query)
        // Offer the search explicitly rather than leaving it implicit in the
        // Go key. Half-typed queries look like addresses ("git status") and a
        // list that only ever offers history gives no way to say "no, search
        // for what I actually typed".
        if (resolved.startsWith(searchUrl(""))) {
            results.add(0, Suggestion("Search for \u201C$query\u201D", resolved, SuggestionKind.SEARCH))
        }

        return results.distinctBy { it.url }.take(8)
    }

    enum class SuggestionKind { HISTORY, BOOKMARK, SEARCH }
    data class Suggestion(val title: String, val url: String, val kind: SuggestionKind)

    // -----------------------------------------------------------------------
    // Assistant
    // -----------------------------------------------------------------------

    data class AssistantState(
        val open: Boolean = false,
        val busy: Boolean = false,
        val messages: List<Message> = emptyList(),
        val error: String? = null,
    )

    data class Message(val role: String, val text: String)

    fun toggleAssistant() {
        _assistant.update { it.copy(open = !it.open, error = null) }
    }

    /**
     * Ask the assistant about the current page.
     *
     * @param pageText already extracted by the WebView layer, because only it
     *        can reach the DOM.
     */
    fun ask(question: String, pageText: String?, pageUrl: String?, pageTitle: String?) {
        if (_assistant.value.busy) return

        _assistant.update {
            it.copy(
                busy = true,
                error = null,
                messages = it.messages + Message("user", question) + Message("assistant", ""),
            )
        }

        viewModelScope.launch {
            val context = pageText?.takeIf { it.isNotBlank() }?.let {
                AiClient.PageContext(
                    url = pageUrl.orEmpty(),
                    title = pageTitle.orEmpty(),
                    text = it.take(40_000),
                    truncated = it.length > 40_000,
                )
            }

            runCatching {
                ai.ask(
                    question = question,
                    pageContext = context,
                    history = _assistant.value.messages
                        .dropLast(2)
                        .filter { it.text.isNotBlank() }
                        .map { AiClient.Turn(it.role, it.text) },
                ) { delta ->
                    // Append to the placeholder assistant message as tokens
                    // arrive, so the answer streams into the sheet.
                    _assistant.update { state ->
                        val messages = state.messages.toMutableList()
                        val last = messages.lastOrNull() ?: return@update state
                        messages[messages.lastIndex] = last.copy(text = last.text + delta)
                        state.copy(messages = messages)
                    }
                }
            }.onFailure { error ->
                _assistant.update { state ->
                    state.copy(
                        busy = false,
                        error = error.message ?: "The assistant failed",
                        // Drop the empty placeholder so the sheet is not left
                        // showing a blank bubble.
                        messages = state.messages.dropLastWhile { it.text.isBlank() },
                    )
                }
                return@launch
            }

            _assistant.update { it.copy(busy = false) }
        }
    }

    /** Turn the current page into notes (spec §4). */
    fun generateNotes(pageText: String, pageUrl: String, pageTitle: String, onDone: (String) -> Unit) {
        viewModelScope.launch {
            val result = runCatching {
                ai.ask(
                    question = NOTE_PROMPT,
                    pageContext = AiClient.PageContext(pageUrl, pageTitle, pageText.take(80_000), false),
                ) { }
            }
            result.onSuccess { markdown ->
                withContext(Dispatchers.IO) {
                    store.saveNote(pageTitle, markdown, pageUrl)
                }
                onDone("Notes saved")
            }.onFailure { onDone(it.message ?: "Could not generate notes") }
        }
    }

    fun clearConversation() {
        _assistant.update { it.copy(messages = emptyList(), error = null) }
    }

    companion object {
        const val HOME_URL = "about:blank"

        private val NOTE_PROMPT = """
            Turn this page into structured study notes in Markdown, using this shape and
            omitting any section that does not apply:

            # <title>
            > <one-sentence summary>
            ## Key points
            - <the substantive claims, specific rather than generic>
            ## Definitions
            - **<term>** — <definition in the source's own sense>
            ## Open questions
            - <what the source raises but does not answer>

            Draw only on the page. Do not add outside facts.
        """.trimIndent()
    }
}
