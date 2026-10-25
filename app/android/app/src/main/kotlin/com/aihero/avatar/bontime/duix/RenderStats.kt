package com.aihero.avatar.bontime.duix

/** Content-free render counters, reported once per interval. */
class RenderStats(private val intervalMs: Long) {
    data class Snapshot(val fps: Int, val lipFrames: Int, val slowFrames: Int, val maxFrameMs: Int)

    private var windowStart = -1L
    private var frames = 0
    private var lip = 0
    private var slow = 0
    private var maxMs = 0L

    fun onFrame(nowMs: Long, frameMs: Long, lipFrame: Boolean): Snapshot? {
        if (windowStart < 0) windowStart = nowMs
        frames++
        if (lipFrame) lip++
        if (frameMs > FRAME_BUDGET_MS) slow++
        if (frameMs > maxMs) maxMs = frameMs
        val elapsed = nowMs - windowStart
        if (elapsed < intervalMs) return null
        val snap = Snapshot((frames * 1000L / elapsed).toInt(), lip, slow, maxMs.toInt())
        windowStart = nowMs
        frames = 0
        lip = 0
        slow = 0
        maxMs = 0L
        return snap
    }

    private companion object {
        const val FRAME_BUDGET_MS = 40L
    }
}
