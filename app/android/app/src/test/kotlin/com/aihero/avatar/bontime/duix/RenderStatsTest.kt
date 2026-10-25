package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RenderStatsTest {
    @Test
    fun reportsOncePerInterval() {
        val stats = RenderStats(1000)
        assertNull(stats.onFrame(0, 10, lipFrame = false))
        assertNull(stats.onFrame(400, 50, lipFrame = true))
        val snap = stats.onFrame(1000, 20, lipFrame = true)!!
        assertEquals(RenderStats.Snapshot(fps = 3, lipFrames = 2, slowFrames = 1, maxFrameMs = 50), snap)
    }

    @Test
    fun startsAFreshWindowAfterEachReport() {
        val stats = RenderStats(1000)
        stats.onFrame(0, 10, lipFrame = true)
        stats.onFrame(1000, 10, lipFrame = true)
        assertNull(stats.onFrame(1500, 10, lipFrame = false))
        val snap = stats.onFrame(2000, 60, lipFrame = false)!!
        assertEquals(RenderStats.Snapshot(fps = 2, lipFrames = 0, slowFrames = 1, maxFrameMs = 60), snap)
    }
}
