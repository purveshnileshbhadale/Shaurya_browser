package dev.shaurya.browser.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Calendar

/** One most-visited site. */
data class TopSite(val url: String, val title: String)

/**
 * The page a new tab opens to.
 *
 * Laid out as a greeting first, then the one thing you came to do (type an
 * address), then the places you go, then what the browser has been doing for
 * you. The shield total is deliberately last and deliberately small — it is
 * reassurance, and a browser whose home screen leads with its own statistics
 * is a browser that is about itself.
 */
@Composable
fun NewTabPage(
    blocked: Long,
    httpsUpgrades: Long,
    topSites: List<TopSite>,
    recent: List<TopSite>,
    incognito: Boolean,
    onSearch: () -> Unit,
    onOpenSite: (String) -> Unit,
) {
    val greeting = remember { Accents.greeting(Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        Spacer(Modifier.height(18.dp))

        Column(Modifier.padding(horizontal = 24.dp)) {
            Text(
                if (incognito) "Private tab" else greeting,
                fontSize = 15.sp,
                color = Ink.Dim,
            )
            Spacer(Modifier.height(2.dp))
            // Light weight against bold, so the product name carries the line
            // without the whole heading shouting.
            Text(
                "Welcome to",
                fontSize = 34.sp,
                fontWeight = FontWeight.ExtraLight,
                color = Ink.Primary,
                lineHeight = 38.sp,
            )
            Text(
                "Shaurya",
                fontSize = 34.sp,
                fontWeight = FontWeight.Bold,
                color = Ink.Primary,
                lineHeight = 38.sp,
            )
        }

        Spacer(Modifier.height(20.dp))
        GlassSearch(onClick = onSearch)

        if (!incognito) {
            Spacer(Modifier.height(16.dp))
            ShieldLine(blocked = blocked, httpsUpgrades = httpsUpgrades)
        }

        if (topSites.isNotEmpty() && !incognito) {
            Spacer(Modifier.height(20.dp))
            SiteGrid(sites = topSites, onOpen = onOpenSite)
        }

        if (recent.isNotEmpty() && !incognito) {
            Spacer(Modifier.height(22.dp))
            RecentCard(entries = recent, onOpen = onOpenSite)
        }

        if (incognito) {
            Spacer(Modifier.height(24.dp))
            Text(
                "Nothing you do in this tab is written to history, and no "
                    + "thumbnail of it is kept.",
                fontSize = 13.sp,
                color = Ink.Dim,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }

        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun GlassSearch(onClick: () -> Unit) {
    Row(
        Modifier
            .padding(horizontal = 20.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(Ink.Glass)
            .border(1.dp, Ink.Hairline, RoundedCornerShape(22.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Search,
            contentDescription = null,
            tint = Ink.Dim,
            modifier = Modifier.size(19.dp),
        )
        Spacer(Modifier.width(12.dp))
        Text("Search or enter address", fontSize = 15.sp, color = Ink.Dim)
    }
}

/**
 * The shield total, as a sentence.
 *
 * A line of text rather than a card of big numbers. The count is measured, so
 * it is stated plainly; the saving is not, so it is marked "est." right
 * there rather than in a footnote nobody reads.
 */
@Composable
private fun ShieldLine(blocked: Long, httpsUpgrades: Long) {
    Row(
        Modifier.padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Shield,
            contentDescription = null,
            tint = Ink.Gold,
            modifier = Modifier.size(15.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(Stats.formatCount(blocked), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Ink.Gold)
        Spacer(Modifier.width(5.dp))
        Text("blocked", fontSize = 13.sp, color = Ink.Dim)
        if (blocked > 0) {
            Spacer(Modifier.width(8.dp))
            Text("·", fontSize = 13.sp, color = Ink.Faint)
            Spacer(Modifier.width(8.dp))
            Text(
                Stats.formatBytes(Stats.bytesSaved(blocked)),
                fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Ink.Gold,
            )
            Spacer(Modifier.width(5.dp))
            Text("saved · est.", fontSize = 13.sp, color = Ink.Dim)
        }
    }
}

@Composable
private fun SiteGrid(sites: List<TopSite>, onOpen: (String) -> Unit) {
    // A plain Column of Rows rather than a LazyVerticalGrid: this list is at
    // most eight items and lives inside a scrolling column, where nesting a
    // lazy grid means giving it a fixed height and fighting two scroll axes.
    Column(Modifier.padding(horizontal = 14.dp)) {
        sites.chunked(4).forEach { row ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                row.forEach { site ->
                    SiteTile(site, onOpen, Modifier.weight(1f))
                }
                // Keep a short final row left-aligned on the same grid.
                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
            }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SiteTile(site: TopSite, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val (start, end) = remember(site.url) { Accents.tileColors(site.url) }
    Column(
        modifier
            .clip(RoundedCornerShape(16.dp))
            .clickable { onOpen(site.url) }
            .padding(vertical = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(
                    Brush.linearGradient(listOf(Color(start), Color(end)))
                ),
            contentAlignment = Alignment.Center,
        ) {
            // A letter, not a favicon: fetching icons here would mean a
            // network request per tile to sites the user has not opened yet,
            // on the one screen that should not phone anywhere.
            Text(
                Stats.tileInitial(site.url),
                fontSize = 21.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            Stats.tileLabel(site.url),
            fontSize = 11.sp,
            color = Ink.Dim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun RecentCard(entries: List<TopSite>, onOpen: (String) -> Unit) {
    Column(
        Modifier
            .padding(horizontal = 20.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(Ink.Glass)
            .border(1.dp, Ink.Hairline, RoundedCornerShape(24.dp)),
    ) {
        Text(
            "JUMP BACK IN",
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.9.sp,
            color = Ink.Faint,
            modifier = Modifier.padding(start = 18.dp, top = 14.dp, bottom = 8.dp),
        )
        entries.take(4).forEach { entry ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onOpen(entry.url) }
                    .padding(horizontal = 18.dp, vertical = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .background(Color(Accents.listColor(entry.url))),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        Stats.tileInitial(entry.url),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White,
                    )
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        entry.title.ifBlank { entry.url },
                        fontSize = 13.5.sp,
                        color = Ink.Primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        Stats.tileLabel(entry.url),
                        fontSize = 11.sp,
                        color = Ink.Faint,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}
