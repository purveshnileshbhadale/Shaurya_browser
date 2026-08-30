package dev.shaurya.browser.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * The start page's backdrop.
 *
 * Three soft radial washes over a deep base, drawn rather than shipped as an
 * image: a bitmap large enough for a modern phone is a couple of megabytes,
 * has to exist at several densities, and still looks wrong on an aspect ratio
 * nobody tested. Gradients cost nothing, scale to any screen, and can shift
 * with the theme.
 *
 * Drawn in `drawBehind` rather than as a `Modifier.background(brush)` because
 * the wash centres are expressed relative to the measured size — two of them
 * sit outside the bounds, which is what stops the result looking like three
 * circles on a rectangle.
 */
private val BASE = Color(0xFF0B0714)
private val VIOLET = Color(0x8C7C3AED)   // 55% alpha
private val MAGENTA = Color(0x57EC4899)  // 34%
private val CYAN = Color(0x470EA5E9)     // 28%

/** Colours the start page draws on top of the aurora. */
object Ink {
    val Primary = Color(0xFFF4F1FA)
    val Dim = Color(0xFFC9BEE6)
    val Faint = Color(0xFFA79BC8)
    val Gold = Color(0xFFFFD166)
    /** Frosted surface and its hairline. Tuned to read without blur. */
    val Glass = Color(0x1AFFFFFF)
    val GlassStrong = Color(0x24FFFFFF)
    val Hairline = Color(0x29FFFFFF)
    val NewTabStart = Color(0xFFA855F7)
    val NewTabEnd = Color(0xFFEC4899)
    val Base = BASE
}

@Composable
fun AuroraBackground(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(BASE)
                // Top-left, bleeding off two edges.
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(VIOLET, Color.Transparent),
                        center = Offset(size.width * 0.10f, -size.height * 0.06f),
                        radius = size.minDimension * 1.55f,
                    )
                )
                // Upper-right.
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(MAGENTA, Color.Transparent),
                        center = Offset(size.width * 1.08f, size.height * 0.16f),
                        radius = size.minDimension * 1.30f,
                    )
                )
                // Lower, cooling the foot of the page so the nav pill sits on
                // something other than the same violet as the header.
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(CYAN, Color.Transparent),
                        center = Offset(size.width * 0.46f, size.height * 1.08f),
                        radius = size.minDimension * 1.60f,
                    )
                )
            },
        content = { content() },
    )
}
