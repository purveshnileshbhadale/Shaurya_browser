package dev.shaurya.browser.adblock

/**
 * Ad and tracker blocking for Android (spec §6 parity).
 *
 * The same design as the desktop engine: parse Adblock Plus syntax, pick one
 * selective token per rule, bucket by that token, and at match time test only
 * the buckets whose token appears in the URL.
 *
 * On Android this matters more than on desktop. `shouldInterceptRequest` runs
 * on WebView's IO thread for **every** subresource, and it blocks that
 * request until it returns. A linear scan of 100k rules there would stall
 * page loads outright, so the tokenised index is what makes network-layer
 * blocking viable inside a WebView at all.
 */

/** Chromium resource types, inferred from the request on Android. */
enum class ResourceType { MAIN_FRAME, SUB_FRAME, SCRIPT, STYLESHEET, IMAGE, FONT, XHR, MEDIA, OTHER }

/** One parsed filter rule. */
data class Rule(
    val pattern: String,
    val isException: Boolean,
    val isRegex: Boolean,
    val regex: Regex?,
    val anchorDomain: Boolean,
    val anchorStart: Boolean,
    val anchorEnd: Boolean,
    val thirdParty: Boolean?,
    val types: Set<ResourceType>?,
    val excludedTypes: Set<ResourceType>?,
    val domains: Set<String>?,
    val excludeDomains: Set<String>?,
    val important: Boolean,
    val raw: String,
)

data class Verdict(val block: Boolean, val rule: Rule? = null)

private val TOKEN_REGEX = Regex("[a-z0-9%]{3,}")

private val COMMON_TOKENS = setOf(
    "http", "https", "www", "com", "net", "org", "html", "php", "index",
    "javascript", "css", "img", "images", "static", "assets", "content",
)

/** ABP option name to the resource types Android can distinguish. */
private val TYPE_MAP = mapOf(
    "script" to ResourceType.SCRIPT,
    "image" to ResourceType.IMAGE,
    "stylesheet" to ResourceType.STYLESHEET,
    "xmlhttprequest" to ResourceType.XHR,
    "xhr" to ResourceType.XHR,
    "subdocument" to ResourceType.SUB_FRAME,
    "document" to ResourceType.MAIN_FRAME,
    "media" to ResourceType.MEDIA,
    "font" to ResourceType.FONT,
    "other" to ResourceType.OTHER,
)

class FilterEngine {

    private val blockBuckets = HashMap<String, MutableList<Rule>>()
    private val allowBuckets = HashMap<String, MutableList<Rule>>()
    private val importantBuckets = HashMap<String, MutableList<Rule>>()
    private val blockCatchAll = ArrayList<Rule>()
    private val allowCatchAll = ArrayList<Rule>()
    private val importantCatchAll = ArrayList<Rule>()

    /** Domain-scoped cosmetic selectors, injected after the page loads. */
    private val cosmeticByDomain = HashMap<String, MutableList<String>>()
    private val cosmeticGeneric = ArrayList<String>()

    var networkRuleCount = 0
        private set
    var cosmeticRuleCount = 0
        private set

