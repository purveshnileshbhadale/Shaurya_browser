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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.History
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.shaurya.browser.search.ShauryaSearch

/**
 * Shaurya Search results.
 *
 * Ordered by how much the browser can vouch for each block: what it computed
 * itself, then what it already had on the device, then other people's
 * indexes — each labelled with whose it is. A search page that blends its own
 * results with a provider's and lets you guess which is which is doing
 * something dishonest with the word "search".
 */
@Composable
fun SearchScreen(
    query: String,
    results: ShauryaSearch.Results,
    onOpen: (String) -> Unit,
    onEditQuery: () -> Unit,
    onDismiss: () -> Unit,
) {
    AuroraBackground {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState()),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(start = 4.dp, end = 12.dp, top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss) {
                    Icon(
                        Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back",
                        tint = Ink.Primary,
                    )
                }
                Column(
                    Modifier.weight(1f).clickable(onClick = onEditQuery),
                ) {
                    Text(
                        query,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Ink.Primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("Shaurya Search", fontSize = 11.sp, color = Ink.Faint)
                }
            }

            results.instant?.let { instant ->
                Spacer(Modifier.height(14.dp))
                Column(
                    Modifier
                        .padding(horizontal = 20.dp)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(22.dp))
                        .background(Ink.Glass)
                        .border(1.dp, Ink.Hairline, RoundedCornerShape(22.dp))
                        .padding(18.dp),
                ) {
                    Text(
                        instant.answer.value,
                        fontSize = 30.sp,
                        fontWeight = FontWeight.Bold,
                        color = Ink.Primary,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(instant.answer.detail, fontSize = 13.sp, color = Ink.Dim)
                    Spacer(Modifier.height(10.dp))
                    // The claim that makes this different from a search box
                    // that merely looks fast.
                    Text(
                        "Worked out on this device — nothing was sent anywhere.",
                        fontSize = 11.sp,
                        color = Ink.Faint,
                    )
                }
            }

            if (results.local.isNotEmpty()) {
                SectionLabel("ON THIS DEVICE")
                Column(
                    Modifier
                        .padding(horizontal = 20.dp)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(22.dp))
                        .background(Ink.Glass)
                        .border(1.dp, Ink.Hairline, RoundedCornerShape(22.dp)),
                ) {
                    results.local.forEach { hit ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { onOpen(hit.url) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .size(30.dp)
                                    .clip(CircleShape)
                                    .background(Color(Accents.listColor(hit.url))),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    Stats.tileInitial(hit.url),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = Color.White,
                                )
                            }
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    hit.title.ifBlank { hit.url },
                                    fontSize = 13.5.sp,
                                    color = Ink.Primary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    Stats.tileLabel(hit.url),
                                    fontSize = 11.sp,
                                    color = Ink.Faint,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Icon(
                                if (hit.bookmarked) Icons.Filled.Bookmark else Icons.Filled.History,
                                contentDescription = if (hit.bookmarked) "Bookmarked" else "From history",
                                tint = Ink.Faint,
                                modifier = Modifier.size(15.dp),
                            )
                        }
                    }
                }
            }

            SectionLabel("SEARCH THE WEB")
            Column(Modifier.padding(horizontal = 20.dp)) {
                results.web.forEach { web ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(Ink.Glass)
                            .border(1.dp, Ink.Hairline, RoundedCornerShape(16.dp))
                            .clickable { onOpen(web.url) }
                            .padding(horizontal = 16.dp, vertical = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(web.label, fontSize = 14.sp, color = Ink.Primary, modifier = Modifier.weight(1f))
                        Icon(
                            Icons.AutoMirrored.Filled.OpenInNew,
                            contentDescription = null,
                            tint = Ink.Faint,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                }
            }

            Text(
                "Shaurya has no web index of its own. Instant answers and the "
                    + "matches above are computed on this device; choosing a "
                    + "provider sends your query to them.",
                fontSize = 11.sp,
                color = Ink.Faint,
                modifier = Modifier.padding(horizontal = 22.dp, vertical = 14.dp),
            )
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.9.sp,
        color = Ink.Faint,
        modifier = Modifier.padding(start = 24.dp, top = 20.dp, bottom = 9.dp),
    )
}
