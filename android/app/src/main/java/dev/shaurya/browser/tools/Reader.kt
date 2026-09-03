package dev.shaurya.browser.tools

/**
 * Reader view.
 *
 * The extraction runs in the page, because only the page can reach its own
 * DOM. What comes back is plain text, which this file then tidies — and
 * tidying is where the useful part is: a naive `innerText` of an article is
 * mostly navigation, cookie notices and "related stories".
 *
 * The heuristic is the boring one that works: score every block by how much
 * of it is sentences, keep the winner's subtree. It is not Readability, and
 * it will lose on some pages. When it does, [looksEmpty] says so and the
 * caller offers the page back rather than showing a blank sheet — a reader
 * that silently eats the article is worse than no reader.
 */
object Reader {

    /**
     * Injected into the page. Returns a JSON string: `{title, byline, text}`.
     *
     * Written as one expression so `evaluateJavascript` gets a value back
     * without a wrapper, and touching nothing on the page — no styles are
     * changed and no nodes are removed, so leaving reader view needs no
     * undo.
     */
    val EXTRACT_JS: String = """
        (function () {
          function textOf(node) {
            return (node.innerText || '').replace(/\s+/g, ' ').trim();
          }
          function score(node) {
            var text = textOf(node);
            if (text.length < 200) return 0;
            // Sentences, roughly. Navigation and link farms have commas and
            // pipes; prose has full stops followed by a space.
            var sentences = (text.match(/[.!?]\s/g) || []).length;
            var links = node.querySelectorAll('a').length;
            var linkText = 0;
            node.querySelectorAll('a').forEach(function (a) {
              linkText += (a.innerText || '').length;
            });
            // A block that is mostly link text is a menu, whatever its size.
            var linkRatio = text.length ? linkText / text.length : 1;
            if (linkRatio > 0.5) return 0;
            return sentences * 40 + text.length * (1 - linkRatio) - links * 25;
          }
          var best = null, bestScore = 0;
          var candidates = document.querySelectorAll(
            'article, main, [role=main], .post, .article, .content, #content, div, section'
          );
          for (var i = 0; i < candidates.length; i++) {
            var s = score(candidates[i]);
            if (s > bestScore) { bestScore = s; best = candidates[i]; }
          }
          var body = best ? textOf(best) : textOf(document.body);
          var byline = '';
          var a = document.querySelector(
            '[rel=author], .byline, .author, [itemprop=author]'
          );
          if (a) byline = (a.innerText || '').replace(/\s+/g, ' ').trim();
          return JSON.stringify({
            title: (document.title || '').trim(),
            byline: byline.slice(0, 120),
            text: body
          });
        })()
    """.trimIndent()

    /** The words a page turned out to have. */
    data class Article(
        val title: String,
        val byline: String,
        val paragraphs: List<String>,
    ) {
        val words: Int get() = paragraphs.sumOf { p -> p.split(' ').count { it.isNotBlank() } }
    }

    /**
     * Break the extracted run-on text back into paragraphs.
     *
     * `innerText` collapses the page's structure, so the sentence boundary is
     * all that is left to work with. Grouping a few sentences at a time gives
     * something readable without pretending to recover the original breaks.
     */
    fun paragraphs(text: String, sentencesPerParagraph: Int = 3): List<String> {
        val clean = text.replace(Regex("\\s+"), " ").trim()
        if (clean.isEmpty()) return emptyList()

        val sentences = mutableListOf<String>()
        val current = StringBuilder()
        var i = 0
        while (i < clean.length) {
            val c = clean[i]
            current.append(c)
            val ends = c == '.' || c == '!' || c == '?'
            val nextIsSpace = i + 1 >= clean.length || clean[i + 1] == ' '
            // "e.g." and "Dr." end in a full stop and are not sentences. A
            // single letter or a known abbreviation before the stop is the
            // cheap test that catches most of them.
            if (ends && nextIsSpace && !endsWithAbbreviation(current)) {
                sentences.add(current.toString().trim())
                current.clear()
                i++            // skip the space
            }
            i++
        }
        if (current.isNotBlank()) sentences.add(current.toString().trim())

        return sentences
            .filter { it.isNotBlank() }
            .chunked(sentencesPerParagraph.coerceAtLeast(1))
            .map { it.joinToString(" ") }
    }

    private val ABBREVIATIONS = setOf(
        "mr.", "mrs.", "ms.", "dr.", "prof.", "st.", "jr.", "sr.",
        "e.g.", "i.e.", "etc.", "vs.", "fig.", "no.", "approx.",
    )

    private fun endsWithAbbreviation(builder: StringBuilder): Boolean {
        val tail = builder.toString().trimEnd()
        val lastWord = tail.substringAfterLast(' ').lowercase()
        if (lastWord in ABBREVIATIONS) return true
        // A lone initial: "J." in "J. R. R. Tolkien".
        return lastWord.length == 2 && lastWord[0].isLetter() && lastWord[1] == '.'
    }

    /**
     * Did extraction actually find an article?
     *
     * The threshold is low on purpose. It is not trying to judge quality —
     * only to catch the case where the heuristic came back with a nav bar, so
     * the caller can offer the real page instead of a sheet with six words in
     * it.
     */
    fun looksEmpty(article: Article): Boolean = article.words < 60

    /** Minutes to read, at a middling adult pace. Rounded up; never zero. */
    fun readingMinutes(words: Int, wordsPerMinute: Int = 220): Int =
        if (words <= 0) 0 else ((words + wordsPerMinute - 1) / wordsPerMinute).coerceAtLeast(1)
}
