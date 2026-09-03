package dev.shaurya.browser.tools

/**
 * A work timer.
 *
 * Pomodoro's shape — work, short break, work, short break, work, short break,
 * work, long break — expressed as arithmetic on elapsed seconds rather than
 * as a state machine with a tick handler. That means the phase can be
 * recomputed from a start timestamp after the app was killed, which is the
 * difference between a timer and a timer that only works while you are
 * looking at it.
 */
object FocusTimer {

    enum class Phase { WORK, SHORT_BREAK, LONG_BREAK }

    data class Plan(
        val workMinutes: Int = 25,
        val shortBreakMinutes: Int = 5,
        val longBreakMinutes: Int = 15,
        /** Work blocks before the long break. */
        val blocksPerCycle: Int = 4,
    ) {
        val cycleSeconds: Int
            get() = blocksPerCycle * (workMinutes + shortBreakMinutes) * 60 +
                (longBreakMinutes - shortBreakMinutes) * 60
    }

    /** Where the timer is right now. */
    data class State(
        val phase: Phase,
        /** Seconds left in this phase. */
        val remaining: Int,
        /** Completed work blocks since the timer started. */
        val completedBlocks: Int,
    )

    /**
     * The phase at [elapsedSeconds] into a run.
     *
     * Walks the cycle rather than dividing, because the long break makes the
     * cycle uneven and the walk is four iterations at most.
     */
    fun stateAt(elapsedSeconds: Long, plan: Plan = Plan()): State {
        require(plan.workMinutes > 0) { "a work block of zero never ends" }
        require(plan.blocksPerCycle > 0) { "a cycle needs at least one work block" }

        val cycle = plan.cycleSeconds.toLong()
        var offset = if (elapsedSeconds <= 0) 0L else elapsedSeconds % cycle
        val cyclesDone = if (elapsedSeconds <= 0) 0L else elapsedSeconds / cycle
        var blocks = (cyclesDone * plan.blocksPerCycle).toInt()

        for (block in 1..plan.blocksPerCycle) {
            val work = plan.workMinutes * 60L
            if (offset < work) {
                return State(Phase.WORK, (work - offset).toInt(), blocks)
            }
            offset -= work
            blocks++

            val last = block == plan.blocksPerCycle
            val breakPhase = if (last) Phase.LONG_BREAK else Phase.SHORT_BREAK
            val rest = (if (last) plan.longBreakMinutes else plan.shortBreakMinutes) * 60L
            if (offset < rest) {
                return State(breakPhase, (rest - offset).toInt(), blocks)
            }
            offset -= rest
        }

        // Unreachable: the loop covers a whole cycle and `offset` started
        // inside one. Stated rather than left to fall through, so a future
        // change to the cycle shape fails loudly here.
        error("focus timer walked past the end of its cycle")
    }

    /** "24:59", the way a clock is read. */
    fun clock(seconds: Int): String {
        val safe = seconds.coerceAtLeast(0)
        return "%d:%02d".format(safe / 60, safe % 60)
    }

    fun label(phase: Phase): String = when (phase) {
        Phase.WORK -> "Focus"
        Phase.SHORT_BREAK -> "Short break"
        Phase.LONG_BREAK -> "Long break"
    }
}
