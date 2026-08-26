package dev.aether.browser.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/**
 * Theme, honouring the user's accent choice and Android's dynamic colour.
 *
 * Material You is used when the platform offers it, because a browser that
 * ignores the system palette looks foreign on Android 12+. The stored accent
 * is the fallback and the explicit override.
 */
@Composable
fun AetherTheme(
    accent: String = "#6C8CFF",
    themeMode: String = "system",
    useDynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val dark = when (themeMode) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }

    val context = LocalContext.current
    val scheme = when {
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)

        dark -> darkColorScheme(primary = parseColor(accent))
        else -> lightColorScheme(primary = parseColor(accent))
    }

    MaterialTheme(colorScheme = scheme, content = content)
}

/** `#rrggbb` to a Compose colour, falling back rather than throwing. */
private fun parseColor(hex: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(hex))
}.getOrDefault(Color(0xFF6C8CFF))
