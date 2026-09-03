package dev.shaurya.browser.tools

import java.util.Calendar
import java.util.Locale

/**
 * A citation for the page you are on.
 *
 * Built from what a browser actually knows — the URL, the document title, and
 * today's date — and nothing else. It does not invent an author, a publisher
 * or a publication date, because a citation with a plausible wrong author in
 * it is worse than one with a gap: the gap gets filled by the person writing
 * the essay, and the invention gets handed in.
 *
 * So every style below emits the container (the site) and the access date,
 * marks what it does not know, and leaves the rest to the writer.
 */
object Citations {

    enum class Style { APA, MLA, BIBTEX }

    /** Everything a page can tell us about itself. */
    data class Source(
        val url: String,
        val title: String,
        /** Year/month/day the page was read. */
        val year: Int,
        val month: Int,
        val day: Int,
    )

    private val MONTHS = listOf(
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )

    /** Today, for a page being read now. */
    fun sourceFor(url: String, title: String, calendar: Calendar = Calendar.getInstance()): Source =
        Source(
            url = url.trim(),
            title = title.trim(),
            year = calendar.get(Calendar.YEAR),
            // Calendar months are zero-based, which is the single most
            // reliable off-by-one in this API.
            month = calendar.get(Calendar.MONTH) + 1,
            day = calendar.get(Calendar.DAY_OF_MONTH),
        )

    /** The registrable-ish site name, used as the container. */
    fun site(url: String): String {
        val host = url.trim()
            .substringAfter("://", "")
            .substringBefore('/')
            .substringBefore('?')
            .substringAfterLast('@')
            .substringBefore(':')
            .removePrefix("www.")
            .lowercase()
        return host
    }

    fun format(source: Source, style: Style): String {
        val title = source.title.ifBlank { source.url }
        val site = site(source.url)
        val monthName = MONTHS.getOrElse(source.month - 1) { "" }
        return when (style) {
            // "n.d." is the standard marker for an unknown date, and it is
            // the truthful one here: a page carries no publication date the
            // browser can read without guessing at its markup.
            Style.APA ->
                "$title. (n.d.). $site. Retrieved $monthName ${source.day}, " +
                    "${source.year}, from ${source.url}"

            Style.MLA ->
                "\"$title.\" $site, ${source.day} ${monthName.take(3)}. " +
                    "${source.year}, ${source.url}. Accessed ${source.day} " +
                    "${monthName.take(3)}. ${source.year}."

            Style.BIBTEX -> buildString {
                append("@misc{").append(key(source)).append(",\n")
                append("  title        = {").append(title).append("},\n")
                append("  howpublished = {\\url{").append(source.url).append("}},\n")
                append("  note         = {Accessed ")
                append(pad(source.day)).append(' ').append(monthName.take(3))
                append(' ').append(source.year).append("},\n")
                append("  year         = {").append(source.year).append("}\n")
                append("}")
            }
        }
    }

    /** A BibTeX key: site plus year, reduced to what BibTeX accepts. */
    fun key(source: Source): String {
        val stem = site(source.url).substringBefore('.')
            .filter { it.isLetterOrDigit() }
            .lowercase(Locale.US)
            .ifBlank { "page" }
        return "$stem${source.year}"
    }

    private fun pad(n: Int): String = if (n < 10) "0$n" else "$n"
}
