@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.aether.browser

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.material.icons.filled.Close
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
import dev.aether.browser.ui.LocalReducedMotion

/**
 * The browser's Compose surfaces: bottom bar, tab switcher, menu, now playing
 * and the assistant sheet.
 *
 * Grouped in one file because they share a visual vocabulary and are only
 * meaningful together.
 */

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * A duration that collapses to zero when the device asks for no animation.
 *
 * Every animation in this file goes through it. Scattering
 * `if (reducedMotion)` checks through the composables is how one gets missed,
 * and the one that gets missed is the one someone feels.
 */
@Composable
private fun motion(millis: Int): Int = if (LocalReducedMotion.current) 0 else millis

// ---------------------------------------------------------------------------
// Bottom bar
// ---------------------------------------------------------------------------

/**
 * The bottom bar: omnibox, navigation and the tab counter.
 *
 * At the bottom because on a phone the address bar belongs where thumbs are,
 * not at the top of a six-inch screen. The row collapses to just the omnibox
 * while typing — the navigation buttons are meaningless mid-edit and the
 * space is better spent on suggestions.
 */
@Composable
fun BottomBar(
    text: String,
    editing: Boolean,
    tab: BrowserViewModel.Tab?,
    tabCount: Int,
    blockedCount: Int,
    seedOnly: Boolean,
    suggestions: List<BrowserViewModel.Suggestion>,
    nowPlaying: NowPlaying?,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onReload: () -> Unit,
    onTabs: () -> Unit,
    onMenu: () -> Unit,
    onAssistant: () -> Unit,
    onSuggestion: (String) -> Unit,
    onPlayPause: () -> Unit,
    onOpenPlaying: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.navigationBarsPadding().imePadding()) {

            // Now playing sits directly above the bar, so the thing making
            // noise is next to the controls for it — the same placement the
            // desktop build uses at the foot of its sidebar.
            AnimatedVisibility(
                visible = nowPlaying != null && !editing,
                enter = fadeIn(tween(motion(180))) + expandVertically(tween(motion(180))),
                exit = fadeOut(tween(motion(120))) + shrinkVertically(tween(motion(120))),
            ) {
                nowPlaying?.let {
                    NowPlayingBar(it, onPlayPause = onPlayPause, onOpen = onOpenPlaying)
                }
            }

            // Suggestions sit above the field so they are not under a thumb.
            AnimatedVisibility(
                visible = editing && suggestions.isNotEmpty(),
                enter = fadeIn(tween(motion(120))),
                exit = fadeOut(tween(motion(90))),
            ) {
                Column {
                    LazyColumn(Modifier.heightIn(max = 280.dp)) {
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
                                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                                modifier = Modifier.clickable { onSuggestion(suggestion.url) },
                            )
                        }
                    }
                    HorizontalDivider()
                }
            }

            Omnibox(
                text = text,
                editing = editing,
                tab = tab,
                blockedCount = blockedCount,
                seedOnly = seedOnly,
                onTextChange = onTextChange,
                onEditingChange = onEditingChange,
                onGo = onGo,
                onReload = onReload,
            )

            AnimatedVisibility(
                visible = !editing,
                enter = fadeIn(tween(motion(150))) + expandVertically(tween(motion(150))),
                exit = fadeOut(tween(motion(100))) + shrinkVertically(tween(motion(100))),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onBack, enabled = tab?.canGoBack == true) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                    IconButton(onClick = onForward, enabled = tab?.canGoForward == true) {
                        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = "Forward")
                    }
                    IconButton(onClick = onAssistant) {
                        Icon(Icons.Filled.AutoAwesome, contentDescription = "Assistant")
                    }
                    TabCounter(count = tabCount, onClick = onTabs)
                    IconButton(onClick = onMenu) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "Menu")
                    }
                }
            }
        }
    }
}

/**
 * The address field.
 *
 * A pill rather than an `OutlinedTextField`: the outlined variant's floating
 * label and dense border read as a form field, and an address bar is not one
 * — it is the browser's primary surface and should look like it.
 */
