package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class SegmentPaddingTest {
    @Test
    fun padsShortSegmentsToTheMinimum() {
        assertEquals(32_000, SegmentPadding.pad16(0, 1000))
        assertEquals(22_000, SegmentPadding.pad16(10_000, 1000))
        assertEquals(0, SegmentPadding.pad16(32_000, 1000))
        assertEquals(0, SegmentPadding.pad16(40_000, 1000))
    }

    @Test
    fun padsTheMatching24kStreamWithEvenBytes() {
        assertEquals(33_000, SegmentPadding.pad24(22_000))
        assertEquals(2, SegmentPadding.pad24(2))
        assertEquals(0, SegmentPadding.pad24(0))
    }

    @Test
    fun keepsOddInputEven() {
        assertEquals(0, SegmentPadding.pad16(10_001, 1000) % 2)
    }
}
