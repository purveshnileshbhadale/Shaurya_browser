package dev.aether.browser

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Tab
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The browser's Compose surfaces: bottom toolbar, tab switcher, menu and the
 * assistant sheet.
 *
 * Grouped in one file because they share a visual vocabulary and are only
 * meaningful together.
 */

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Toolbar(
    text: String,
    editing: Boolean,
    tab: BrowserViewModel.Tab?,
    blockedCount: Int,
    suggestions: List<BrowserViewModel.Suggestion>,
    onTextChange: (String) -> Unit,
    onEditingChange: (Boolean) -> Unit,
    onGo: () -> Unit,
    onBack: () -> Unit,
    onReload: () -> Unit,
    onTabs: () -> Unit,
    onMenu: () -> Unit,
    onAssistant: () -> Unit,
    onSuggestion: (String) -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.navigationBarsPadding().imePadding()) {

            // Suggestions sit above the field so they are not under a thumb.
            if (editing && suggestions.isNotEmpty()) {
                LazyColumn(Modifier.heightIn(max = 260.dp)) {
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
                                        else -> Icons.Filled.History
                                    },
                                    contentDescription = null,
                                )
                            },
                            modifier = Modifier.clickable { onSuggestion(suggestion.url) },
                        )
                    }
                }
                HorizontalDivider()
            }

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack, enabled = tab?.canGoBack == true) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                }

                OutlinedTextField(
                    value = text,
                    onValueChange = onTextChange,
                    modifier = Modifier
                        .weight(1f)
                        .onFocusChanged { onEditingChange(it.isFocused) },
                    singleLine = true,
                    shape = RoundedCornerShape(24.dp),
                    placeholder = { Text("Search or enter address") },
                    leadingIcon = {
                        // The shield doubles as the blocked-count badge.
                        if (blockedCount > 0) {
                            BadgedBox(badge = { Badge { Text("$blockedCount") } }) {
                                Icon(Icons.Filled.Shield, contentDescription = "Trackers blocked")
                            }
                        } else {
                            Icon(
                                if (tab?.url?.startsWith("https://") == true) Icons.Filled.Lock
                                else Icons.Filled.Public,
                                contentDescription = null,
                            )
                        }
                    },
                    trailingIcon = {
                        IconButton(onClick = onReload) {
                            Icon(
                                if (tab?.loading == true) Icons.Filled.Close else Icons.Filled.Refresh,
                                contentDescription = if (tab?.loading == true) "Stop" else "Reload",
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { onGo() }),
                )

                IconButton(onClick = onAssistant) {
                    Icon(Icons.Filled.AutoAwesome, contentDescription = "Assistant")
                }
                IconButton(onClick = onTabs) {
                    Icon(Icons.Filled.Tab, contentDescription = "Tabs")
                }
                IconButton(onClick = onMenu) {
                    Icon(Icons.Filled.MoreVert, contentDescription = "Menu")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tab switcher
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TabSheet(
    tabs: List<BrowserViewModel.Tab>,
    activeId: Long,
    onSelect: (Long) -> Unit,
    onClose: (Long) -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Tabs", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = onNew) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Spacer(Modifier.width(6.dp))
                Text("New tab")
            }
        }

        LazyColumn(Modifier.heightIn(max = 420.dp)) {
            items(tabs, key = { it.id }) { tab ->
                ListItem(
                    headlineContent = {
                        Text(tab.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    supportingContent = {
                        Text(tab.url, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    leadingContent = {
                        Icon(
                            if (tab.incognito) Icons.Filled.VisibilityOff else Icons.Filled.Language,
                            contentDescription = null,
                        )
                    },
                    trailingContent = {
                        IconButton(onClick = { onClose(tab.id) }) {
                            Icon(Icons.Filled.Close, contentDescription = "Close tab")
                        }
                    },
                    colors = if (tab.id == activeId) {
                        ListItemDefaults.colors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer
                        )
                    } else {
                        ListItemDefaults.colors()
                    },
                    modifier = Modifier.clickable { onSelect(tab.id) },
                )
            }
        }
        Spacer(Modifier.navigationBarsPadding())
    }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MenuSheet(
    tab: BrowserViewModel.Tab?,
    onDismiss: () -> Unit,
    onBookmark: () -> Unit,
    onNotes: () -> Unit,
    onIncognito: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            MenuRow(Icons.Filled.Star, "Bookmark this page", onBookmark)
            MenuRow(Icons.Filled.Description, "Generate notes from this page", onNotes)
            MenuRow(Icons.Filled.VisibilityOff, "New private tab", onIncognito)
            HorizontalDivider()
            if (tab != null) {
                ListItem(
                    headlineContent = { Text("Trackers blocked here") },
                    trailingContent = { Text("${tab.blockedCount}") },
                )
            }
        }
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

@OptIn(ExperimentalMaterial3Api::class)
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
                Icon(Icons.Filled.AutoAwesome, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(
                    "Assistant",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onClear) { Text("Clear") }
            }

            if (state.messages.isEmpty()) {
                Column(Modifier.padding(20.dp)) {
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
                            shape = RoundedCornerShape(14.dp),
                            color = if (isUser) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.widthIn(max = 300.dp),
                        ) {
                            Text(
                                message.text.ifBlank { "…" },
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
                                color = if (isUser) MaterialTheme.colorScheme.onPrimary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 14.sp,
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
