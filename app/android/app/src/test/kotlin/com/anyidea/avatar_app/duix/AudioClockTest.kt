package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioClockTest {
    @Test
    fun measuresFromTheSegmentBase() {
        val clock = AudioClock(24_000)
        clock.begin(1_000)
        assertEquals(24_000L, clock.playedFrames(25_000))
        assertEquals(1_000, clock.playedMs(25_000, realFrames = 48_000))
        assertEquals(25, clock.lipIndex(25_000))
    }

    @Test
    fun clampsToRealAudio() {
        val clock = AudioClock(24_000)
        clock.begin(0)
        assertEquals(500, clock.playedMs(48_000, realFrames = 12_000))
    }

    @Test
    fun survivesHeadWrapAround() {
        val clock = AudioClock(24_000)
        clock.begin(-10) // unsigned 4294967286
        assertEquals(15L, clock.playedFrames(5))
    }
}
