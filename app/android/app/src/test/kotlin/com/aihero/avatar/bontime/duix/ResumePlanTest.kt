package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumePlanTest {
    @Test
    fun asksForTheRestOfAPartialFile() {
        assertEquals("bytes=100-", ResumePlan.rangeHeader(100, 1000))
        assertNull(ResumePlan.rangeHeader(0, 1000))
        assertNull(ResumePlan.rangeHeader(1000, 1000))
    }

    @Test
    fun appendsOnlyOnPartialContent() {
        assertTrue(ResumePlan.canAppend(requestedRange = true, status = 206))
        assertFalse(ResumePlan.canAppend(requestedRange = true, status = 200))
        assertFalse(ResumePlan.canAppend(requestedRange = false, status = 206))
    }
}
