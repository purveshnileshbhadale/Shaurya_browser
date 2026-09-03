@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.shaurya.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.shaurya.browser.Radii
import dev.shaurya.browser.data.Snippet
import dev.shaurya.browser.tools.Citations
import dev.shaurya.browser.tools.FocusTimer
import dev.shaurya.browser.tools.Json
import dev.shaurya.browser.tools.Prompter
import dev.shaurya.browser.tools.Reader
import kotlinx.coroutines.delay

/** A sheet header with a title and an optional trailing action. */
@Composable
private fun ToolHeader(title: String, subtitle: String? = null) {
    Column(Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        subtitle?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Reader view.
 *
 * The article arrives already extracted, because only the page can reach its
 * own DOM. When extraction came back with almost nothing, this says so and
 * offers the page back rather than showing a blank sheet dressed up as an
 * article — the heuristic loses on some layouts, and hiding that would make
 * the loss look like the page's fault.
 */
@Composable
fun ReaderSheet(
    article: Reader.Article?,
    loading: Boolean,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().heightIn(min = 300.dp)) {
            when {
                loading -> Box(
                    Modifier.fillMaxWidth().padding(40.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }

                article == null || Reader.looksEmpty(article) -> Column(
                    Modifier.padding(20.dp)
                ) {
                    Text("Nothing to read here", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Reader looks for the block of a page that is mostly " +
                            "sentences. This page does not have one it could find " +
                            "— it may be an app, a feed, or laid out in a way the " +
                            "heuristic misses. The page itself is unchanged behind " +
                            "this sheet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> Column(
                    Modifier
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp),
                ) {
                    Text(
                        article.title,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        buildString {
                            if (article.byline.isNotBlank()) {
                                append(article.byline)
                                append("  ·  ")
                            }
                            append("${Reader.readingMinutes(article.words)} min read")
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    article.paragraphs.forEach { paragraph ->
                        Text(
                            paragraph,
                            // Reader is the one place in the app showing the
                            // web's own words at length, so it gets prose
                            // metrics rather than the chrome's.
                            fontSize = 17.sp,
                            lineHeight = 27.sp,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(Modifier.height(14.dp))
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cite
// ---------------------------------------------------------------------------

@Composable
fun CiteSheet(
    url: String,
    title: String,
    onCopy: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var style by remember { mutableStateOf(Citations.Style.APA) }
    val source = remember(url, title) { Citations.sourceFor(url, title) }
    val text = remember(source, style) { Citations.format(source, style) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            ToolHeader("Cite this page", "Built from the URL, the title and today's date")

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Citations.Style.entries.forEach { option ->
                    FilterChip(
                        selected = option == style,
                        onClick = { style = option },
                        label = { Text(option.name) },
                    )
                }
            }

            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHighest,
                shape = RoundedCornerShape(Radii.Card),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            ) {
                Text(
                    text,
                    fontFamily = if (style == Citations.Style.BIBTEX) FontFamily.Monospace else null,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(14.dp),
                )
            }

            Spacer(Modifier.height(8.dp))
            Text(
                // A citation is a claim about a source. Saying which parts are
                // guesses is the difference between a tool a marker accepts
                // and one that fabricates an author.
                "No author or publication date: a page carries neither in a " +
                    "form a browser can read without guessing. Fill those in " +
                    "yourself — an invented author is worse than a gap.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )

            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                Button(onClick = { onCopy(text) }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Copy")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Focus timer
// ---------------------------------------------------------------------------

/**
 * The focus timer.
 *
 * State is a start timestamp, not a countdown. The phase is recomputed from
 * elapsed time on every tick, which means backgrounding the app, or having it
 * killed and reopened, does not lose the session.
 */
@Composable
fun FocusSheet(
    startedAt: Long?,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onDismiss: () -> Unit,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt) {
        while (startedAt != null) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }

    val state = remember(startedAt, now) {
        startedAt?.let { FocusTimer.stateAt((now - it) / 1000) }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.navigationBarsPadding().fillMaxWidth().padding(bottom = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ToolHeader("Focus timer", "25 minutes of work, then five off")

            Spacer(Modifier.height(12.dp))
            Text(
                state?.let { FocusTimer.clock(it.remaining) } ?: "25:00",
                fontSize = 56.sp,
                fontWeight = FontWeight.Light,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                state?.let { FocusTimer.label(it.phase) } ?: "Ready",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
            )
            state?.let {
                Spacer(Modifier.height(4.dp))
                Text(
                    if (it.completedBlocks == 1) "1 block done" else "${it.completedBlocks} blocks done",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(18.dp))
            if (startedAt == null) {
                Button(onClick = onStart) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Start")
                }
            } else {
                OutlinedButton(onClick = onStop) {
                    Icon(Icons.Filled.Pause, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Stop")
                }
            }

            Spacer(Modifier.height(12.dp))
            Text(
                // Said plainly, because the alternative is someone trusting it
                // to interrupt them and getting no interruption.
                "The timer runs while the app is alive. It does not post a " +
                    "notification, so nothing will tell you when the block ends " +
                    "if you are somewhere else.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

@Composable
fun SnippetsSheet(
    snippets: List<Snippet>,
    onSave: (String, String) -> Unit,
    onRemove: (String) -> Unit,
    onCopy: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var label by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().heightIn(min = 320.dp)) {
            ToolHeader("Snippets", "Text you keep pasting, kept on this device")

            Column(Modifier.padding(horizontal = 16.dp)) {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = body,
                    onValueChange = { body = it },
                    label = { Text("Text") },
                    maxLines = 4,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        onSave(label, body)
                        label = ""
                        body = ""
                    },
                    enabled = body.isNotBlank(),
                ) { Text("Save") }
            }

            Spacer(Modifier.height(8.dp))
            HorizontalDivider()

            if (snippets.isEmpty()) {
                Text(
                    "Nothing saved yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(20.dp),
                )
            } else {
                LazyColumn(Modifier.heightIn(max = 300.dp)) {
                    items(snippets, key = { it.id }) { snippet ->
                        ListItem(
                            headlineContent = { Text(snippet.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = {
                                Text(snippet.body, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            },
                            trailingContent = {
                                Row {
                                    IconButton(onClick = { onCopy(snippet.body) }) {
                                        Icon(Icons.Filled.ContentCopy, contentDescription = "Copy ${snippet.label}")
                                    }
                                    IconButton(onClick = { onRemove(snippet.id) }) {
                                        Icon(Icons.Filled.Close, contentDescription = "Delete ${snippet.label}")
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Page source
// ---------------------------------------------------------------------------

@Composable
fun SourceSheet(html: String?, onCopy: (String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().heightIn(min = 300.dp)) {
            ToolHeader(
                "Page source",
                // Not "view source": what comes back is the live DOM after
                // scripts have run, which is often not the HTML the server
                // sent. Calling it the same thing would be misleading.
                "The DOM as it stands now, not the HTML the server sent",
            )
            if (html == null) {
                Box(
                    Modifier.fillMaxWidth().padding(40.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
            } else {
                Text(
                    "${html.length} characters",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
                Spacer(Modifier.height(6.dp))
                Box(Modifier.weight(1f, fill = false).heightIn(max = 380.dp)) {
                    Text(
                        html,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        lineHeight = 15.sp,
                        modifier = Modifier
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp),
                    )
                }
                Spacer(Modifier.height(10.dp))
                Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Button(onClick = { onCopy(html) }) {
                        Icon(Icons.Filled.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Copy")
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

@Composable
fun JsonSheet(onCopy: (String) -> Unit, onDismiss: () -> Unit) {
    var input by remember { mutableStateOf("") }
    val result = remember(input) { if (input.isBlank()) null else Json.format(input) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().heightIn(min = 320.dp)) {
            ToolHeader("JSON", "Format it, and say where it breaks")

            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                label = { Text("Paste JSON") },
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                maxLines = 5,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )

            Spacer(Modifier.height(10.dp))
            when (val r = result) {
                null -> Unit

                is Json.Result.Error -> Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = RoundedCornerShape(Radii.Card),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("Line ${r.line}, column ${r.column}", fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(2.dp))
                        Text(r.message, style = MaterialTheme.typography.bodySmall)
                    }
                }

                is Json.Result.Ok -> Column {
                    Box(Modifier.heightIn(max = 260.dp)) {
                        Text(
                            r.pretty,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                            modifier = Modifier
                                .verticalScroll(rememberScrollState())
                                .padding(horizontal = 18.dp),
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier.padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Button(onClick = { onCopy(r.pretty) }) { Text("Copy formatted") }
                        OutlinedButton(onClick = { onCopy(r.minified) }) { Text("Copy minified") }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// Teleprompter
// ---------------------------------------------------------------------------

@Composable
fun PrompterSheet(onDismiss: () -> Unit) {
    var script by remember { mutableStateOf("") }
    var wpm by remember { mutableIntStateOf(Prompter.DEFAULT_WPM) }
    var rolling by remember { mutableStateOf(false) }
    val scroll = rememberScrollState()

    // Scrolling is driven from the measured content, so the script finishes
    // when the clock says it should regardless of how it laid out.
    LaunchedEffect(rolling, wpm, script, scroll.maxValue) {
        if (!rolling) return@LaunchedEffect
        val perSecond = Prompter.pixelsPerSecond(scroll.maxValue, script, wpm)
        if (perSecond <= 0f) return@LaunchedEffect
        while (rolling && scroll.value < scroll.maxValue) {
            scroll.scrollTo((scroll.value + (perSecond / 20f)).toInt().coerceAtMost(scroll.maxValue))
            delay(50)
        }
        rolling = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().heightIn(min = 340.dp)) {
            ToolHeader(
                "Teleprompter",
                "${Prompter.words(script)} words · ${Prompter.readingTime(script, wpm)} at $wpm wpm",
            )

            if (!rolling) {
                OutlinedTextField(
                    value = script,
                    onValueChange = { script = it },
                    label = { Text("Your script") },
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                )
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Pace", style = MaterialTheme.typography.labelLarge)
                    Spacer(Modifier.width(12.dp))
                    Slider(
                        value = wpm.toFloat(),
                        onValueChange = { wpm = it.toInt() },
                        valueRange = 80f..200f,
                        modifier = Modifier.weight(1f),
                    )
                }
            } else {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(max = 320.dp)
                        .clip(RoundedCornerShape(Radii.Card))
                        .background(Color.Black)
                        .padding(horizontal = 20.dp),
                ) {
                    Text(
                        script,
                        color = Color.White,
                        fontSize = 26.sp,
                        lineHeight = 38.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.verticalScroll(scroll).padding(vertical = 40.dp),
                    )
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(onClick = { rolling = !rolling }, enabled = script.isNotBlank()) {
                    Icon(
                        if (rolling) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = null,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(if (rolling) "Stop" else "Roll")
                }
                if (rolling) {
                    OutlinedButton(onClick = { rolling = false }) {
                        Icon(Icons.Filled.Refresh, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Edit")
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Data saver
// ---------------------------------------------------------------------------

@Composable
fun DataSaverSheet(
    enabled: Boolean,
    blocked: Long,
    onToggle: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            ToolHeader("Data saver", "Images are most of a page's bytes")

            ListItem(
                headlineContent = { Text("Stop loading images") },
                supportingContent = {
                    Text("Pages load as text. Turning this on takes effect on the next page.")
                },
                trailingContent = { Switch(checked = enabled, onCheckedChange = onToggle) },
                modifier = Modifier.clickable { onToggle(!enabled) },
            )

            Text(
                "Blocking has already cancelled ${Stats.formatCount(blocked)} requests, " +
                    "an estimated ${Stats.formatBytes(Stats.bytesSaved(blocked))} not downloaded " +
                    "at ~45 KB per request.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Shredder and panic
// ---------------------------------------------------------------------------

/**
 * The shredder.
 *
 * Two-step by construction: the button that does the deleting only appears
 * after the first tap, and it names what will go. This is not friction for
 * its own sake — the action is unrecoverable and lives one tap from the home
 * screen in Ghost Mode.
 */
@Composable
fun ShredderSheet(
    panic: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    var armed by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 20.dp)) {
            ToolHeader(
                if (panic) "Panic" else "Shredder",
                if (panic) "Close every tab, erase, and leave"
                else "Erase what this app has stored",
            )

            Column(Modifier.padding(horizontal = 20.dp)) {
                Text("This deletes, permanently:", style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                listOf(
                    "Browsing history",
                    "Bookmarks",
                    "Notes and snippets",
                    "Saved tabs",
                    "Blocking statistics",
                    "Cookies, cache and site data",
                ).forEach {
                    Text("·  $it", style = MaterialTheme.typography.bodyMedium)
                }

                Spacer(Modifier.height(12.dp))
                Text(
                    // The boundary of the claim, stated where the claim is
                    // made. A privacy tool that lets you believe it reaches
                    // further than it does is the worst kind.
                    "Your settings are kept, so erasing your history does not " +
                        "quietly turn your ad blocker off. Nothing here reaches " +
                        "anything already sent to a website, or anything your " +
                        "network or phone maker recorded.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(16.dp))
                if (!armed) {
                    Button(
                        onClick = { armed = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (panic) "Continue" else "Erase everything") }
                } else {
                    Button(
                        onClick = onConfirm,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (panic) "Erase and close the app" else "Yes, erase it all")
                    }
                    Spacer(Modifier.height(6.dp))
                    TextButton(
                        onClick = { armed = false },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Cancel") }
                }
            }
        }
    }
}
