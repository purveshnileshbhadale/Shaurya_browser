package dev.aether.browser.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * Local persistence: settings, bookmarks, history and notes.
 *
 * Two stores with different guarantees:
 *
 *  - Ordinary browsing data goes in JSON files inside the app's private
 *    directory, which Android already isolates per-app.
 *  - Secrets (API keys, the sync passphrase) go in `EncryptedSharedPreferences`,
 *    which is backed by the hardware keystore. They are never written to the
 *    plain JSON, so an `adb backup` or a rooted-device file dump does not
 *    reveal them.
 */

@Serializable
data class Settings(
    val adblockEnabled: Boolean = true,
    val httpsOnly: Boolean = true,
    val blockThirdPartyCookies: Boolean = true,
    val sendGpc: Boolean = true,
    val searchEngine: String = "duckduckgo",
    val theme: String = "system",
    val accent: String = "#6C8CFF",
    val aiEnabled: Boolean = true,
    val aiModel: String = "claude-opus-5",
    val aiEndpoint: String = "https://api.anthropic.com",
    val notesEnabled: Boolean = true,
    val syncEnabled: Boolean = false,
    val syncEndpoint: String = "",
    val vpnEnabled: Boolean = false,
    val restoreTabs: Boolean = true,
)

@Serializable
data class Bookmark(
    val id: String,
    val url: String,
    val title: String,
    val created: Long = System.currentTimeMillis(),
)

@Serializable
data class HistoryEntry(
    val url: String,
    val title: String,
    var visits: Int = 1,
    var lastVisit: Long = System.currentTimeMillis(),
)

@Serializable
data class Note(
    val id: String,
    val title: String,
    val markdown: String,
    val sourceUrl: String? = null,
    val created: Long = System.currentTimeMillis(),
    var updated: Long = System.currentTimeMillis(),
)

@Serializable
data class SavedTab(val url: String, val title: String)

class AetherStore(private val context: Context) {

    private val json = Json {
        ignoreUnknownKeys = true   // an older build must survive a newer file
        prettyPrint = true
        encodeDefaults = true
    }

    private val root: File get() = context.filesDir

    /** Hardware-backed store for anything secret. */
    private val secrets by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "aether_secrets",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    var settings: Settings = load("settings.json", Settings())
        private set

    fun updateSettings(transform: (Settings) -> Settings) {
        settings = transform(settings)
        save("settings.json", settings)
    }

    // -----------------------------------------------------------------------
    // Secrets
    // -----------------------------------------------------------------------

    fun secret(key: String): String? = secrets.getString(key, null)

    fun setSecret(key: String, value: String?) {
        secrets.edit().apply {
            if (value.isNullOrEmpty()) remove(key) else putString(key, value)
        }.apply()
    }

    // -----------------------------------------------------------------------
    // Bookmarks
    // -----------------------------------------------------------------------

    var bookmarks: MutableList<Bookmark> = load("bookmarks.json", emptyList<Bookmark>()).toMutableList()
        private set

    fun addBookmark(url: String, title: String): Bookmark {
        bookmarks.firstOrNull { it.url == url }?.let { return it }
        val bookmark = Bookmark(id = newId(), url = url, title = title)
        bookmarks.add(bookmark)
        save("bookmarks.json", bookmarks.toList())
        return bookmark
    }

    fun removeBookmark(id: String) {
        bookmarks.removeAll { it.id == id }
        save("bookmarks.json", bookmarks.toList())
    }

    fun isBookmarked(url: String): Boolean = bookmarks.any { it.url == url }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    var history: MutableList<HistoryEntry> = load("history.json", emptyList<HistoryEntry>()).toMutableList()
        private set

    fun recordVisit(url: String, title: String, incognito: Boolean) {
        if (incognito) return
        if (!url.startsWith("http")) return

        val existing = history.firstOrNull { it.url == url }
        if (existing != null) {
            existing.visits++
            existing.lastVisit = System.currentTimeMillis()
            if (title.isNotBlank()) {
                history[history.indexOf(existing)] = existing.copy(title = title)
            }
        } else {
            history.add(HistoryEntry(url, title.ifBlank { url }))
        }

        // Keep the file bounded; a phone does not need a year of history.
        if (history.size > 5000) {
            history.sortByDescending { it.lastVisit }
            history = history.take(5000).toMutableList()
        }
        save("history.json", history.toList())
    }

    /** Frecency-ranked search, matching the desktop's ordering. */
    fun searchHistory(query: String, limit: Int = 20): List<HistoryEntry> {
        val q = query.lowercase()
        val now = System.currentTimeMillis()
        return history
            .filter { q.isEmpty() || it.url.lowercase().contains(q) || it.title.lowercase().contains(q) }
            .sortedByDescending {
                val ageDays = (now - it.lastVisit) / 86_400_000.0
                100.0 / (1 + ageDays) + Math.log(1.0 + it.visits) * 20
            }
            .take(limit)
    }

    fun clearHistory() {
        history.clear()
        save("history.json", emptyList<HistoryEntry>())
    }

    // -----------------------------------------------------------------------
    // Notes
    // -----------------------------------------------------------------------

    var notes: MutableList<Note> = load("notes.json", emptyList<Note>()).toMutableList()
        private set

    fun saveNote(title: String, markdown: String, sourceUrl: String?): Note {
        val note = Note(id = newId(), title = title, markdown = markdown, sourceUrl = sourceUrl)
        notes.add(0, note)
        save("notes.json", notes.toList())
        return note
    }

    fun removeNote(id: String) {
        notes.removeAll { it.id == id }
        save("notes.json", notes.toList())
    }

    // -----------------------------------------------------------------------
    // Session restore
    // -----------------------------------------------------------------------

    fun saveSession(tabs: List<SavedTab>) = save("session.json", tabs)

    fun loadSession(): List<SavedTab> = load("session.json", emptyList())

    // -----------------------------------------------------------------------
    // File helpers
    // -----------------------------------------------------------------------

    private inline fun <reified T> load(name: String, fallback: T): T {
        val file = File(root, name)
        if (!file.exists()) return fallback
        return runCatching { json.decodeFromString<T>(file.readText()) }.getOrDefault(fallback)
    }

    private inline fun <reified T> save(name: String, value: T) {
        runCatching {
            // Write-then-rename, so a kill mid-write cannot truncate the file.
            val temp = File(root, "$name.tmp")
            temp.writeText(json.encodeToString(value))
            temp.renameTo(File(root, name))
        }
    }

    private fun newId(): String =
        java.util.UUID.randomUUID().toString().replace("-", "").take(16)
}
