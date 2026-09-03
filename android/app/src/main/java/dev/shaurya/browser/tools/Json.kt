package dev.shaurya.browser.tools

/**
 * A JSON formatter that says where it broke.
 *
 * Hand-written rather than delegated to a parser, for one reason: on a bad
 * document the useful output is not "invalid JSON" but the offset and what was
 * expected there. A library that throws a generic exception cannot give that,
 * and being told *where* is the whole value of this tool on a phone, where you
 * cannot simply eyeball four hundred lines.
 */
object Json {

    sealed interface Result {
        data class Ok(val pretty: String, val minified: String) : Result

        /** [index] is a character offset; [line] and [column] are 1-based. */
        data class Error(
            val message: String,
            val index: Int,
            val line: Int,
            val column: Int,
        ) : Result
    }

    fun format(input: String, indent: Int = 2): Result {
        val parser = Parser(input)
        return try {
            parser.skipWhitespace()
            val value = parser.parseValue()
            parser.skipWhitespace()
            if (!parser.atEnd()) parser.fail("unexpected trailing content")
            Result.Ok(pretty = render(value, indent, 0), minified = render(value, 0, 0))
        } catch (e: Failure) {
            val (line, column) = lineAndColumn(input, e.index)
            Result.Error(e.message ?: "invalid JSON", e.index, line, column)
        }
    }

    private class Failure(val index: Int, message: String) : Exception(message)

    private fun lineAndColumn(input: String, index: Int): Pair<Int, Int> {
        var line = 1
        var column = 1
        for (i in 0 until index.coerceAtMost(input.length)) {
            if (input[i] == '\n') {
                line++
                column = 1
            } else {
                column++
            }
        }
        return line to column
    }

    // -- The tree ------------------------------------------------------------
    // Private rather than exposed: callers want text back, and a public tree
    // would be an API to maintain for nobody.

    private sealed interface Node
    private data class Str(val value: String) : Node
    private data class Num(val raw: String) : Node
    private data class Bool(val value: Boolean) : Node
    private object Nul : Node
    private data class Arr(val items: List<Node>) : Node
    private data class Obj(val entries: List<Pair<String, Node>>) : Node

    private class Parser(private val src: String) {
        var i = 0

        fun atEnd(): Boolean = i >= src.length

        fun fail(what: String): Nothing = throw Failure(i, what)

        fun skipWhitespace() {
            while (i < src.length && src[i].isWhitespace()) i++
        }

        fun parseValue(): Node {
            if (atEnd()) fail("expected a value")
            return when (val c = src[i]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> Str(parseString())
                't' -> { literal("true"); Bool(true) }
                'f' -> { literal("false"); Bool(false) }
                'n' -> { literal("null"); Nul }
                else ->
                    if (c == '-' || c.isDigit()) parseNumber()
                    else fail("unexpected '" + c + "'")
            }
        }

        private fun literal(word: String) {
            if (!src.startsWith(word, i)) fail("expected " + word)
            i += word.length
        }

        private fun parseObject(): Node {
            i++
            val entries = mutableListOf<Pair<String, Node>>()
            skipWhitespace()
            if (!atEnd() && src[i] == '}') {
                i++
                return Obj(entries)
            }
            while (true) {
                skipWhitespace()
                if (atEnd() || src[i] != '"') fail("expected a key in quotes")
                val key = parseString()
                skipWhitespace()
                if (atEnd() || src[i] != ':') fail("expected ':' after the key")
                i++
                skipWhitespace()
                entries.add(key to parseValue())
                skipWhitespace()
                if (atEnd()) fail("expected ',' or '}'")
                when (src[i]) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return Obj(entries)
                    }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun parseArray(): Node {
            i++
            val items = mutableListOf<Node>()
            skipWhitespace()
            if (!atEnd() && src[i] == ']') {
                i++
                return Arr(items)
            }
            while (true) {
                skipWhitespace()
                items.add(parseValue())
                skipWhitespace()
                if (atEnd()) fail("expected ',' or ']'")
                when (src[i]) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return Arr(items)
                    }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun parseString(): String {
            i++
            val out = StringBuilder()
            while (true) {
                if (atEnd()) fail("the string is never closed")
                val c = src[i]
                when {
                    c == '"' -> {
                        i++
                        return out.toString()
                    }
                    c == '\\' -> {
                        i++
                        if (atEnd()) fail("the string is never closed")
                        when (val esc = src[i]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (i + 4 >= src.length) fail("a \\u escape needs four digits")
                                val hex = src.substring(i + 1, i + 5)
                                val code = hex.toIntOrNull(16)
                                    ?: fail("'" + hex + "' is not four hex digits")
                                out.append(code.toChar())
                                i += 4
                            }
                            else -> fail("'\\" + esc + "' is not an escape")
                        }
                        i++
                    }
                    // A raw control character inside a string is invalid JSON,
                    // and is nearly always an unescaped newline in hand-typed
                    // input. Worth naming, because the fix is not obvious.
                    c < ' ' -> fail("a control character must be escaped")
                    else -> {
                        out.append(c)
                        i++
                    }
                }
            }
        }

        private fun parseNumber(): Node {
            val start = i
            if (!atEnd() && src[i] == '-') i++
            while (!atEnd() && src[i].isDigit()) i++
            if (!atEnd() && src[i] == '.') {
                i++
                if (atEnd() || !src[i].isDigit()) fail("expected digits after the decimal point")
                while (!atEnd() && src[i].isDigit()) i++
            }
            if (!atEnd() && (src[i] == 'e' || src[i] == 'E')) {
                i++
                if (!atEnd() && (src[i] == '+' || src[i] == '-')) i++
                if (atEnd() || !src[i].isDigit()) fail("expected digits in the exponent")
                while (!atEnd() && src[i].isDigit()) i++
            }
            val raw = src.substring(start, i)
            if (raw.isEmpty() || raw == "-") fail("expected a number")
            return Num(raw)
        }
    }

    // -- Rendering -----------------------------------------------------------

    private fun render(node: Node, indent: Int, depth: Int): String {
        val pad = if (indent > 0) " ".repeat(indent * (depth + 1)) else ""
        val closePad = if (indent > 0) " ".repeat(indent * depth) else ""
        val newline = if (indent > 0) "\n" else ""
        val space = if (indent > 0) " " else ""

        return when (node) {
            is Str -> quote(node.value)
            is Num -> node.raw
            is Bool -> node.value.toString()
            Nul -> "null"
            is Arr ->
                if (node.items.isEmpty()) {
                    "[]"
                } else {
                    node.items.joinToString(
                        separator = "," + newline + pad,
                        prefix = "[" + newline + pad,
                        postfix = newline + closePad + "]",
                    ) { render(it, indent, depth + 1) }
                }
            is Obj ->
                if (node.entries.isEmpty()) {
                    "{}"
                } else {
                    node.entries.joinToString(
                        separator = "," + newline + pad,
                        prefix = "{" + newline + pad,
                        postfix = newline + closePad + "}",
                    ) { entry ->
                        quote(entry.first) + ":" + space + render(entry.second, indent, depth + 1)
                    }
                }
        }
    }

    private fun quote(value: String): String = buildString {
        append('"')
        for (c in value) {
            when {
                c == '"' -> append("\\\"")
                c == '\\' -> append("\\\\")
                c == '\n' -> append("\\n")
                c == '\r' -> append("\\r")
                c == '\t' -> append("\\t")
                c < ' ' -> append("\\u%04x".format(c.code))
                else -> append(c)
            }
        }
        append('"')
    }
}
