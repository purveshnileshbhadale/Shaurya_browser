package dev.shaurya.browser.search

import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * Instant answers: the things a search box should answer without a network.
 *
 * Arithmetic, unit conversion and base conversion account for a large share
 * of what people type into a search field, and every one of them is a round
 * trip to a server for an answer the device could have given immediately.
 * Doing them locally is faster, works on a train, and — for a browser that
 * makes a point of not leaking what you are doing — means the query never
 * leaves the phone.
 *
 * Deliberately no `eval`: the expression parser below is a recursive-descent
 * reader over a fixed grammar, so a query is arithmetic or it is nothing.
 * There is no path from a typed string to code execution.
 */
object Instant {

    /** An answer worth showing above the results. */
    data class Answer(val value: String, val detail: String)

    /** Try every instant-answer form in turn. Null means "just search". */
    fun answer(query: String): Answer? {
        val q = query.trim()
        if (q.isEmpty()) return null
        return convert(q) ?: base(q) ?: arithmetic(q)
    }

    // ---- arithmetic -------------------------------------------------------

    private fun arithmetic(input: String): Answer? {
        // Require an operator, or "42" alone would render an "answer" of 42.
        if (!input.any { it in "+-*/%^" }) return null
        val value = runCatching { Expr(input).parse() }.getOrNull() ?: return null
        if (!value.isFinite()) return null
        return Answer(format(value), "=  $input")
    }

    /**
     * A recursive-descent reader for `+ - * / % ^`, parentheses and unary
     * minus. Throws on anything it does not recognise, which the caller
     * treats as "not a calculation".
     */
    private class Expr(private val src: String) {
        private var pos = 0

        fun parse(): Double {
            val v = addSub()
            skipSpace()
            if (pos != src.length) throw IllegalArgumentException("trailing input")
            return v
        }

        private fun skipSpace() { while (pos < src.length && src[pos] == ' ') pos++ }

        private fun eat(c: Char): Boolean {
            skipSpace()
            if (pos < src.length && src[pos] == c) { pos++; return true }
            return false
        }

        private fun addSub(): Double {
            var v = mulDiv()
            while (true) {
                v = when {
                    eat('+') -> v + mulDiv()
                    eat('-') -> v - mulDiv()
                    else -> return v
                }
            }
        }

        private fun mulDiv(): Double {
            var v = power()
            while (true) {
                v = when {
                    eat('*') -> v * power()
                    eat('/') -> v / power()
                    eat('%') -> v.mod(power())
                    else -> return v
                }
            }
        }

        private fun power(): Double {
            val base = unary()
            // Right-associative, as everywhere else that has this operator.
            return if (eat('^')) base.pow(power()) else base
        }

        private fun unary(): Double {
            if (eat('-')) return -unary()
            if (eat('+')) return unary()
            return atom()
        }

        private fun atom(): Double {
            skipSpace()
            if (eat('(')) {
                val v = addSub()
                if (!eat(')')) throw IllegalArgumentException("unclosed bracket")
                return v
            }
            val start = pos
            while (pos < src.length && (src[pos].isDigit() || src[pos] == '.')) pos++
            if (pos == start) throw IllegalArgumentException("expected a number")
            return src.substring(start, pos).toDouble()
        }
    }

    // ---- unit conversion --------------------------------------------------

    /** Every unit, as a factor to its family's base, keyed by every spelling. */
    private data class Unit(val family: String, val factor: Double, val offset: Double = 0.0)

