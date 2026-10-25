package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class SilenceLoopTest {
    @Test
    fun playsForwardThenBackwardLikeTheSdk() {
        val loop = SilenceLoop(listOf("a", "b", "c"))
        assertEquals(listOf("a", "b", "c", "c", "b", "a", "a", "b"), List(8) { loop.next() })
    }

    @Test
    fun singleFrameRepeats() {
        val loop = SilenceLoop(listOf("a"))
        assertEquals(listOf("a", "a", "a"), List(3) { loop.next() })
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAnEmptyRegion() {
        SilenceLoop(emptyList<String>())
    }
}