@Composable
private fun Omnibox(
    text: String,
    editing: Boolean,
    tab: BrowserViewModel.Tab?,
    blockedCount: Int,
    seedOnly: Boolean,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    onReload: () -> Unit,
) {
    val focusRequester = remember { FocusRequester() }

    Surface(
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Row(
            Modifier.padding(start = 10.dp, end = 4.dp).heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // The shield doubles as the blocked-count badge: one glyph
            // carrying both "this page is protected" and "by how much".
            if (seedOnly && !editing) {
                // Filter lists have not downloaded. A plain "0 blocked"
                // would read as "this page is clean", which is the opposite
                // of what is happening, so the shield says so instead.
                Icon(
                    Icons.Filled.Shield,
                    contentDescription = "Limited protection — filter lists have not downloaded",
                    tint = MaterialTheme.colorScheme.error,
                )
            } else if (blockedCount > 0 && !editing) {
                BadgedBox(badge = { Badge { Text("$blockedCount") } }) {
                    Icon(
                        Icons.Filled.Shield,
                        contentDescription = "$blockedCount trackers blocked",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            } else {
                val secure = tab?.url?.startsWith("https://") == true
                Icon(
                    when {
                        editing -> Icons.Filled.Search
                        secure -> Icons.Filled.Lock
                        else -> Icons.Filled.Public
                    },
                    // Not "secure": a padlock means the transport is
                    // encrypted, which is a much narrower claim than the one
                    // users hear, and saying the narrower thing is the point.
                    contentDescription = if (secure) "Encrypted connection" else null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.width(10.dp))

            BasicTextFieldRow(
                text = text,
                editing = editing,
                onTextChange = onTextChange,
                onEditingChange = onEditingChange,
                onGo = onGo,
                focusRequester = focusRequester,
                modifier = Modifier.weight(1f),
            )

            IconButton(onClick = onReload) {
                Icon(
                    if (tab?.loading == true) Icons.Filled.Close else Icons.Filled.Refresh,
                    contentDescription = if (tab?.loading == true) "Stop loading" else "Reload",
                )
            }
        }
    }
}

/**
 * The editable part of the omnibox.
 *
 * Split out because the interesting behaviour is here: while not editing the
 * field shows the *host* in full strength and the rest dimmed, which is the
 * single most useful anti-phishing affordance a browser has — the part of a
 * URL that identifies who you are talking to should not be the part that
 * scrolls off the end.
 */
@Composable
private fun BasicTextFieldRow(
    text: String,
    editing: Boolean,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    focusRequester: FocusRequester,
    modifier: Modifier = Modifier,
) {
    TextField(
        value = text,
        onValueChange = onTextChange,
        modifier = modifier
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
            // The pill is the container; a second underline inside it is
            // visual noise.
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
        ),
        keyboardOptions = KeyboardOptions(
            imeAction = ImeAction.Go,
            autoCorrectEnabled = false,
        ),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
    )
}

/**
 * The tab counter.
 *
 * A number in a rounded square, as every mobile browser draws it — a generic
 * "tabs" glyph tells you nothing, and the count is the one piece of state
 * worth a permanent place on the bar.
 */
@Composable
private fun TabCounter(count: Int, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Box(
            Modifier
                .size(24.dp)
                .clip(RoundedCornerShape(7.dp))
                .background(MaterialTheme.colorScheme.onSurfaceVariant)
                .semantics { contentDescription = "$count open tabs" },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                // Past 99 the glyph stops being a number and becomes a
                // reproach, which is roughly the right message.
                if (count > 99) "∞" else "$count",
                color = MaterialTheme.colorScheme.surfaceContainer,
                fontSize = if (count > 9) 11.sp else 13.sp,
                fontWeight = FontWeight.Bold,
            )
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
            Modifier.padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
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
 * The tab switcher: a grid of page thumbnails.
 *
 * A list of titles and URLs — which is what this was — is the wrong shape for
 * the actual question being asked. Nobody looks for "the tab titled
 * *Untitled*"; they look for the one that *looked* like the thing they were
 * reading. The thumbnail is the entire point of the screen.
 *
 * Full screen rather than a bottom sheet, for the same reason: a sheet caps
 * itself at half the display, so a grid inside one shows four tabs and a
 * scrollbar.
 */
@Composable
fun TabGrid(
    tabs: List<BrowserViewModel.Tab>,
    activeId: Long,
    thumbnails: Map<Long, ImageBitmap>,
    onSelect: (Long) -> Unit,
    onClose: (Long) -> Unit,
    onNew: (incognito: Boolean) -> Unit,
    onCloseAll: () -> Unit,
    onDismiss: () -> Unit,
) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surfaceDim) {
        Column(Modifier.statusBarsPadding().navigationBarsPadding()) {
            TopAppBar(
                title = { Text("${tabs.size} ${if (tabs.size == 1) "tab" else "tabs"}") },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Filled.Close, contentDescription = "Close tab switcher")
                    }
                },
                actions = {
                    IconButton(onClick = { onNew(true) }) {
                        Icon(Icons.Filled.VisibilityOff, contentDescription = "New private tab")
                    }
                    IconButton(onClick = onCloseAll, enabled = tabs.isNotEmpty()) {
                        Icon(Icons.Filled.Description, contentDescription = "Close all tabs")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceDim,
                ),
            )

            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 164.dp),
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(tabs, key = { it.id }) { tab ->
                    TabCard(
                        tab = tab,
                        active = tab.id == activeId,
                        thumbnail = thumbnails[tab.id],
                        onSelect = { onSelect(tab.id) },
                        onClose = { onClose(tab.id) },
                    )
                }
            }

            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    horizontalArrangement = Arrangement.Center,
                ) {
                    FilledTonalButton(onClick = { onNew(false) }) {
                        Icon(Icons.Filled.Add, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("New tab")
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
        // the thumbnail underneath it, which is the content that matters.
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
                    // A tab restored from the last session has never been
                    // rendered, so there is nothing to show but its address.
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
    onDismiss: () -> Unit,
    onBookmark: () -> Unit,
    onNotes: () -> Unit,
    onIncognito: () -> Unit,
    onShare: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            // The three most common actions as a row of targets rather than
            // list rows: they are reached by muscle memory, and a row puts
            // all three within one thumb's reach.
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                QuickAction(Icons.Filled.Star, "Bookmark", onBookmark)
                QuickAction(Icons.Filled.Share, "Share", onShare)
                QuickAction(Icons.Filled.VisibilityOff, "Private tab", onIncognito)
            }
            HorizontalDivider()
            MenuRow(Icons.Filled.Description, "Generate notes from this page", onNotes)
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
            .padding(horizontal = 18.dp, vertical = 10.dp),
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
                            // author, which is what makes a transcript
                            // readable without reading it.
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