    private val UNITS: Map<String, Unit> = buildMap {
        fun put(u: Unit, vararg names: String) = names.forEach { put(it, u) }

        // length, base metre
        put(Unit("length", 0.001), "mm", "millimetre", "millimeter", "millimetres", "millimeters")
        put(Unit("length", 0.01), "cm", "centimetre", "centimeter", "centimetres", "centimeters")
        put(Unit("length", 1.0), "m", "metre", "meter", "metres", "meters")
        put(Unit("length", 1000.0), "km", "kilometre", "kilometer", "kilometres", "kilometers")
        put(Unit("length", 0.0254), "in", "inch", "inches")
        put(Unit("length", 0.3048), "ft", "foot", "feet")
        put(Unit("length", 0.9144), "yd", "yard", "yards")
        put(Unit("length", 1609.344), "mi", "mile", "miles")

        // mass, base kilogram
        put(Unit("mass", 0.001), "g", "gram", "grams")
        put(Unit("mass", 1.0), "kg", "kilogram", "kilograms")
        put(Unit("mass", 0.45359237), "lb", "lbs", "pound", "pounds")
        put(Unit("mass", 0.028349523125), "oz", "ounce", "ounces")
        put(Unit("mass", 6.35029318), "st", "stone")
        put(Unit("mass", 1000.0), "t", "tonne", "tonnes")

        // data, base byte. Decimal and binary kept distinct on purpose: a
        // browser that says 1 MB = 1048576 B is wrong about downloads.
        put(Unit("data", 1.0), "b", "byte", "bytes")
        put(Unit("data", 1_000.0), "kb", "kilobyte", "kilobytes")
        put(Unit("data", 1_000_000.0), "mb", "megabyte", "megabytes")
        put(Unit("data", 1_000_000_000.0), "gb", "gigabyte", "gigabytes")
        put(Unit("data", 1_000_000_000_000.0), "tb", "terabyte", "terabytes")
        put(Unit("data", 1024.0), "kib", "kibibyte", "kibibytes")
        put(Unit("data", 1048576.0), "mib", "mebibyte", "mebibytes")
        put(Unit("data", 1073741824.0), "gib", "gibibyte", "gibibytes")

        // time, base second
        put(Unit("time", 1.0), "s", "sec", "secs", "second", "seconds")
        put(Unit("time", 60.0), "min", "mins", "minute", "minutes")
        put(Unit("time", 3600.0), "h", "hr", "hrs", "hour", "hours")
        put(Unit("time", 86400.0), "d", "day", "days")
        put(Unit("time", 604800.0), "wk", "week", "weeks")

        // temperature, base celsius, with an offset
        put(Unit("temp", 1.0, 0.0), "c", "celsius", "centigrade")
        put(Unit("temp", 5.0 / 9.0, -32.0), "f", "fahrenheit")
        put(Unit("temp", 1.0, -273.15), "k", "kelvin")
    }

    private val CONVERT = Regex(
        """^\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s+(?:in|to|as)\s+([a-zA-Z°]+)\s*$""",
        RegexOption.IGNORE_CASE,
    )

    private fun convert(input: String): Answer? {
        val m = CONVERT.find(input) ?: return null
        val amount = m.groupValues[1].toDoubleOrNull() ?: return null
        val from = UNITS[normalise(m.groupValues[2])] ?: return null
        val to = UNITS[normalise(m.groupValues[3])] ?: return null
        // "5 km in kg" is a typo, not a question. Refusing beats answering.
        if (from.family != to.family) return null

        val base = (amount + from.offset) * from.factor
        val out = base / to.factor - to.offset
        return Answer(
            "${format(out)} ${m.groupValues[3]}",
            "${format(amount)} ${m.groupValues[2]}",
        )
    }

    private fun normalise(unit: String) = unit.lowercase().removePrefix("°")

    // ---- number bases -----------------------------------------------------

    private val BASE = Regex(
        """^\s*(0x[0-9a-f]+|0b[01]+|\d+)\s+(?:in|to|as)\s+(hex|hexadecimal|bin|binary|dec|decimal)\s*$""",
        RegexOption.IGNORE_CASE,
    )

    private fun base(input: String): Answer? {
        val m = BASE.find(input) ?: return null
        val raw = m.groupValues[1].lowercase()
        val value = runCatching {
            when {
                raw.startsWith("0x") -> raw.removePrefix("0x").toLong(16)
                raw.startsWith("0b") -> raw.removePrefix("0b").toLong(2)
                else -> raw.toLong()
            }
        }.getOrNull() ?: return null

        val out = when (m.groupValues[2].lowercase()) {
            "hex", "hexadecimal" -> "0x" + value.toString(16).uppercase()
            "bin", "binary" -> "0b" + value.toString(2)
            else -> value.toString()
        }
        return Answer(out, m.groupValues[1])
    }

    // ---- formatting -------------------------------------------------------

    /**
     * Render a result without floating-point noise.
     *
     * `0.1 + 0.2` must not display as `0.30000000000000004`, and a whole
     * number must not display as `42.0`.
     */
    fun format(value: Double): String {
        if (!value.isFinite()) return "—"
        val rounded = (value * 1e6).roundToLong() / 1e6
        if (abs(rounded) < 1e15 && rounded == rounded.toLong().toDouble()) {
            return rounded.toLong().toString()
        }
        return rounded.toString().trimEnd('0').trimEnd('.')
    }
}