    /**
     * Verdict cache.
     *
     * A page requesting the same CDN asset thirty times should match once.
     * Bounded and cleared on rebuild; `LinkedHashMap` in access order gives
     * LRU eviction for free.
     */
    private val cache = object : LinkedHashMap<String, Verdict>(512, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Verdict>?): Boolean =
            size > 4096
    }

    // -----------------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------------

    /** Parse and index a filter list. Safe to call for several lists. */
    fun addList(text: String) {
        val rules = ArrayList<Rule>()
        val exceptions = ArrayList<Rule>()

        text.lineSequence().forEach { line ->
            val trimmed = line.trim()
            if (trimmed.isEmpty()) return@forEach
            if (trimmed[0] == '!' || trimmed[0] == '[') return@forEach

            // Cosmetic rules use `##`; the extended forms need a CSS engine
            // we do not have, so they are skipped rather than mis-applied.
            val cosmeticIndex = trimmed.indexOf("##")
            if (cosmeticIndex >= 0) {
                val selector = trimmed.substring(cosmeticIndex + 2)
                if (selector.startsWith("+js") || selector.contains(":has(")) return@forEach
                val domainPart = trimmed.substring(0, cosmeticIndex)
                if (domainPart.isEmpty()) {
                    cosmeticGeneric.add(selector)
                } else {
                    domainPart.split(",").forEach { domain ->
                        val clean = domain.trim()
                        if (clean.isNotEmpty() && !clean.startsWith("~")) {
                            cosmeticByDomain.getOrPut(clean) { ArrayList() }.add(selector)
                        }
                    }
                }
                cosmeticRuleCount++
                return@forEach
            }
            if (trimmed.contains("#@#") || trimmed.contains("#?#") || trimmed.contains("#$#")) {
                return@forEach
            }

            val rule = parseRule(trimmed) ?: return@forEach
            if (rule.isException) exceptions.add(rule) else rules.add(rule)
        }

        val frequency = HashMap<String, Int>()
        (rules + exceptions).forEach { rule ->
            if (!rule.isRegex) {
                TOKEN_REGEX.findAll(rule.pattern.lowercase()).forEach { match ->
                    frequency[match.value] = (frequency[match.value] ?: 0) + 1
                }
            }
        }

        rules.forEach { rule ->
            if (rule.important) place(rule, importantBuckets, importantCatchAll, frequency)
            else place(rule, blockBuckets, blockCatchAll, frequency)
        }
        exceptions.forEach { place(it, allowBuckets, allowCatchAll, frequency) }

        networkRuleCount += rules.size + exceptions.size
        cache.clear()
    }

    fun clear() {
        blockBuckets.clear(); allowBuckets.clear(); importantBuckets.clear()
        blockCatchAll.clear(); allowCatchAll.clear(); importantCatchAll.clear()
        cosmeticByDomain.clear(); cosmeticGeneric.clear()
        networkRuleCount = 0
        cosmeticRuleCount = 0
        cache.clear()
    }

    private fun place(
        rule: Rule,
        buckets: HashMap<String, MutableList<Rule>>,
        catchAll: MutableList<Rule>,
        frequency: Map<String, Int>,
    ) {
        val token = pickToken(rule, frequency)
        if (token != null) buckets.getOrPut(token) { ArrayList() }.add(rule)
        else catchAll.add(rule)
    }

    /**
     * Choose a token that is guaranteed to appear whole in a matching URL.
     *
     * A token adjacent to `*`, or at an unanchored pattern edge, may be only
     * part of a longer run in the URL — indexing under it would make the rule
     * invisible. Those rules fall back to the catch-all list.
     */
    private fun pickToken(rule: Rule, frequency: Map<String, Int>): String? {
        if (rule.isRegex) return null
        val pattern = rule.pattern.lowercase()
        var best: String? = null
        var bestScore = Double.MAX_VALUE

        TOKEN_REGEX.findAll(pattern).forEach { match ->
            val start = match.range.first
            val end = match.range.last + 1

            val leftOk = if (start > 0) pattern[start - 1] != '*'
            else rule.anchorStart || rule.anchorDomain
            val rightOk = if (end < pattern.length) pattern[end] != '*' else rule.anchorEnd
            if (!leftOk || !rightOk) return@forEach

            val token = match.value
            val score = (frequency[token] ?: 0).toDouble() -
                token.length * 0.01 +
                (if (token in COMMON_TOKENS) 1_000_000.0 else 0.0)
            if (score < bestScore) {
                bestScore = score
                best = token
            }
        }
        return best
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    private fun parseRule(line: String): Rule? {
        var rest = line
        val isException = rest.startsWith("@@")
        if (isException) rest = rest.substring(2)

        var pattern = rest
        var optionString = ""
        val dollar = findOptionSeparator(rest)
        if (dollar >= 0) {
            pattern = rest.substring(0, dollar)
            optionString = rest.substring(dollar + 1)
        }
        if (pattern.isEmpty()) return null

        val isRegex = pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")
        var anchorDomain = false
        var anchorStart = false
        var anchorEnd = false

        if (!isRegex) {
            if (pattern.startsWith("||")) {
                anchorDomain = true
                pattern = pattern.substring(2)
            } else if (pattern.startsWith("|")) {
                anchorStart = true
                pattern = pattern.substring(1)
            }
            if (pattern.endsWith("|")) {
                anchorEnd = true
                pattern = pattern.dropLast(1)
            }
            if (pattern.isEmpty()) return null
        }

        var thirdParty: Boolean? = null
        var types: MutableSet<ResourceType>? = null
        var excludedTypes: MutableSet<ResourceType>? = null
        var domains: MutableSet<String>? = null
        var excludeDomains: MutableSet<String>? = null
        var important = false

        if (optionString.isNotEmpty()) {
            for (raw in optionString.split(",")) {
                val negated = raw.startsWith("~")
                val option = if (negated) raw.substring(1) else raw
                val equals = option.indexOf('=')
                val name = if (equals >= 0) option.substring(0, equals) else option
                val value = if (equals >= 0) option.substring(equals + 1) else null

                when (name) {
                    "third-party", "3p" -> thirdParty = !negated
                    "first-party", "1p" -> thirdParty = negated
                    "important" -> important = true
                    "match-case" -> Unit
                    "domain", "from" -> {
                        value?.split("|")?.forEach { domain ->
                            if (domain.startsWith("~")) {
                                (excludeDomains ?: HashSet<String>().also { excludeDomains = it })
                                    .add(domain.substring(1).lowercase())
                            } else if (domain.isNotEmpty()) {
                                (domains ?: HashSet<String>().also { domains = it })
                                    .add(domain.lowercase())
                            }
                        }
                    }
                    else -> {
                        val mapped = TYPE_MAP[name]
                        if (mapped != null) {
                            if (negated) {
                                (excludedTypes ?: HashSet<ResourceType>().also { excludedTypes = it })
                                    .add(mapped)
                            } else {
                                (types ?: HashSet<ResourceType>().also { types = it }).add(mapped)
                            }
                        } else {
                            // An option we cannot honour means the rule means
                            // something we would get wrong; drop it.
                            return null
                        }
                    }
                }
            }
        }

        val compiled = if (isRegex) {
            try {
                Regex(pattern.substring(1, pattern.length - 1), RegexOption.IGNORE_CASE)
            } catch (e: Exception) {
                return null
            }
        } else null

        return Rule(
            pattern = pattern,
            isException = isException,
            isRegex = isRegex,
            regex = compiled,
            anchorDomain = anchorDomain,
            anchorStart = anchorStart,
            anchorEnd = anchorEnd,
            thirdParty = thirdParty,
            types = types,
            excludedTypes = excludedTypes,
            domains = domains,
            excludeDomains = excludeDomains,
            important = important,
            raw = line,
        )
    }

    /** Find the `$` that starts options, ignoring one inside a /regex/. */
    private fun findOptionSeparator(text: String): Int {
        if (text.startsWith("/")) {
            val closing = text.lastIndexOf('/')
            if (closing > 0) return text.indexOf('$', closing)
        }
        return text.indexOf('$')
    }

    // -----------------------------------------------------------------------
    // Matching
    // -----------------------------------------------------------------------

    /**
     * Decide a request. Called on WebView's IO thread, so it must stay fast
     * and must never throw.
     */
    fun match(url: String, pageUrl: String?, type: ResourceType): Verdict {
        val key = "$type $url $pageUrl"
        synchronized(cache) { cache[key] }?.let { return it }

        val verdict = try {
            matchUncached(url, pageUrl, type)
        } catch (e: Exception) {
            // Fail open: a blocker bug must not break the page.
            Verdict(false)
        }

        synchronized(cache) { cache[key] = verdict }
        return verdict
    }

    private fun matchUncached(url: String, pageUrl: String?, type: ResourceType): Verdict {
        val lower = url.lowercase()
        val host = hostOf(lower) ?: return Verdict(false)
        val sourceHost = pageUrl?.lowercase()?.let { hostOf(it) }
        val thirdParty = sourceHost != null && baseDomain(host) != baseDomain(sourceHost)

        val tokens = TOKEN_REGEX.findAll(lower).map { it.value }.toList()
        val context = MatchContext(lower, host, sourceHost, thirdParty, type)

        // `$important` blocks outrank exceptions, so they are consulted first.
        findMatch(importantBuckets, importantCatchAll, tokens, context)?.let {
            return Verdict(true, it)
        }
        val blockRule = findMatch(blockBuckets, blockCatchAll, tokens, context)
            ?: return Verdict(false)
        findMatch(allowBuckets, allowCatchAll, tokens, context)?.let {
            return Verdict(false, it)
        }
        return Verdict(true, blockRule)
    }

    private data class MatchContext(
        val url: String,
        val host: String,
        val sourceHost: String?,
        val thirdParty: Boolean,
        val type: ResourceType,
    )

    private fun findMatch(
        buckets: Map<String, MutableList<Rule>>,
        catchAll: List<Rule>,
        tokens: List<String>,
        context: MatchContext,
    ): Rule? {
        val seen = HashSet<Rule>()
        for (token in tokens) {
            val bucket = buckets[token] ?: continue
            for (rule in bucket) {
                if (!seen.add(rule)) continue
                if (ruleMatches(rule, context)) return rule
            }
        }
        for (rule in catchAll) {
            if (ruleMatches(rule, context)) return rule
        }
        return null
    }

    private fun ruleMatches(rule: Rule, context: MatchContext): Boolean {
        rule.types?.let { if (context.type !in it) return false }
        rule.excludedTypes?.let { if (context.type in it) return false }
        rule.thirdParty?.let { if (it != context.thirdParty) return false }

        rule.domains?.let { allowed ->
            val source = context.sourceHost ?: return false
            if (allowed.none { source == it || source.endsWith(".$it") }) return false
        }
        rule.excludeDomains?.let { excluded ->
            val source = context.sourceHost
            if (source != null && excluded.any { source == it || source.endsWith(".$it") }) {
                return false
            }
        }

        if (rule.isRegex) return rule.regex?.containsMatchIn(context.url) == true

        return if (rule.anchorDomain) {
            matchDomainAnchored(rule.pattern.lowercase(), context.url, context.host, rule.anchorEnd)
        } else if (rule.anchorStart) {
            wildcardMatch(rule.pattern.lowercase(), context.url, 0, rule.anchorEnd)
        } else {
            val head = rule.pattern.lowercase().split('*', '^').firstOrNull() ?: ""
            if (head.isNotEmpty()) {
                var index = context.url.indexOf(head)
                while (index >= 0) {
                    if (wildcardMatch(rule.pattern.lowercase(), context.url, index, rule.anchorEnd)) {
                        return true
                    }
                    index = context.url.indexOf(head, index + 1)
                }
                false
            } else {
                (0..context.url.length).any {
                    wildcardMatch(rule.pattern.lowercase(), context.url, it, rule.anchorEnd)
                }
            }
        }
    }

    private fun matchDomainAnchored(
        pattern: String,
        url: String,
        host: String,
        anchorEnd: Boolean,
    ): Boolean {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd < 0) return false
        val hostStart = schemeEnd + 3
        val hostEnd = hostStart + host.length
        // Anchor at the host start or any label boundary, so `||example.com`
        // also matches `ads.example.com`.
        for (i in hostStart..hostEnd) {
            if (i > hostStart && url.getOrNull(i - 1) != '.') continue
            if (wildcardMatch(pattern, url, i, anchorEnd)) return true
        }
        return false
    }

    /**
     * ABP wildcard matching at a fixed offset.
     * `*` matches any run; `^` matches a separator or end-of-URL.
     */
    private fun wildcardMatch(
        pattern: String,
        url: String,
        offset: Int,
        anchorEnd: Boolean,
    ): Boolean {
        var p = 0
        var u = offset
        var starP = -1
        var starU = -1

        while (p < pattern.length) {
            val pc = pattern[p]
            if (pc == '*') {
                starP = ++p
                starU = u
                continue
            }
            if (u < url.length && (pc == url[u] || (pc == '^' && isSeparator(url[u])))) {
                p++
                u++
                continue
            }
            if (pc == '^' && u == url.length) {
                p++
                continue
            }
            if (starP >= 0 && starU < url.length) {
                p = starP
                u = ++starU
                continue
            }
            return false
        }
        if (!anchorEnd) return true
        if (starP == pattern.length) return true
        return u == url.length
    }

    private fun isSeparator(c: Char): Boolean =
        !(c.isLetterOrDigit() || c == '_' || c == '-' || c == '.' || c == '%')

    // -----------------------------------------------------------------------
    // Cosmetic filtering
    // -----------------------------------------------------------------------

    /**
     * A stylesheet for a page, injected once the DOM is ready.
     *
     * Only site-specific rules are applied on Android. The ~13k generic
     * selectors would need the DOM-token scan the desktop content script
     * does, and running that in a `evaluateJavascript` round trip on every
     * page costs more than it saves on a phone.
     */
    fun cosmeticCss(host: String): String {
        val selectors = ArrayList<String>()
        val labels = ArrayList<String>()
        val parts = host.split(".")
        for (i in 0 until parts.size - 1) {
            labels.add(parts.subList(i, parts.size).joinToString("."))
        }
        labels.forEach { label -> cosmeticByDomain[label]?.let { selectors.addAll(it) } }
        if (selectors.isEmpty()) return ""
        return selectors.joinToString(",") + "{display:none !important}"
    }

    companion object {
        fun hostOf(url: String): String? {
            val schemeEnd = url.indexOf("://")
            if (schemeEnd < 0) return null
            val start = schemeEnd + 3
            var end = url.length
            for (i in start until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#' || c == ':') {
                    end = i
                    break
                }
            }
            return if (end > start) url.substring(start, end) else null
        }

        /** Registrable-ish domain, for the third-party comparison. */
        fun baseDomain(host: String): String {
            val parts = host.split(".")
            if (parts.size <= 2) return host
            val twoLevel = Regex("^(co|com|org|net|gov|edu|ac|or|ne|go)\\.[a-z]{2}$")
            val tail2 = parts.takeLast(2).joinToString(".")
            return if (twoLevel.matches(tail2) && parts.size >= 3) {
                parts.takeLast(3).joinToString(".")
            } else {
                tail2
            }
        }
    }
}
