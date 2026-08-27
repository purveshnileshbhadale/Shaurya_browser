package dev.aether.browser

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
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
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import dev.aether.browser.media.PlaybackService
import dev.aether.browser.ui.AetherTheme
import dev.aether.browser.ui.LocalReducedMotion
import dev.aether.browser.ui.isDarkTheme
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

    /**
     * Tab id -> a picture of what that tab last looked like.
     *
     * Compose-observable, so a capture repaints the switcher without any
     * explicit invalidation. Bounded, because these are the only genuinely
     * large objects the app holds: a phone-sized ARGB bitmap is megabytes,
     * and a browser with thirty tabs would spend more memory remembering what
     * they looked like than rendering them.
     */
    private val thumbnails = mutableStateMapOf<Long, ImageBitmap>()

    /** Capture order, oldest first, so the cap evicts the least recent. */
    private val thumbnailOrder = ArrayDeque<Long>()

    /** The theme's surface colour, for WebViews created after theming ran. */
    private var webViewBacking: Int? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContent {
            val dark = isDarkTheme(model.store.settings.theme)

            // Transparent bars in both directions, but the *icon* colour has
            // to follow the theme: edge-to-edge means our own surface is what
            // shows through the status bar, and dark icons on a dark toolbar
            // are simply not there.
            LaunchedEffect(dark) {
                val style = if (dark) {
                    SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(
                        android.graphics.Color.TRANSPARENT,
                        android.graphics.Color.TRANSPARENT,
                    )
                }
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }

            AetherTheme(accent = model.store.settings.accent, themeMode = model.store.settings.theme) {
                // Paint the WebView's own backing to match, or every
                // navigation flashes white before the page paints — the most
                // noticeable remaining seam in a dark theme. Remembered as
                // well as applied, because a tab opened *after* this runs
                // gets its WebView built in `configure`, which has no theme
                // to read.
                val backing = MaterialTheme.colorScheme.surface.toArgb()
                LaunchedEffect(backing) {
                    webViewBacking = backing
                    webViews.values.forEach { it.setBackgroundColor(backing) }
                }
                BrowserScreen()
            }
        }
    }

    /**
     * Photograph a tab for the switcher.
     *
     * `WebView.draw` renders whatever is currently composited, which means
     * this is only meaningful for a tab that is on screen — capturing a
     * backgrounded tab yields a blank rectangle. So it is called at the
     * moment a tab stops being visible, not when the switcher opens.
     *
     * Private tabs are never captured. A thumbnail is a record of what was on
     * screen, and the whole promise of a private tab is that no such record
     * is kept.
     */
    private fun captureThumbnail(tabId: Long) {
        val view = webViews[tabId] ?: return
        if (view.width <= 0 || view.height <= 0) return
        if (model.tabs.value.firstOrNull { it.id == tabId }?.incognito == true) return

        val scale = 0.32f
        val width = (view.width * scale).toInt().coerceAtLeast(1)
        val height = (view.height * scale).toInt().coerceAtLeast(1)

        // RGB_565 is half the bytes of ARGB_8888 and loses nothing that
        // survives being scaled to a third and shown at card size.
        val bitmap = runCatching {
            Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
        }.getOrNull() ?: return

        val canvas = Canvas(bitmap)
        canvas.scale(scale, scale)
        runCatching { view.draw(canvas) }.onFailure { return }

        thumbnails[tabId] = bitmap.asImageBitmap()
        thumbnailOrder.remove(tabId)
        thumbnailOrder.addLast(tabId)
        trimThumbnails()
    }

    /** Keep the cache bounded and free of pictures for tabs that are gone. */
    private fun trimThumbnails() {
        val live = model.tabs.value.mapTo(mutableSetOf()) { it.id }
        thumbnailOrder.retainAll { it in live }
        thumbnails.keys.retainAll(live)

        while (thumbnailOrder.size > MAX_THUMBNAILS) {
            thumbnails.remove(thumbnailOrder.removeFirst())
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
        // Last chance to photograph what is on screen: after this the window
        // is no longer composited and a capture draws nothing.
        captureThumbnail(model.activeTabId.value)

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

    @Composable
    private fun BrowserScreen() {
        val tabs by model.tabs.collectAsStateWithLifecycle()
        val activeId by model.activeTabId.collectAsStateWithLifecycle()
        val assistant by model.assistant.collectAsStateWithLifecycle()
        val playingTabId by model.playingTabId.collectAsStateWithLifecycle()
        val playingTitle by model.playingTitle.collectAsStateWithLifecycle()
        val playingArtist by model.playingArtist.collectAsStateWithLifecycle()
        val scope = rememberCoroutineScope()
        val snackbar = remember { SnackbarHostState() }
        val reducedMotion = LocalReducedMotion.current

        var addressText by remember { mutableStateOf("") }
        var editingAddress by remember { mutableStateOf(false) }
        var showTabs by remember { mutableStateOf(false) }
        var showMenu by remember { mutableStateOf(false) }

        val active = tabs.firstOrNull { it.id == activeId }

        val nowPlaying = playingTabId?.let { id ->
            NowPlaying(
                tabId = id,
                title = playingTitle.ifBlank { tabs.firstOrNull { it.id == id }?.title.orEmpty() },
                artist = playingArtist,
                playing = true,
            )
        }

        // Hardware and gesture back: leave the switcher, then walk the page's
        // history, and only then leave the app. Registering these as ordered
        // handlers is also what makes the predictive-back animation show the
        // right destination — the system needs to know something will consume
        // the gesture before the finger lifts.
        BackHandler(enabled = showTabs) { showTabs = false }
        BackHandler(enabled = !showTabs && active?.canGoBack == true) {
            webViews[activeId]?.goBack()
        }

        LaunchedEffect(active?.url, editingAddress) {
            if (!editingAddress) addressText = active?.url.orEmpty()
        }

        // The switcher covers the browser rather than sitting beside it, so
        // the stacking is stated here rather than left to whatever the root
        // layout happens to do with two full-size siblings.
        Box(Modifier.fillMaxSize()) {
            Scaffold(
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = {
                    BottomBar(
                        text = addressText,
                        editing = editingAddress,
                        tab = active,
                        tabCount = tabs.size,
                        // From tab state, so the badge recomposes as the count changes.
                        blockedCount = active?.blockedCount ?: 0,
                        suggestions = if (editingAddress) model.suggestions(addressText) else emptyList(),
                        nowPlaying = nowPlaying,
                        onTextChange = { addressText = it },
                        onEditingChange = { editingAddress = it },
                        onGo = {
                            val url = model.resolveInput(addressText)
                            webViews[activeId]?.loadUrl(url)
                            editingAddress = false
                        },
                        onBack = { webViews[activeId]?.goBack() },
                        onForward = { webViews[activeId]?.goForward() },
                        onReload = {
                            if (active?.loading == true) webViews[activeId]?.stopLoading()
                            else webViews[activeId]?.reload()
                        },
                        onTabs = {
                            // Photograph the tab being left *before* the switcher
                            // covers it: a WebView that is no longer composited
                            // draws as a blank rectangle.
                            captureThumbnail(activeId)
                            showTabs = true
                        },
                        onMenu = { showMenu = true },
                        onAssistant = { model.toggleAssistant() },
                        onSuggestion = { url ->
                            webViews[activeId]?.loadUrl(url)
                            editingAddress = false
                        },
                        onPlayPause = { playingTabId?.let { evaluateMedia(it, "pause") } },
                        onOpenPlaying = { playingTabId?.let { model.activateTab(it) } },
                    )
                }
            ) { padding ->
                Box(Modifier.padding(padding).fillMaxSize()) {
                    if (active != null) {
                        WebViewHost(tabId = active.id, initialUrl = active.url)
                    }
                    // Only while a page is actually fetching. A bar that appears
                    // at 0 and vanishes at 100 on every same-page anchor click is
                    // a flicker, not information.
                    AnimatedVisibility(
                        visible = active?.loading == true && active.progress in 1..99,
                        enter = fadeIn(tween(if (reducedMotion) 0 else 120)),
                        exit = fadeOut(tween(if (reducedMotion) 0 else 220)),
                        modifier = Modifier.align(Alignment.TopCenter),
                    ) {
                        LinearProgressIndicator(
                            progress = { (active?.progress ?: 0) / 100f },
                            modifier = Modifier.fillMaxWidth(),
                            drawStopIndicator = {},
                        )
                    }
                }
            }

            if (showTabs) {
                TabGrid(
                    tabs = tabs,
                    activeId = activeId,
                    thumbnails = thumbnails,
                    onSelect = { model.activateTab(it); showTabs = false },
                    onClose = { id ->
                        thumbnails.remove(id)
                        webViews.remove(id)?.destroy()
                        model.closeTab(id)
                    },
                    onNew = { incognito ->
                        model.newTab(incognito = incognito)
                        showTabs = false
                    },
                    onCloseAll = {
                        // Tear the views down explicitly. `closeTab` only knows
                        // about the model; a WebView left in the map would keep
                        // its renderer process alive with nothing pointing at it.
                        tabs.map { it.id }.forEach { id ->
                            thumbnails.remove(id)
                            webViews.remove(id)?.destroy()
                            model.closeTab(id)
                        }
                        showTabs = false
                    },
                    onDismiss = { showTabs = false },
                )
            }
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
                onShare = {
                    active ?: return@MenuSheet
                    showMenu = false
                    sharePage(active.url, active.title)
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

    /** Hand the current page to whatever the user shares with. */
    private fun sharePage(url: String, title: String) {
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, url)
            putExtra(Intent.EXTRA_TITLE, title)
        }
        startActivity(Intent.createChooser(share, null))
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

        webViewBacking?.let { view.setBackgroundColor(it) }

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

    private companion object {
        /**
         * How many tab thumbnails to keep.
         *
         * At roughly a third scale in RGB_565 each is a few hundred kilobytes,
         * so twelve is single-digit megabytes — enough that the tabs someone
         * actually moves between are always drawn, while a browser left open
         * with forty tabs cannot quietly accumulate a bitmap for each one.
         */
        const val MAX_THUMBNAILS = 12
    }

    private fun isLocalAddress(host: String?): Boolean {
        if (host == null) return false
        return host == "localhost" || host == "127.0.0.1" || host.endsWith(".localhost") ||
            host.startsWith("192.168.") || host.startsWith("10.") ||
            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host)
    }
}
