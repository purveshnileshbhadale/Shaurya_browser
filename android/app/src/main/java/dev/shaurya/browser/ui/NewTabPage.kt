package dev.shaurya.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One most-visited site. */
data class TopSite(val url: String, val title: String)

/**
 * The page a new tab opens to.
 *
 * The app previously opened new tabs on `about:blank` — a white void with no
 * way forward except typing a full address. This is the single largest gap
 * between it and any shipping browser, and no amount of polish elsewhere
 * compensates for a blank first screen.
 *
 * The layout answers the two questions someone has on opening a tab, in
 * order: *where am I going* (search, then the sites they actually use), and
 * *is this thing working* (the shield totals). The stats sit below the tiles
 * rather than above them, because they are reassurance, not a destination —
 * putting them first would make the browser about itself.
 */
@Composable
fun NewTabPage(
    blocked: Long,
    httpsUpgrades: Long,
    topSites: List<TopSite>,
    incognito: Boolean,
    onSearch: () -> Unit,
    onOpenSite: (String) -> Unit,
    onBookmarks: () -> Unit,
    onHistory: () -> Unit,
    onAssistant: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp),
    ) {
        Spacer(Modifier.height(40.dp))

        Text(
            "Shaurya",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            if (incognito) "Private tab — nothing here is saved"
            else "Private by default",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(20.dp))

        // A large, obvious target that focuses the real address bar. New
        // users reach for the middle of the screen, not a 40dp-tall bar at
        // the edge of it.
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth().clickable(onClick = onSearch),
        ) {
            Row(
                Modifier.padding(horizontal = 18.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    Icons.Filled.Search,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    "Search or enter address",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(24.dp))

        if (topSites.isNotEmpty() && !incognito) {
            Text(
                "Frequently visited",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(12.dp))
            // Fixed height so this grid does not fight the outer scroll: it
            // holds at most eight tiles in two rows, which is a known size.
            LazyVerticalGrid(
                columns = GridCells.Fixed(4),
                modifier = Modifier.fillMaxWidth().heightIn(max = 200.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                userScrollEnabled = false,
            ) {
                items(topSites, key = { it.url }) { site ->
                    SiteTile(site, onClick = { onOpenSite(site.url) })
                }
            }
            Spacer(Modifier.height(24.dp))
        }

        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            QuickTile(Icons.Filled.Bookmark, "Bookmarks", Modifier.weight(1f), onBookmarks)
            QuickTile(Icons.Filled.History, "History", Modifier.weight(1f), onHistory)
            QuickTile(Icons.Filled.AutoAwesome, "Assistant", Modifier.weight(1f), onAssistant)
        }

        Spacer(Modifier.height(24.dp))

        ShieldSummary(blocked = blocked, httpsUpgrades = httpsUpgrades)

        Spacer(Modifier.height(40.dp))
    }
}

/**
 * The lifetime shield totals.
 *
 * Note the wording: the count is stated flatly because it is measured, and
 * the saving says "estimated" because it is not — it is the count multiplied
 * by an assumed request size. Presenting a guess in the same voice as a
 * measurement is how a privacy dashboard turns into marketing.
 */
@Composable
private fun ShieldSummary(blocked: Long, httpsUpgrades: Long) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(18.dp)) {
            Text(
                "Since you installed Shaurya",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(14.dp))
            Row(Modifier.fillMaxWidth()) {
                BigStat(
                    value = Stats.formatCount(blocked),
                    label = "Trackers & ads\nblocked",
                    modifier = Modifier.weight(1f),
                )
                BigStat(
                    value = Stats.formatBytes(Stats.bytesSaved(blocked)),
                    label = "Estimated data\nsaved",
                    modifier = Modifier.weight(1f),
                )
                BigStat(
                    value = Stats.formatCount(httpsUpgrades),
                    label = "Connections\nupgraded",
                    modifier = Modifier.weight(1f),
                )
            }
            if (blocked > 0) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "Data saved is an estimate: ${Stats.formatBytes(Stats.BYTES_PER_BLOCKED_REQUEST)} "
                        + "assumed per blocked request.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun BigStat(value: String, label: String, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            value,
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SiteTile(site: TopSite, onClick: () -> Unit) {
    Column(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(MaterialTheme.colorScheme.secondaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            // A letter, not a favicon. Fetching icons for the new tab page
            // would mean a network request per tile to sites the user is not
            // visiting yet — a tracking vector on the one screen that should
            // not have one.
            Text(
                Stats.tileInitial(site.url),
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            Stats.tileLabel(site.url),
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun QuickTile(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Column(
            Modifier.padding(vertical = 14.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(6.dp))
            Text(label, style = MaterialTheme.typography.labelMedium)
        }
    }
}
