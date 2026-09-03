@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.shaurya.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.shaurya.browser.modes.Mode
import dev.shaurya.browser.modes.ModeTools
import dev.shaurya.browser.modes.Modes

/**
 * The mode switcher, ported from the desktop's signature feature.
 *
 * Each row states what the mode changes *here*, rather than borrowing the
 * desktop's description of panels this app does not have. Most modes restyle
 * the browser and say so plainly; the one that changes behaviour is marked,
 * so a row promising a colour is never mistaken for a privacy setting.
 */
@Composable
fun ModeSheet(
    activeId: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            Text(
                "Modes",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 20.dp, top = 2.dp, bottom = 2.dp),
            )
            Text(
                "A mode restyles the browser. Only Ghost changes how it behaves.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
            )

            Modes.ALL.forEach { mode ->
                ModeRow(mode, selected = mode.id == activeId, onPick = { onPick(mode.id) })
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun ModeRow(mode: Mode, selected: Boolean, onPick: () -> Unit) {
    val accent = Color(mode.accent)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onPick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        // The accent itself is the icon: it is what the mode actually does.
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(34.dp)
                .clip(CircleShape)
                .background(accent.copy(alpha = 0.20f))
                .border(1.5.dp, accent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(12.dp).clip(CircleShape).background(accent))
        }

        Spacer(Modifier.width(14.dp))

        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    mode.name,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                )
                if (Modes.altersBehaviour(mode)) {
                    Spacer(Modifier.width(8.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        shape = RoundedCornerShape(6.dp),
                    ) {
                        Text(
                            "changes behaviour",
                            fontSize = 9.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
                        )
                    }
                }
            }
            Text(
                mode.tagline,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            mode.changes.forEach { change ->
                Text(
                    "· $change",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            val tools = ModeTools.toolsFor(mode.id)
            if (tools.isNotEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(
                    "Tools: " + tools.joinToString(", ") { it.name },
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            // What the desktop has here and the phone does not, with the
            // reason. Naming it is the difference between a limitation and a
            // broken promise — and a "coming soon" button would be worse than
            // either.
            val missing = ModeTools.unavailableFor(mode.id)
            if (missing.isNotEmpty() && selected) {
                Spacer(Modifier.height(5.dp))
                Text(
                    "ON THE DESKTOP ONLY",
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.6.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                missing.forEach { item ->
                    Text(
                        "· ${item.name} — ${item.reason}",
                        fontSize = 10.5.sp,
                        lineHeight = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        if (selected) {
            Icon(
                Icons.Filled.Check,
                contentDescription = "Active",
                tint = accent,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}
