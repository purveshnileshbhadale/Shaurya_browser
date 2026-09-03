package dev.shaurya.browser.modes

/**
 * The tools a mode puts on the home page.
 *
 * The desktop keeps a `features` map per mode and the chrome reads it; this
 * is the same idea with the same rule — a mode is a document, never a branch.
 * Nothing here knows which modes exist. The home page renders [toolsFor], the
 * sheets are opened by id, and adding a tool to a mode is adding a string to
 * a list.
 *
 * ## Why this list is shorter than the desktop's
 *
 * The desktop's Programmer Mode carries a terminal, a Docker client and a
 * local web server. None of those can exist inside an Android app: an app
 * cannot hand you a shell on the device, and a browser is not a place to run
 * containers. Ghost Mode's Tor routing needs a Tor daemon shipped in the APK
 * and a proxy the WebView will actually honour, which is a project in itself.
 *
 * The honest response is to say so rather than ship a button that opens a
 * "coming soon" card. [unavailableFor] holds that list, the mode sheet shows
 * it, and each entry says *why* — a feature that is impossible here reads
 * very differently from one nobody has got to yet.
 */
data class Tool(
    val id: String,
    val name: String,
    /** One line, on the tile. Says what it does, not what it is. */
    val summary: String,
    /** Material icon name, resolved by the UI layer. */
    val icon: String,
    /** True when the tool acts on the page you are on, so it needs one. */
    val needsPage: Boolean = false,
)

/** Something the desktop has that this app does not, and the reason. */
data class Missing(val name: String, val reason: String)

object ModeTools {

    val READER = Tool(
        "reader", "Reader", "Strip a page down to its words", "article",
        needsPage = true,
    )
    val CITE = Tool(
        "cite", "Cite", "APA, MLA or BibTeX for this page", "school",
        needsPage = true,
    )
    val FOCUS = Tool("focus", "Focus timer", "Work, then stop working", "timer")
    val SNIPPETS = Tool("snippets", "Snippets", "Text you keep pasting", "content_paste")
    val SOURCE = Tool(
        "source", "Page source", "The HTML behind the page", "code",
        needsPage = true,
    )
    val JSON = Tool("json", "JSON", "Format and check JSON", "data_object")
    val PROMPTER = Tool("prompter", "Teleprompter", "Your script, scrolling", "slideshow")
    val DATASAVER = Tool("datasaver", "Data saver", "Stop loading images", "data_saver_on")
    val SHREDDER = Tool("shredder", "Shredder", "Erase what this app stored", "delete_forever")
    val PANIC = Tool("panic", "Panic", "Close everything, erase, exit", "warning")

    val ALL: List<Tool> = listOf(
        READER, CITE, FOCUS, SNIPPETS, SOURCE, JSON, PROMPTER,
        DATASAVER, SHREDDER, PANIC,
    )

    /**
     * Reader is on every mode's list.
     *
     * It is the single most useful thing a browser can do to a phone-hostile
     * page, and gating it behind a mode would mean the browser is worse by
     * default in order to make a mode look better.
     */
    private val EVERY_MODE = listOf(READER.id)

    private val BY_MODE: Map<String, List<String>> = mapOf(
        "default" to listOf(SNIPPETS.id, JSON.id),
        "programmer" to listOf(SOURCE.id, JSON.id, SNIPPETS.id),
        "gamer" to listOf(DATASAVER.id, FOCUS.id),
        "creator" to listOf(PROMPTER.id, SNIPPETS.id),
        "student" to listOf(CITE.id, FOCUS.id, SNIPPETS.id),
        "ghost" to listOf(SHREDDER.id, PANIC.id),
    )

    /** The tools this mode shows, in the order it shows them. */
    fun toolsFor(modeId: String): List<Tool> {
        val ids = EVERY_MODE + (BY_MODE[modeId] ?: BY_MODE.getValue("default"))
        return ids.distinct().mapNotNull { id -> ALL.firstOrNull { it.id == id } }
    }

    fun byId(id: String): Tool? = ALL.firstOrNull { it.id == id }

    private val NO_TERMINAL = "An app cannot open a shell on your phone"
    private val NO_SERVER = "A browser is not a place to run servers"

    private val MISSING: Map<String, List<Missing>> = mapOf(
        "programmer" to listOf(
            Missing("Terminal", NO_TERMINAL),
            Missing("Docker and database clients", NO_TERMINAL),
            Missing("Local servers", NO_SERVER),
            Missing("Extension development", "Android WebView loads no extensions"),
        ),
        "gamer" to listOf(
            Missing("Hardware overlay", "Only the system may draw over other apps"),
            Missing("Clip recorder", "Screen capture belongs to the system recorder"),
            Missing("Gamepad navigation", "Nothing here is worth a controller yet"),
        ),
        "creator" to listOf(
            Missing("Asset library and brand kit", "Not built yet"),
            Missing("Upload scheduler", "Would need an account with each platform"),
        ),
        "student" to listOf(
            Missing("PDF annotation", "Not built yet"),
            Missing("Flashcards and deadlines", "Not built yet"),
        ),
        "ghost" to listOf(
            Missing(
                "Tor routing",
                "Needs a Tor daemon in the app and a proxy the WebView honours",
            ),
            Missing(
                "Fingerprint randomisation",
                "Android WebView exposes no hook deep enough to be worth trusting",
            ),
        ),
    )

    /**
     * What this mode has on the desktop and not here.
     *
     * Shown in the mode sheet. A blank list is a real answer: Default
     * promises nothing beyond the browser, so it is missing nothing.
     */
    fun unavailableFor(modeId: String): List<Missing> = MISSING[modeId] ?: emptyList()
}
