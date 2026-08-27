package dev.aether.browser

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import dev.aether.browser.media.PlaybackService
import dev.aether.browser.ui.AetherTheme
import kotlinx.coroutines.launch

/**
 * The browser shell.
 *
 * One `WebView` per tab, retained across tab switches so back/forward history
 * and scroll position survive — recreating the view on every switch is the
 * usual shortcut and it loses both.
 */
class MainActivity : ComponentActivity() {

    private val model: BrowserViewModel by viewModels()

    /** tab id -> its live WebView. */
    private val webViews = mutableMapOf<Long, WebView>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContent {
            AetherTheme(accent = model.store.settings.accent, themeMode = model.store.settings.theme) {
                BrowserScreen()
            }
        }
    }

    /**
     * Background playback (spec: "add background play").
     *
     * WebView's own `onPause()` is what silences media when the app leaves
     * the foreground — so the whole feature is: do not call it when something
     * is playing, and hold a foreground service so the system lets the
     * process live. Calling `pauseTimers()` here instead would stop the
     * site's JavaScript, which stalls the player at the end of the track for
     * the same reason background throttling does on desktop.
     */
    override fun onPause() {
        super.onPause()
        if (isPlayingMedia()) {
            startPlaybackService()
        } else {
            // Nothing playing: pause everything, which is what saves battery
            // for the overwhelmingly common case of a backgrounded browser.
            webViews.values.forEach { it.onPause() }
            webViews.values.firstOrNull()?.pauseTimers()
        }
    }

    override fun onResume() {
        super.onResume()
        webViews.values.forEach { it.onResume() }
        webViews.values.firstOrNull()?.resumeTimers()
        // The notification exists to control playback while away. Back in the
        // foreground the app itself is the control surface, so drop it rather
        // than leaving a redundant notification in the shade.
        if (!isPlayingMedia()) PlaybackService.stop(this)
    }

    /**
     * Is any tab producing sound?
     *
     * There is no synchronous WebView API for this, so the state is what the
     * injected media watcher last reported. A tab that has never reported is
     * treated as silent — the conservative direction, since the cost of a
     * false positive is a foreground service holding the process alive for
     * nothing.
     */
    private fun isPlayingMedia(): Boolean = model.playingTabId.value != null

    private fun startPlaybackService() {
        val playingId = model.playingTabId.value ?: return
        val tab = model.tabs.value.firstOrNull { it.id == playingId }

        // Transport controls reach whichever WebView is actually playing.
        PlaybackService.onPlay = { runOnUiThread { evaluateMedia(playingId, "play") } }
        PlaybackService.onPause = { runOnUiThread { evaluateMedia(playingId, "pause") } }
        PlaybackService.onNext = { runOnUiThread { evaluateMedia(playingId, "next") } }
        PlaybackService.onPrevious = { runOnUiThread { evaluateMedia(playingId, "previous") } }

        PlaybackService.update(
            this,
            title = model.playingTitle.value.ifBlank { tab?.title.orEmpty() },
            artist = model.playingArtist.value,
            playing = true
        )
    }

    /** Drive the page's own player rather than poking the element blindly. */
    private fun evaluateMedia(tabId: Long, action: String) {
        val view = webViews[tabId] ?: return
        val script = when (action) {
            "play" -> "document.querySelector('audio,video')?.play()"
            "pause" -> "document.querySelector('audio,video')?.pause()"
            // Dispatch the key the site is listening for; a site with a queue
            // needs its own next-track logic to run.
            "next" -> "document.dispatchEvent(new KeyboardEvent('keydown',{key:'MediaTrackNext'}))"
            "previous" -> "document.dispatchEvent(new KeyboardEvent('keydown',{key:'MediaTrackPrevious'}))"
            else -> return
        }
        view.evaluateJavascript(script, null)
    }

    /**
     * The page-to-app bridge for playback reports.
     *
     * Deliberately tiny. Everything it receives is untrusted page input, so
     * strings are bounded before they reach a notification and the tab id is
     * bound at construction rather than accepted as an argument.
     */
    private inner class MediaBridge(private val tabId: Long) {
        @android.webkit.JavascriptInterface
        fun report(playing: Boolean, title: String?, artist: String?) {
            val safeTitle = (title ?: "").take(200)
            val safeArtist = (artist ?: "").take(200)
            runOnUiThread {
                model.reportPlayback(tabId, playing, safeTitle, safeArtist)
                // Keep the notification's metadata current while it is up.
                if (playing && model.playingTabId.value == tabId) {
                    PlaybackService.update(this@MainActivity, safeTitle, safeArtist, true)
                }
            }
        }
    }

    override fun onDestroy() {
        PlaybackService.stop(this)
        PlaybackService.onPlay = null
        PlaybackService.onPause = null
        PlaybackService.onNext = null
        PlaybackService.onPrevious = null
        webViews.values.forEach { it.destroy() }
        webViews.clear()
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // Screen
    // -----------------------------------------------------------------------

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun BrowserScreen() {
        val tabs by model.tabs.collectAsStateWithLifecycle()
        val activeId by model.activeTabId.collectAsStateWithLifecycle()
        val assistant by model.assistant.collectAsStateWithLifecycle()
        val scope = rememberCoroutineScope()
        val snackbar = remember { SnackbarHostState() }

        var addressText by remember { mutableStateOf("") }
        var editingAddress by remember { mutableStateOf(false) }
        var showTabs by remember { mutableStateOf(false) }
        var showMenu by remember { mutableStateOf(false) }

        val active = tabs.firstOrNull { it.id == activeId }

        // Hardware back navigates the page before it leaves the app.
        BackHandler(enabled = active?.canGoBack == true) {
            webViews[activeId]?.goBack()
        }

        LaunchedEffect(active?.url, editingAddress) {
            if (!editingAddress) addressText = active?.url.orEmpty()
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = {
                // Bottom toolbar: on a phone the address bar belongs where
                // thumbs are, not at the top of a 6-inch screen.
                Toolbar(
                    text = addressText,
                    editing = editingAddress,
                    tab = active,
                    // From tab state, so the badge recomposes as the count changes.
                    blockedCount = active?.blockedCount ?: 0,
                    onTextChange = { addressText = it },
                    onEditingChange = { editingAddress = it },
                    onGo = {
                        val url = model.resolveInput(addressText)
                        webViews[activeId]?.loadUrl(url)
                        editingAddress = false
                    },
                    onBack = { webViews[activeId]?.goBack() },
                    onReload = {
                        if (active?.loading == true) webViews[activeId]?.stopLoading()
                        else webViews[activeId]?.reload()
                    },
                    onTabs = { showTabs = true },
                    onMenu = { showMenu = true },
                    onAssistant = { model.toggleAssistant() },
                    suggestions = if (editingAddress) model.suggestions(addressText) else emptyList(),
                    onSuggestion = { url ->
                        webViews[activeId]?.loadUrl(url)
                        editingAddress = false
                    },
                )
            }
        ) { padding ->
            Box(Modifier.padding(padding).fillMaxSize()) {
                if (active != null) {
                    WebViewHost(tabId = active.id, initialUrl = active.url)
                }
                if (active?.loading == true && active.progress in 1..99) {
                    LinearProgressIndicator(
                        progress = { active.progress / 100f },
                        modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter),
                    )
                }
            }
        }

        if (showTabs) {
            TabSheet(
                tabs = tabs,
                activeId = activeId,
                onSelect = { model.activateTab(it); showTabs = false },
                onClose = { model.closeTab(it) },
                onNew = { model.newTab(); showTabs = false },
                onDismiss = { showTabs = false },
            )
        }

        if (showMenu) {
            MenuSheet(
                tab = active,
                onDismiss = { showMenu = false },
                onBookmark = {
                    active ?: return@MenuSheet
                    model.store.addBookmark(active.url, active.title)
                    scope.launch { snackbar.showSnackbar("Bookmarked") }
                    showMenu = false
                },
                onNotes = {
                    showMenu = false
                    extractPageText(activeId) { text ->
                        if (text.isNullOrBlank()) {
                            scope.launch { snackbar.showSnackbar("Nothing readable on this page") }
                            return@extractPageText
                        }
                        scope.launch { snackbar.showSnackbar("Generating notes…") }
                        model.generateNotes(text, active?.url.orEmpty(), active?.title.orEmpty()) {
                            scope.launch { snackbar.showSnackbar(it) }
                        }
                    }
                },
                onIncognito = {
                    model.newTab(incognito = true)
                    showMenu = false
                },
            )
        }

        if (assistant.open) {
            AssistantSheet(
                state = assistant,
                onDismiss = { model.toggleAssistant() },
                onSend = { question ->
                    extractPageText(activeId) { text ->
                        model.ask(question, text, active?.url, active?.title)
                    }
                },
                onClear = { model.clearConversation() },
            )
        }
    }

    // -----------------------------------------------------------------------
    // WebView
    // -----------------------------------------------------------------------

    /**
     * Hosts one tab's WebView.
     *
     * Keyed by tab id so switching tabs creates a *new* AndroidView slot
     * rather than reusing one: without the key, Compose keeps the same slot
     * and the previous tab's WebView stays on screen. The view itself is
     * retained in `webViews`, so back/forward history and scroll position
     * survive the switch — recreating it is the usual shortcut and it loses
     * both.
     */
    @SuppressLint("SetJavaScriptEnabled")
    @Composable
    private fun WebViewHost(tabId: Long, initialUrl: String) {
        key(tabId) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    val existing = webViews[tabId]
                    if (existing != null) {
                        // Detach from the slot it was in before re-parenting;
                        // adding a view that still has a parent throws.
                        (existing.parent as? ViewGroup)?.removeView(existing)
                        existing
                    } else {
                        WebView(context).also { view ->
                            view.layoutParams = ViewGroup.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT,
                            )
                            webViews[tabId] = view
                            configure(view, tabId)
                            view.loadUrl(initialUrl)
                        }
                    }
                },
            )
        }
    }

    private fun configure(view: WebView, tabId: Long) {
        val tab = model.tabs.value.firstOrNull { it.id == tabId }
        val incognito = tab?.incognito == true

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = !incognito
            databaseEnabled = !incognito
            loadsImagesAutomatically = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = true
            // Mixed content stays blocked: an HTTPS page must not silently
            // pull plaintext subresources.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = if (incognito) WebSettings.LOAD_NO_CACHE else WebSettings.LOAD_DEFAULT
            // Present as Chrome; some sites serve a degraded page to WebView.
            userAgentString = userAgentString.replace("; wv", "")
        }

        if (incognito) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        } else if (model.store.settings.blockThirdPartyCookies) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        }

        // Force dark where the OEM WebView supports it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, true)
        }

        view.webViewClient = object : WebViewClient() {
            /**
             * The blocking hook. Runs on WebView's IO thread for every
             * subresource, so it must be fast and must never throw.
             */
            override fun shouldInterceptRequest(
                webView: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = model.blocker.intercept(request, currentPageUrl(tabId), tabId)

            override fun shouldOverrideUrlLoading(
                webView: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // HTTPS-only: upgrade rather than load plaintext.
                if (model.store.settings.httpsOnly && url.startsWith("http://") &&
                    !isLocalAddress(request.url.host)
                ) {
                    webView.loadUrl(url.replaceFirst("http://", "https://"))
                    return true
                }
                return false
            }

            override fun onPageStarted(webView: WebView, url: String, favicon: android.graphics.Bitmap?) {
                model.updateTab(tabId) { it.copy(loading = true, url = url, progress = 0) }
            }

            override fun onPageFinished(webView: WebView, url: String) {
                model.updateTab(tabId) {
                    it.copy(
                        loading = false,
                        url = url,
                        title = webView.title.orEmpty().ifBlank { url },
                        canGoBack = webView.canGoBack(),
                        canGoForward = webView.canGoForward(),
                        blockedCount = model.blocker.blockedCount(tabId),
                    )
                }
                model.onNavigated(tabId, url, webView.title.orEmpty())
                injectCosmeticFilters(webView, url)
                injectMediaWatcher(webView)
            }

            override fun doUpdateVisitedHistory(webView: WebView, url: String, isReload: Boolean) {
                super.doUpdateVisitedHistory(webView, url, isReload)
                // A single-page app can swap the player out without a page
                // load, so a stale session must not outlive the document it
                // belonged to.
                if (!isReload) model.clearPlayback(tabId)
            }
        }

        // The media watcher's only way back into the app.
        //
        // A JavaScript interface is a real attack surface — every page gets
        // it — so this one exposes exactly one method that takes three
        // primitives and can only set a title on a notification. The tab id
        // is captured here rather than passed by the page, so a page cannot
        // report playback on another tab's behalf.
        view.addJavascriptInterface(MediaBridge(tabId), "AetherMedia")

        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(webView: WebView, progress: Int) {
                model.updateTab(tabId) { it.copy(progress = progress) }
            }

            override fun onReceivedTitle(webView: WebView, title: String) {
                model.updateTab(tabId) { it.copy(title = title) }
            }
        }
    }

    /**
     * Hide the empty frames the network layer left behind.
     *
     * Only site-specific selectors are injected: the ~13k generic ones would
     * need a DOM scan on every page, which costs more on a phone than the ads
     * did.
     */
    /**
     * Watch the page's media and report it back through the JS bridge.
     *
     * The desktop build does this from a preload script; WebView has no
     * equivalent, so the watcher is injected after load. It reads
     * `navigator.mediaSession.metadata` — the same source the desktop uses,
     * and what a site declares for the system media hub — falling back to the
     * element for the many sites that never set it.
     *
     * Silent, short, looping elements are ignored: a decorative background
     * video is not a track, and treating one as such would hold a foreground
     * service alive for a CSS effect.
     */
    private fun injectMediaWatcher(view: WebView) {
        view.evaluateJavascript(
            """
            (function() {
              if (window.__aetherMedia) return;
              window.__aetherMedia = true;

              var last = '';
              function active() {
                var all = [].slice.call(document.querySelectorAll('audio, video'))
                  .filter(function(e) { return e.readyState > 0 && !e.ended; });
                return all.filter(function(e) { return !e.paused && !e.muted; })[0]
                    || all.filter(function(e) { return !e.paused; })[0]
                    || null;
              }
              function report() {
                var el = active();
                var meta = navigator.mediaSession && navigator.mediaSession.metadata;
                var decorative = el && el.muted && el.loop && (el.duration || 0) < 60;
                var playing = !!(el && !el.paused && !decorative);
                var title = (meta && meta.title) || document.title || '';
                var artist = (meta && meta.artist) || '';
                var sig = playing + '|' + title + '|' + artist;
                if (sig === last) return;
                last = sig;
                if (window.AetherMedia) AetherMedia.report(playing, title, artist);
              }
              ['play','pause','ended','loadedmetadata','emptied'].forEach(function(t) {
                document.addEventListener(t, report, true);
              });
              setInterval(report, 2000);
              report();
            })();
            """.trimIndent(),
            null
        )
    }

    private fun injectCosmeticFilters(view: WebView, url: String) {
        val host = dev.aether.browser.adblock.FilterEngine.hostOf(url.lowercase()) ?: return
        val css = model.blocker.engine.cosmeticCss(host)
        if (css.isEmpty()) return

        // The CSS is embedded as a JSON string literal, never concatenated
        // into source, so a selector containing a quote cannot break out.
        val literal = org.json.JSONObject.quote(css)
        view.evaluateJavascript(
            """
            (function() {
              var style = document.createElement('style');
              style.setAttribute('data-aether', 'cosmetic');
              style.textContent = $literal;
              (document.head || document.documentElement).appendChild(style);
            })();
            """.trimIndent(),
            null,
        )
    }

    /** Pull the page's visible text for the assistant. */
    private fun extractPageText(tabId: Long, callback: (String?) -> Unit) {
        val view = webViews[tabId] ?: return callback(null)
        view.evaluateJavascript(
            "(function(){return document.body ? document.body.innerText : '';})()"
        ) { raw ->
            // evaluateJavascript returns a JSON-encoded string.
            val text = runCatching {
                org.json.JSONTokener(raw).nextValue() as? String
            }.getOrNull()
            callback(text)
        }
    }

    private fun currentPageUrl(tabId: Long): String? =
        model.tabs.value.firstOrNull { it.id == tabId }?.url

    private fun isLocalAddress(host: String?): Boolean {
        if (host == null) return false
        return host == "localhost" || host == "127.0.0.1" || host.endsWith(".localhost") ||
            host.startsWith("192.168.") || host.startsWith("10.") ||
            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host)
    }
}
