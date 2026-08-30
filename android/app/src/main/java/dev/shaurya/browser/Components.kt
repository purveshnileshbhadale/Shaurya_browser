@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.shaurya.browser

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.shaurya.browser.ui.Ink
import dev.shaurya.browser.ui.LocalReducedMotion
import dev.shaurya.browser.ui.ShieldButton

/**
 * The browser's Compose surfaces.
 *
 * The layout follows the shape mobile browsers have converged on, because it
 * is what people already know how to use: the address bar and the identity of
 * the page at the top, and the controls the thumb reaches for at the bottom.
 * The previous arrangement put everything in one crowded bottom strip, which
 * meant the URL — the single most important piece of information on screen —
 * competed for space with five buttons.
 */

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * A duration that collapses to zero when the device asks for no animation.
 *
 * Every animation in this file goes through it. Scattering
 * `if (reducedMotion)` checks around is how one gets missed, and the one that
 * gets missed is the one someone feels.
 */
@Composable
private fun motion(millis: Int): Int = if (LocalReducedMotion.current) 0 else millis

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

/**
 * The address bar, at the top.
 *
 * Everything here answers "what am I looking at, and is it safe": the shield
 * with its count, the lock, the address itself. Actions live at the bottom.
 */
@Composable
fun TopBar(
    text: String,
    editing: Boolean,
    tab: BrowserViewModel.Tab?,
    tabCount: Int,
    blockedCount: Int,
    shieldsOnHere: Boolean,
    seedOnly: Boolean,
    minimal: Boolean,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    onReload: () -> Unit,
    onShields: () -> Unit,
    onTabs: () -> Unit,
    onMenu: () -> Unit,
) {
    // The address bar is at the top on every screen, the start page included.
    // Over the start page it is transparent so the backdrop runs behind it;
    // over a web page it needs an opaque surface, because the content under
    // it is arbitrary.
    if (minimal) {
        Row(
            Modifier.statusBarsPadding().fillMaxWidth().padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Omnibox(
                text = text,
                editing = editing,
                tab = tab,
                translucent = true,
                onTextChange = onTextChange,
                onEditingChange = onEditingChange,
                onGo = onGo,
                onReload = onReload,
                modifier = Modifier.weight(1f),
            )
            TabCounter(count = tabCount, onClick = onTabs, tint = Ink.Dim)
            IconButton(onClick = onMenu) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Menu", tint = Ink.Dim)
            }
        }
        return
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            Modifier
                .statusBarsPadding()
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ShieldButton(
                blocked = blockedCount,
                enabledHere = shieldsOnHere,
                seedOnly = seedOnly,
                onClick = onShields,
            )

            Omnibox(
                text = text,
                editing = editing,
                tab = tab,
                onTextChange = onTextChange,
                onEditingChange = onEditingChange,
                onGo = onGo,
                onReload = onReload,
                modifier = Modifier.weight(1f),
            )

            TabCounter(count = tabCount, onClick = onTabs)
            IconButton(onClick = onMenu) {
                Icon(Icons.Filled.MoreVert, contentDescription = "Menu")
            }
        }
    }
}

/**
 * The address field.
 *
 * A pill rather than an `OutlinedTextField`: the outlined variant's floating
 * label and dense border read as a form field, and an address bar is the
 * browser's primary surface, not a form.
 */
