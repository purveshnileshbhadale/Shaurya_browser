package dev.shaurya.browser.modes

/**
 * Modes, ported from the desktop build.
 *
 * A mode is a *document*, never a branch. Nothing here knows which modes
 * exist: the switcher renders whatever is in [ALL], the theme reads `accent`,
 * and the behaviour flags are consulted by name. Adding a mode is adding an
 * entry, which is what let the desktop go from two modes to six without
 * touching any mode code.
 *
 * ## What a mode honestly does on a phone
 *
 * The desktop modes swap whole panels — a terminal, a REST client, a
 * teleprompter — that do not exist in this app. Pretending "Programmer Mode"
 * enables tooling here when it only recolours the chrome would be the kind of
 * feature that exists in a changelog and nowhere else.
 *
 * So each mode states what it changes *on this device*, and the switcher
 * shows that text. Every mode restyles the browser, which is real and
 * visible. Ghost additionally changes behaviour that matters, and says so.
 */
data class Mode(
    val id: String,
    val name: String,
    val tagline: String,
    /** ARGB accent; the whole theme and the start page's aurora derive from it. */
    val accent: Int,
    /** What this mode changes on Android, in plain words, for the switcher. */
    val changes: List<String>,
    /** Record visited pages in history. */
    val keepHistory: Boolean = true,
    /** Photograph tabs for the switcher. */
    val keepThumbnails: Boolean = true,
    /**
     * Ignore the per-site "protection off here" exceptions.
     *
     * An exception is a convenience for a site you trust. A mode whose whole
     * claim is that it leaves nothing behind cannot also honour a standing
     * instruction to stop blocking on some domain.
     */
    val ignoreSiteExceptions: Boolean = false,
    /** Force the HTTPS upgrade regardless of the stored setting. */
    val forceHttps: Boolean = false,
)

object Modes {

    val ALL: List<Mode> = listOf(
        Mode(
            id = "default",
            name = "Default",
            tagline = "The browser, as you configured it.",
            accent = 0xFF7C9BFF.toInt(),
            changes = listOf("Your own settings, unchanged"),
        ),
        Mode(
            id = "programmer",
            name = "Programmer",
            tagline = "A cooler chrome for long sessions in docs and repos.",
            accent = 0xFF4ADE80.toInt(),
            changes = listOf("Green chrome and start page"),
        ),
        Mode(
            id = "gamer",
            name = "Gamer",
            tagline = "High-contrast violet, for reading between matches.",
            accent = 0xFFA855F7.toInt(),
            changes = listOf("Violet chrome and start page"),
        ),
        Mode(
            id = "creator",
            name = "Creator",
            tagline = "Warm chrome that stays out of the way of images.",
            accent = 0xFFF97316.toInt(),
            changes = listOf("Amber chrome and start page"),
        ),
        Mode(
            id = "student",
            name = "Student",
            tagline = "Calm blue, and nothing that competes with the page.",
            accent = 0xFF0EA5E9.toInt(),
            changes = listOf("Blue chrome and start page"),
        ),
        Mode(
            id = "ghost",
            name = "Ghost",
            tagline = "Leaves nothing behind on this device.",
            accent = 0xFF94A3B8.toInt(),
            changes = listOf(
                "Nothing written to history",
                "No tab thumbnails kept",
                "Ignores your per-site protection exceptions",
                "Always upgrades to HTTPS",
            ),
            keepHistory = false,
            keepThumbnails = false,
            ignoreSiteExceptions = true,
            forceHttps = true,
        ),
    )

    val DEFAULT: Mode = ALL.first()

    /** Look up a stored id, falling back rather than throwing on an old value. */
    fun byId(id: String?): Mode = ALL.firstOrNull { it.id == id } ?: DEFAULT

    /**
     * Does this mode change anything beyond how the browser looks?
     *
     * Used by the switcher to mark the one mode that does, so a row promising
     * only a colour is not mistaken for a privacy feature.
     */
    fun altersBehaviour(mode: Mode): Boolean =
        !mode.keepHistory || !mode.keepThumbnails || mode.ignoreSiteExceptions || mode.forceHttps
}
