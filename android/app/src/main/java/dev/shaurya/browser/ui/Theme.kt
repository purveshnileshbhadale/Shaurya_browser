package dev.shaurya.browser.ui

import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Whether this device has animations turned off.
 *
 * Android exposes it as an animator duration scale of zero, set either by
 * "Remove animations" in accessibility settings or by developer options. It
 * is a stated preference, so it wins over anything the app would rather do —
 * for some people motion is not a matter of taste but of nausea.
 */
val LocalReducedMotion = staticCompositionLocalOf { false }

/**
 * Theme.
 *
 * Three sources of colour, in order of preference:
 *
 * 1. **Material You**, on Android 12+, unless the user turned it off. A
 *    browser that ignores the system palette looks foreign next to every
 *    other app on the device.
 * 2. **The stored accent**, expanded into a full tonal palette by
 *    [Palette]. Every role is derived, not just `primary`.
 * 3. **The brand accent**, when the stored one is unreadable.
 */
@Composable
fun ShauryaTheme(
    accent: String = "#6C8CFF",
    themeMode: String = "system",
    useDynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val dark = isDarkTheme(themeMode)
    val context = LocalContext.current

    val scheme = when {
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
            if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)

        else -> remember(accent, dark) { brandedScheme(Palette.seedOf(accent), dark) }
    }

    val reducedMotion = remember {
        // Throws nothing on a missing setting; the default of 1.0 means
        // "animate normally", which is the right assumption when unknown.
        Settings.Global.getFloat(
            context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f
        ) == 0f
    }

    CompositionLocalProvider(LocalReducedMotion provides reducedMotion) {
        MaterialTheme(colorScheme = scheme, typography = ShauryaTypography, content = content)
    }
}

/** Resolve the stored theme preference against the system's. */
@Composable
fun isDarkTheme(themeMode: String): Boolean = when (themeMode) {
    "dark" -> true
    "light" -> false
    else -> isSystemInDarkTheme()
}

/**
 * A full Material scheme grown from one seed.
 *
 * The tone numbers are Material's own role assignments. They look arbitrary
 * written out like this, but they are the reason a container reads as a
 * *quieter* version of its accent rather than a different colour, and why
 * on-colours always land on the readable side of their backgrounds.
 */
fun brandedScheme(seed: Int, dark: Boolean): ColorScheme {
    fun accent(t: Int) = Color(Palette.tone(seed, t))
    // Secondary is the same hue at roughly a third of the chroma: present,
    // but never competing with the accent for attention.
    fun second(t: Int) = Color(Palette.tone(seed, t, chromaScale = 0.33f))
    // Tertiary sits 60 degrees round the wheel, which is what keeps a
    // highlight distinguishable from the accent without clashing with it.
    val tertiarySeed = Palette.rotate(seed, 60f)
    fun third(t: Int) = Color(Palette.tone(tertiarySeed, t, chromaScale = 0.6f))
    // Surfaces carry a trace of the accent rather than being pure grey; it is
    // the difference between a themed app and a grey one with a coloured
    // button in it.
    fun neutral(t: Int) = Color(Palette.tone(seed, t, chromaScale = 0.045f))
    fun variant(t: Int) = Color(Palette.tone(seed, t, chromaScale = 0.13f))

    // Error keeps Material's own red. A themed error colour is a bad idea:
    // "something went wrong" should look the same in every app, and a red
    // accent would otherwise make errors invisible.
    val error = if (dark) Color(0xFFFFB4AB) else Color(0xFFBA1A1A)
    val onError = if (dark) Color(0xFF690005) else Color.White
    val errorContainer = if (dark) Color(0xFF93000A) else Color(0xFFFFDAD6)
    val onErrorContainer = if (dark) Color(0xFFFFDAD6) else Color(0xFF410002)

    return if (dark) {
        darkColorScheme(
            primary = accent(80), onPrimary = accent(20),
            primaryContainer = accent(30), onPrimaryContainer = accent(90),
            inversePrimary = accent(40),
            secondary = second(80), onSecondary = second(20),
            secondaryContainer = second(30), onSecondaryContainer = second(90),
            tertiary = third(80), onTertiary = third(20),
            tertiaryContainer = third(30), onTertiaryContainer = third(90),
            background = neutral(6), onBackground = neutral(90),
            surface = neutral(6), onSurface = neutral(90),
            surfaceVariant = variant(30), onSurfaceVariant = variant(80),
            surfaceTint = accent(80),
            inverseSurface = neutral(90), inverseOnSurface = neutral(20),
            outline = variant(60), outlineVariant = variant(30),
            error = error, onError = onError,
            errorContainer = errorContainer, onErrorContainer = onErrorContainer,
            scrim = Color.Black,
            // The container ramp is what gives a dark theme depth without
            // borders: a sheet is lighter than the page behind it.
            surfaceDim = neutral(6), surfaceBright = neutral(24),
            surfaceContainerLowest = neutral(4), surfaceContainerLow = neutral(10),
            surfaceContainer = neutral(12), surfaceContainerHigh = neutral(17),
            surfaceContainerHighest = neutral(22),
        )
    } else {
        lightColorScheme(
            primary = accent(40), onPrimary = accent(100),
            primaryContainer = accent(90), onPrimaryContainer = accent(10),
            inversePrimary = accent(80),
            secondary = second(40), onSecondary = second(100),
            secondaryContainer = second(90), onSecondaryContainer = second(10),
            tertiary = third(40), onTertiary = third(100),
            tertiaryContainer = third(90), onTertiaryContainer = third(10),
            background = neutral(99), onBackground = neutral(10),
            surface = neutral(99), onSurface = neutral(10),
            surfaceVariant = variant(90), onSurfaceVariant = variant(30),
            surfaceTint = accent(40),
            inverseSurface = neutral(20), inverseOnSurface = neutral(95),
            outline = variant(50), outlineVariant = variant(80),
            error = error, onError = onError,
            errorContainer = errorContainer, onErrorContainer = onErrorContainer,
            scrim = Color.Black,
            surfaceDim = neutral(87), surfaceBright = neutral(98),
            surfaceContainerLowest = neutral(100), surfaceContainerLow = neutral(96),
            surfaceContainer = neutral(94), surfaceContainerHigh = neutral(92),
            surfaceContainerHighest = neutral(90),
        )
    }
}

/**
 * Type scale.
 *
 * Only the roles the browser actually uses are overridden, and only where the
 * default is wrong for this app: a URL and a page title are read at a glance
 * while scrolling a tab grid, so they are set slightly tighter and heavier
 * than Material's defaults, which are tuned for prose.
 */
private val ShauryaTypography = Typography().let { base ->
    base.copy(
        titleMedium = base.titleMedium.copy(
            fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp,
        ),
        labelLarge = base.labelLarge.copy(fontWeight = FontWeight.Medium),
        bodyMedium = base.bodyMedium.copy(lineHeight = 20.sp),
        // The address bar. Not monospaced — a URL in mono at 14sp fits far
        // fewer characters, and the host is the part that matters.
        bodyLarge = TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = 15.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.sp,
        ),
    )
}
