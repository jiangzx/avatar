package com.aihero.avatar.bontime.duix

/** Duix computes lip features only after 800 ms of audio; shorter segments are padded with silence. */
object SegmentPadding {
    /** Bytes of 16 kHz PCM16 silence needed after [pushed16Bytes]; always even. */
    fun pad16(pushed16Bytes: Long, minSegmentMs: Int): Int {
        val min = 16_000L * 2 * minSegmentMs / 1000
        if (pushed16Bytes >= min) return 0
        return ((min - pushed16Bytes + 1) and 1L.inv()).toInt()
    }

    /** The same duration of 24 kHz PCM16 silence, so audio and lips stay equally long; always even. */
    fun pad24(pad16Bytes: Int): Int = ((pad16Bytes.toLong() * 3 / 2) and 1L.inv()).toInt()
}