@Composable
private fun Omnibox(
    text: String,
    editing: Boolean,
    tab: BrowserViewModel.Tab?,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    onReload: () -> Unit,
    modifier: Modifier = Modifier,
    translucent: Boolean = false,
) {
    val focusRequester = remember { FocusRequester() }

    Surface(
        shape = RoundedCornerShape(24.dp),
        color = if (translucent) Ink.Glass else MaterialTheme.colorScheme.surfaceContainerHighest,
        border = if (translucent) BorderStroke(1.dp, Ink.Hairline) else null,
        modifier = modifier.padding(horizontal = 4.dp),
    ) {
        Row(
            Modifier.padding(start = 12.dp, end = 2.dp).heightIn(min = 42.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val secure = tab?.url?.startsWith("https://") == true
            Icon(
                when {
                    editing -> Icons.Filled.Search
                    secure -> Icons.Filled.Lock
                    else -> Icons.Filled.Public
                },
                // Not "secure": a padlock means the transport is encrypted,
                // which is a far narrower claim than the one users hear, and
                // saying the narrower thing is the point.
                contentDescription = if (secure) "Encrypted connection" else null,
                modifier = Modifier.size(16.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(8.dp))

            TextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focusRequester)
                    .onFocusChanged { onEditingChange(it.isFocused) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge,
                placeholder = {
                    Text("Search or enter address", style = MaterialTheme.typography.bodyLarge)
                },
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    // The pill is the container; an underline inside it is noise.
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                ),
                keyboardOptions = KeyboardOptions(
                    imeAction = ImeAction.Go,
                    autoCorrectEnabled = false,
                ),
                keyboardActions = KeyboardActions(onGo = { onGo() }),
            )

            IconButton(onClick = onReload, modifier = Modifier.size(38.dp)) {
                Icon(
                    if (tab?.loading == true) Icons.Filled.Close else Icons.Filled.Refresh,
                    contentDescription = if (tab?.loading == true) "Stop loading" else "Reload",
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/**
 * The tab counter.
 *
 * A number in a rounded square, as every mobile browser draws it — a generic
 * "tabs" glyph tells you nothing, and the count is the one piece of state
 * worth a permanent place on the bar.
 */
@Composable
private fun TabCounter(count: Int, onClick: () -> Unit, tint: Color? = null) {
    IconButton(onClick = onClick) {
        // Outlined over the backdrop, filled over the chrome: a filled square
        // needs a known surface behind it to punch its number out of, and the
        // start page has a gradient there instead.
        val outline = tint != null
        Box(
            Modifier
                .size(if (outline) 24.dp else 22.dp)
                .clip(RoundedCornerShape(if (outline) 7.dp else 6.dp))
                .then(
                    if (outline) Modifier.border(1.8.dp, tint!!, RoundedCornerShape(7.dp))
                    else Modifier.background(MaterialTheme.colorScheme.onSurfaceVariant)
                )
                .semantics { contentDescription = "$count open tabs" },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                // Past 99 the glyph stops being a number and becomes a
                // reproach, which is roughly the right message.
                if (count > 99) "∞" else "$count",
                color = tint ?: MaterialTheme.colorScheme.surfaceContainer,
                fontSize = if (count > 9) 10.sp else 12.sp,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Bottom navigation
// ---------------------------------------------------------------------------

/**
 * The controls, where the thumb is.
 *
 * Five targets, evenly spread, each a real destination rather than a mode
 * switch. Now playing rides above them so the thing making noise sits next to
 * the controls for it.
 */
@Composable
fun BottomNav(
    tab: BrowserViewModel.Tab?,
    nowPlaying: NowPlaying?,
    bookmarked: Boolean,
    floating: Boolean,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onNewTab: () -> Unit,
    onBookmark: () -> Unit,
    onHistory: () -> Unit,
    onPlayPause: () -> Unit,
    onOpenPlaying: () -> Unit,
) {
    // Floating only over the start page, where the backdrop behind it is
    // ours. Over a web page the content is arbitrary — a translucent pill on
    // top of someone's white article is unreadable — so there it stays a
    // solid bar.
    if (floating) {
        Column(Modifier.navigationBarsPadding()) {
            nowPlaying?.let {
                Box(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
                    NowPlayingBar(it, onPlayPause = onPlayPause, onOpen = onOpenPlaying)
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 14.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                Row(
                    Modifier
                        .clip(RoundedCornerShape(30.dp))
                        .background(Ink.GlassStrong)
                        .border(1.dp, Ink.Hairline, RoundedCornerShape(30.dp))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    NavIcon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tab?.canGoBack == true, onBack)
                    NavIcon(Icons.AutoMirrored.Filled.ArrowForward, "Forward", tab?.canGoForward == true, onForward)
                    // The one action with its own colour, because it is the
                    // one the start page exists to invite.
                    Box(
                        Modifier
                            .padding(horizontal = 4.dp)
                            .size(46.dp, 40.dp)
                            .clip(RoundedCornerShape(15.dp))
                            .background(Brush.linearGradient(listOf(Ink.NewTabStart, Ink.NewTabEnd)))
                            .clickable(onClick = onNewTab),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = "New tab", tint = Color.White)
                    }
                    NavIcon(
                        if (bookmarked) Icons.Filled.Star else Icons.Filled.Bookmark,
                        if (bookmarked) "Bookmarked" else "Bookmark this page",
                        tab != null, onBookmark,
                    )
                    NavIcon(Icons.Filled.History, "History", true, onHistory)
                }
            }
        }
        return
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.navigationBarsPadding()) {
            AnimatedVisibility(
                visible = nowPlaying != null,
                enter = fadeIn(tween(motion(180))) + expandVertically(tween(motion(180))),
                exit = fadeOut(tween(motion(120))) + shrinkVertically(tween(motion(120))),
            ) {
                nowPlaying?.let {
                    NowPlayingBar(it, onPlayPause = onPlayPause, onOpen = onOpenPlaying)
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack, enabled = tab?.canGoBack == true) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
                IconButton(onClick = onForward, enabled = tab?.canGoForward == true) {
                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "Forward")
                }
                IconButton(onClick = onNewTab) {
                    Icon(Icons.Filled.Add, contentDescription = "New tab")
                }
                IconButton(onClick = onBookmark, enabled = tab != null) {
                    Icon(
                        if (bookmarked) Icons.Filled.Star else Icons.Filled.Bookmark,
                        contentDescription = if (bookmarked) "Bookmarked" else "Bookmark this page",
                        tint = if (bookmarked) MaterialTheme.colorScheme.primary
                        else LocalContentColor.current,
                    )
                }
                IconButton(onClick = onHistory) {
                    Icon(Icons.Filled.History, contentDescription = "History")
                }
            }
        }
    }
}

@Composable
private fun NavIcon(
    icon: ImageVector,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(46.dp, 40.dp)) {
        Icon(
            icon,
            contentDescription = label,
            tint = if (enabled) Ink.Primary else Ink.Faint.copy(alpha = 0.45f),
        )
    }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * The address-bar suggestion list.
 *
 * Drawn over the page, directly under the bar it belongs to, so the
 * relationship between what is typed and what is offered is unambiguous.
 */
@Composable
fun SuggestionList(
    suggestions: List<BrowserViewModel.Suggestion>,
    onPick: (String) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        LazyColumn(Modifier.heightIn(max = 360.dp)) {
            items(suggestions, key = { it.url }) { suggestion ->
                ListItem(
                    headlineContent = {
                        Text(suggestion.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    supportingContent = {
                        Text(suggestion.url, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    leadingContent = {
                        Icon(
                            when (suggestion.kind) {
                                BrowserViewModel.SuggestionKind.BOOKMARK -> Icons.Filled.Star
                                BrowserViewModel.SuggestionKind.SEARCH -> Icons.Filled.Search
                                else -> Icons.Filled.History
                            },
                            contentDescription = null,
                        )
                    },
                    modifier = Modifier.clickable { onPick(suggestion.url) },
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Now playing
// ---------------------------------------------------------------------------

/** What the media watcher last reported, ready to draw. */
data class NowPlaying(
    val tabId: Long,
    val title: String,
    val artist: String,
    val playing: Boolean,
)

@Composable
private fun NowPlayingBar(state: NowPlaying, onPlayPause: () -> Unit, onOpen: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onOpen),
    ) {
        Row(
            Modifier.padding(start = 16.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.MusicNote, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    state.title.ifBlank { "Playing" },
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (state.artist.isNotBlank()) {
                    Text(
                        state.artist,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            IconButton(onClick = onPlayPause) {
                Icon(
                    if (state.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (state.playing) "Pause" else "Play",
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tab switcher
// ---------------------------------------------------------------------------

/**
 * The tab switcher: a grid of page thumbnails, split by privacy.
 *
 * A list of titles and URLs is the wrong shape for the question being asked.
 * Nobody looks for "the tab titled *Untitled*"; they look for the one that
 * *looked* like the thing they were reading. The thumbnail is the screen.
 *
 * Regular and private tabs are separate views rather than one mixed list,
 * because "which of these is private" is not something anyone should have to
 * work out from a small icon.
 */
@Composable
fun TabGrid(
    tabs: List<BrowserViewModel.Tab>,
    activeId: Long,
    thumbnails: Map<Long, ImageBitmap>,
    onSelect: (Long) -> Unit,
    onClose: (Long) -> Unit,
    onNew: (incognito: Boolean) -> Unit,
    onCloseAll: (incognito: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    // Open on whichever kind the current tab is, so the switcher never lands
    // on an empty screen while tabs are plainly open.
    var showingPrivate by remember {
        mutableStateOf(tabs.firstOrNull { it.id == activeId }?.incognito == true)
    }
    val shown = tabs.filter { it.incognito == showingPrivate }
    val privateCount = tabs.count { it.incognito }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceDim) {
        Column(Modifier.statusBarsPadding().navigationBarsPadding()) {

            Row(
                Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Filled.Close, contentDescription = "Close tab switcher")
                }
                SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                    SegmentedButton(
                        selected = !showingPrivate,
                        onClick = { showingPrivate = false },
                        shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    ) { Text("Tabs (${tabs.size - privateCount})") }
                    SegmentedButton(
                        selected = showingPrivate,
                        onClick = { showingPrivate = true },
                        shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    ) { Text("Private ($privateCount)") }
                }
                IconButton(
                    onClick = { onCloseAll(showingPrivate) },
                    enabled = shown.isNotEmpty(),
                ) {
                    Icon(Icons.Filled.DeleteSweep, contentDescription = "Close all shown tabs")
                }
            }

            if (shown.isEmpty()) {
                Column(
                    Modifier.weight(1f).fillMaxWidth(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        if (showingPrivate) Icons.Filled.VisibilityOff else Icons.Filled.Language,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        if (showingPrivate) "No private tabs open" else "No tabs open",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(minSize = 164.dp),
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(shown, key = { it.id }) { tab ->
                        TabCard(
                            tab = tab,
                            active = tab.id == activeId,
                            thumbnail = thumbnails[tab.id],
                            onSelect = { onSelect(tab.id) },
                            onClose = { onClose(tab.id) },
                        )
                    }
                }
            }

            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    FilledTonalButton(onClick = { onNew(showingPrivate) }) {
                        Icon(
                            if (showingPrivate) Icons.Filled.VisibilityOff else Icons.Filled.Add,
                            contentDescription = null,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(if (showingPrivate) "New private tab" else "New tab")
                    }
                }
            }
        }
    }
}

@Composable
private fun TabCard(
    tab: BrowserViewModel.Tab,
    active: Boolean,
    thumbnail: ImageBitmap?,
    onSelect: () -> Unit,
    onClose: () -> Unit,
) {
    Card(
        onClick = onSelect,
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (tab.incognito) MaterialTheme.colorScheme.inverseSurface
            else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = if (tab.incognito) MaterialTheme.colorScheme.inverseOnSurface
            else MaterialTheme.colorScheme.onSurface,
        ),
        // The active tab is outlined rather than tinted: a tint would fight
        // the thumbnail underneath, which is the content that matters.
        border = if (active) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
    ) {
        Column {
            Row(
                Modifier.padding(start = 10.dp, end = 2.dp, top = 4.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    if (tab.incognito) Icons.Filled.VisibilityOff else Icons.Filled.Language,
                    contentDescription = if (tab.incognito) "Private tab" else null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    tab.title.ifBlank { tab.url },
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onClose, modifier = Modifier.size(30.dp)) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Close ${tab.title.ifBlank { tab.url }}",
                        modifier = Modifier.size(15.dp),
                    )
                }
            }

            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(0.78f)
                    .clip(RoundedCornerShape(bottomStart = 14.dp, bottomEnd = 14.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerLowest),
                contentAlignment = Alignment.Center,
            ) {
                if (thumbnail != null) {
                    Image(
                        bitmap = thumbnail,
                        // The title above already names the tab; describing
                        // the image too makes a screen reader say it twice.
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        // Crop from the top: a page's identity is in its
                        // header, and letterboxing wastes the card.
                        contentScale = ContentScale.Crop,
                        alignment = Alignment.TopCenter,
                    )
                } else {
                    Text(
                        hostOf(tab.url),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
        }
    }
}

/** The part of a URL worth showing when there is no thumbnail. */
private fun hostOf(url: String): String = url
    .substringAfter("://", url)
    .substringBefore('/')
    .removePrefix("www.")
    .ifBlank { url }

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

@Composable
fun MenuSheet(
    tab: BrowserViewModel.Tab?,
    bookmarked: Boolean,
    onDismiss: () -> Unit,
    onBookmark: () -> Unit,
    onNotes: () -> Unit,
    onIncognito: () -> Unit,
    onShare: () -> Unit,
    onHistory: () -> Unit,
    onSettings: () -> Unit,
    onModes: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            // The most common actions as a row of targets rather than list
            // rows: they are reached by muscle memory, and a row puts them
            // all within one thumb's reach.
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                QuickAction(
                    if (bookmarked) Icons.Filled.Star else Icons.Filled.Bookmark,
                    if (bookmarked) "Saved" else "Bookmark",
                    onBookmark,
                )
                QuickAction(Icons.Filled.Share, "Share", onShare)
                QuickAction(Icons.Filled.VisibilityOff, "Private", onIncognito)
                QuickAction(Icons.Filled.AutoAwesome, "Notes", onNotes)
            }
            HorizontalDivider()
            MenuRow(Icons.Filled.AutoAwesome, "Modes", onModes)
            MenuRow(Icons.Filled.History, "History", onHistory)
            MenuRow(Icons.Filled.Settings, "Settings", onSettings)
            if (tab != null) {
                ListItem(
                    headlineContent = { Text("Trackers blocked here") },
                    leadingContent = { Icon(Icons.Filled.Shield, contentDescription = null) },
                    trailingContent = {
                        Text(
                            "${tab.blockedCount}",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    },
                )
            }
        }
    }
}

@Composable
private fun QuickAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    Column(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null)
        Spacer(Modifier.height(6.dp))
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun MenuRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        leadingContent = { Icon(icon, contentDescription = null) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

@Composable
fun AssistantSheet(
    state: BrowserViewModel.AssistantState,
    onDismiss: () -> Unit,
    onSend: (String) -> Unit,
    onClear: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().heightIn(min = 320.dp)) {

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.AutoAwesome,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "Assistant",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onClear, enabled = state.messages.isNotEmpty()) { Text("Clear") }
            }

            if (state.messages.isEmpty()) {
                Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) {
                    Text(
                        "Ask about the page you are reading. Its text is sent to the model "
                            + "for this request only.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
                    Row {
                        AssistChip(
                            onClick = { onSend("Summarise this page") },
                            label = { Text("Summarise") },
                        )
                        Spacer(Modifier.width(8.dp))
                        AssistChip(
                            onClick = { onSend("What are the key points?") },
                            label = { Text("Key points") },
                        )
                    }
                }
            }

            LazyColumn(
                Modifier
                    .weight(1f, fill = false)
                    .heightIn(max = 380.dp)
                    .padding(horizontal = 16.dp)
            ) {
                items(state.messages) { message ->
                    val isUser = message.role == "user"
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 5.dp),
                        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
                    ) {
                        Surface(
                            // Asymmetric corners point each bubble at its
                            // author, which makes a transcript readable
                            // without reading it.
                            shape = if (isUser) {
                                RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp)
                            } else {
                                RoundedCornerShape(18.dp, 18.dp, 18.dp, 4.dp)
                            },
                            color = if (isUser) MaterialTheme.colorScheme.primaryContainer
                            else MaterialTheme.colorScheme.surfaceContainerHigh,
                            contentColor = if (isUser) MaterialTheme.colorScheme.onPrimaryContainer
                            else MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.widthIn(max = 300.dp),
                        ) {
                            Text(
                                message.text.ifBlank { "…" },
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }
            }

            state.error?.let { error ->
                Text(
                    error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                )
            }

            Row(
                Modifier.fillMaxWidth().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Ask about this page…") },
                    shape = RoundedCornerShape(22.dp),
                    maxLines = 4,
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = {
                        if (draft.isNotBlank()) {
                            onSend(draft.trim())
                            draft = ""
                        }
                    },
                    enabled = !state.busy && draft.isNotBlank(),
                ) {
                    if (state.busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Filled.Send, contentDescription = "Send")
                    }
                }
            }
        }
    }
}
