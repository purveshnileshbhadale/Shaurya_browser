@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.shaurya.browser.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.shaurya.browser.data.Bookmark
import dev.shaurya.browser.data.HistoryEntry
import dev.shaurya.browser.data.Settings

/** One row of a saved-pages list. */
@Composable
private fun EntryRow(
    title: String,
    url: String,
    onOpen: () -> Unit,
    onRemove: () -> Unit,
    removeLabel: String,
) {
    ListItem(
        headlineContent = { Text(title.ifBlank { url }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = { Text(url, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = {
            IconButton(onClick = onRemove) {
                Icon(Icons.Filled.Close, contentDescription = "$removeLabel ${title.ifBlank { url }}")
            }
        },
        modifier = Modifier.clickable(onClick = onOpen),
    )
}

@Composable
fun HistorySheet(
    entries: List<HistoryEntry>,
    onOpen: (String) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().heightIn(min = 240.dp)) {
            SheetHeader(
                title = "History",
                // Destructive, so it is a text button rather than an icon:
                // "Clear all" said in words is much harder to hit by accident
                // than a bin glyph next to a scrolling list.
                action = { TextButton(onClick = onClear, enabled = entries.isNotEmpty()) { Text("Clear all") } },
            )
            if (entries.isEmpty()) {
                EmptyNote("Nothing here yet. Pages you visit will appear in this list.")
            } else {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(entries, key = { it.url }) { entry ->
                        ListItem(
                            headlineContent = {
                                Text(entry.title.ifBlank { entry.url }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            supportingContent = {
                                Text(entry.url, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            leadingContent = { Icon(Icons.Filled.History, contentDescription = null) },
                            modifier = Modifier.clickable { onOpen(entry.url) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun BookmarksSheet(
    bookmarks: List<Bookmark>,
    onOpen: (String) -> Unit,
    onRemove: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().heightIn(min = 240.dp)) {
            SheetHeader(title = "Bookmarks")
            if (bookmarks.isEmpty()) {
                EmptyNote("No bookmarks yet. Tap the bookmark button to save a page.")
            } else {
                LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(bookmarks, key = { it.id }) { bookmark ->
                        EntryRow(
                            title = bookmark.title,
                            url = bookmark.url,
                            onOpen = { onOpen(bookmark.url) },
                            onRemove = { onRemove(bookmark.id) },
                            removeLabel = "Remove bookmark",
                        )
                    }
                }
            }
        }
    }
}

/**
 * Settings.
 *
 * Only the switches that actually do something are here. A settings screen
 * listing options the build does not honour is worse than a short one, and
 * every row below maps to a field the browser reads at request time.
 */
@Composable
fun SettingsSheet(
    settings: Settings,
    onChange: ((Settings) -> Settings) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().heightIn(min = 300.dp)) {
            SheetHeader(title = "Settings")

            SectionLabel("Privacy")
            SwitchRow(
                "Block ads and trackers",
                "Requests are cancelled before they leave the device",
                settings.adblockEnabled,
            ) { on -> onChange { it.copy(adblockEnabled = on) } }
            SwitchRow(
                "Upgrade connections to HTTPS",
                "Retry http:// pages over an encrypted connection",
                settings.httpsOnly,
            ) { on -> onChange { it.copy(httpsOnly = on) } }
            SwitchRow(
                "Block third-party cookies",
                "Stops sites reading cookies set by other sites",
                settings.blockThirdPartyCookies,
            ) { on -> onChange { it.copy(blockThirdPartyCookies = on) } }
            SwitchRow(
                "Send Global Privacy Control",
                "Asks sites not to sell or share your data",
                settings.sendGpc,
            ) { on -> onChange { it.copy(sendGpc = on) } }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionLabel("Search engine")
            Text(
                "Shaurya answers calculations and conversions on the device and "
                    + "searches your own history and bookmarks, then offers to "
                    + "hand the query to a web provider. It has no web index of "
                    + "its own.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp),
            )
            ChoiceRow(
                options = listOf(
                    "shaurya" to "Shaurya",
                    "duckduckgo" to "DuckDuckGo",
                    "startpage" to "Startpage",
                    "brave" to "Brave Search",
                    "google" to "Google",
                ),
                selected = settings.searchEngine,
            ) { value -> onChange { it.copy(searchEngine = value) } }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionLabel("Appearance")
            ChoiceRow(
                options = listOf("system" to "System", "light" to "Light", "dark" to "Dark"),
                selected = settings.theme,
            ) { value -> onChange { it.copy(theme = value) } }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            SectionLabel("Tabs")
            SwitchRow(
                "Reopen tabs on launch",
                "Restores the tabs you had open last time",
                settings.restoreTabs,
            ) { on -> onChange { it.copy(restoreTabs = on) } }

            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SheetHeader(title: String, action: @Composable (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        action?.invoke()
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 2.dp),
    )
}

@Composable
private fun EmptyNote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(20.dp),
    )
}

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(subtitle, style = MaterialTheme.typography.bodySmall) },
        trailingContent = { Switch(checked = checked, onCheckedChange = onChange) },
        // The whole row toggles, not just the switch: a 32dp switch is a
        // small target next to a full-width row that looks tappable.
        modifier = Modifier.clickable { onChange(!checked) },
    )
}

@Composable
private fun ChoiceRow(
    options: List<Pair<String, String>>,
    selected: String,
    onPick: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { (value, label) ->
            FilterChip(
                selected = value == selected,
                onClick = { onPick(value) },
                label = { Text(label, style = MaterialTheme.typography.labelMedium) },
                leadingIcon = if (value == selected) {
                    { Icon(Icons.Filled.Star, contentDescription = null, modifier = Modifier.size(14.dp)) }
                } else null,
            )
        }
    }
}
