@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.shaurya.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** What the shields sheet needs to know about the current page. */
data class ShieldsState(
    val host: String,
    val enabledHere: Boolean,
    val blockedHere: Int,
    val httpsUpgradesHere: Int,
    val secure: Boolean,
    val seedOnly: Boolean,
)

/**
 * The per-site protection sheet.
 *
 * Reached from the shield in the toolbar, which is the one control a
 * privacy browser has that people actually use: the number tells them
 * something is happening, and the first thing they want when a site breaks is
 * a way to turn it off *for that site only* without hunting through settings.
 *
 * So the destructive-ish control — the per-site switch — is the largest thing
 * on the sheet, and it says which site it applies to. A global "block ads"
 * toggle in this position would be a trap: someone turning off protection to
 * fix one checkout page would silently turn it off everywhere.
 */
@Composable
fun ShieldsSheet(
    state: ShieldsState,
    onToggleSite: (Boolean) -> Unit,
    onOpenSettings: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {

            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.Shield,
                    contentDescription = null,
                    tint = if (state.enabledHere) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        state.host.ifBlank { "This page" },
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        if (state.enabledHere) "Protection is on for this site"
                        else "Protection is off for this site",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = state.enabledHere, onCheckedChange = onToggleSite)
            }

            if (state.seedOnly) {
                // Say it here too. Someone who opens this sheet is asking
                // "am I protected", and the honest answer right now is
                // "partly".
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        "Limited protection — the full filter lists have not "
                            + "downloaded yet. Only the built-in starter rules are active.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                ShieldStat(
                    value = "${state.blockedHere}",
                    label = "Trackers & ads\nblocked here",
                    modifier = Modifier.weight(1f),
                )
                ShieldStat(
                    value = "${state.httpsUpgradesHere}",
                    label = "Connections\nupgraded",
                    modifier = Modifier.weight(1f),
                )
                ShieldStat(
                    value = if (state.secure) "HTTPS" else "HTTP",
                    label = if (state.secure) "Encrypted\nconnection" else "Not\nencrypted",
                    tint = if (state.secure) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
            }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            ListItem(
                headlineContent = { Text("Privacy settings") },
                supportingContent = { Text("Applies to every site") },
                leadingContent = { Icon(Icons.Filled.Lock, contentDescription = null) },
                modifier = Modifier.clickable(onClick = onOpenSettings),
            )
        }
    }
}

@Composable
private fun ShieldStat(
    value: String,
    label: String,
    modifier: Modifier = Modifier,
    tint: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurface,
) {
    Column(
        modifier.padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            value,
            // Deliberately large. The count is the whole reason anyone opens
            // this sheet, and a number set at body size reads as a footnote.
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            color = tint,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

/** The shield glyph in the toolbar, with its count. */
@Composable
fun ShieldButton(
    blocked: Int,
    enabledHere: Boolean,
    seedOnly: Boolean,
    onClick: () -> Unit,
) {
    IconButton(onClick = onClick) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                Icons.Filled.Shield,
                contentDescription = when {
                    seedOnly -> "Limited protection — filter lists have not downloaded"
                    !enabledHere -> "Protection is off for this site"
                    else -> "$blocked trackers and ads blocked on this page"
                },
                tint = when {
                    seedOnly -> MaterialTheme.colorScheme.error
                    !enabledHere -> MaterialTheme.colorScheme.onSurfaceVariant
                    else -> MaterialTheme.colorScheme.primary
                },
            )
            if (blocked > 0 && enabledHere && !seedOnly) {
                // The count sits *inside* the shield rather than on a corner
                // badge: it is the shield's content, not an alert about it.
                Box(
                    Modifier
                        .offset(x = 9.dp, y = 9.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.primary)
                        .padding(horizontal = 3.dp),
                ) {
                    Text(
                        if (blocked > 99) "99+" else "$blocked",
                        color = MaterialTheme.colorScheme.onPrimary,
                        fontSize = 9.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}
