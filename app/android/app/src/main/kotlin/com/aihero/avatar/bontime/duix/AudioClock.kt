package com.aihero.avatar.bontime.duix

/** Turns AudioTrack head positions (unsigned 32-bit) into per-segment played time. */
class AudioClock(private val sampleRate: Int) {
    private var base = 0L

    fun begin(headFrames: Int) {
        base = unsigned(headFrames)
    }

    fun playedFrames(headFrames: Int): Long = (unsigned(headFrames) - base) and MASK

    fun playedMs(headFrames: Int, realFrames: Long): Int =
        (minOf(playedFrames(headFrames), realFrames) * 1000 / sampleRate).toInt()

    /** Duix lip features are indexed in 40 ms blocks. */
    fun lipIndex(headFrames: Int): Int = (playedFrames(headFrames) * 1000 / sampleRate / 40).toInt()

    private companion object {
        const val MASK = 0xffffffffL
        fun unsigned(value: Int): Long = value.toLong() and MASK
    }
}
