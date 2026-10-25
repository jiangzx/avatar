package com.aihero.avatar.bontime.duix

/** Idle frame order: forward then backward, as the SDK does, so the loop never jumps. */
class SilenceLoop<T>(frames: List<T>) {
    private val order: List<T>
    private var index = 0

    init {
        require(frames.isNotEmpty()) { "empty silence region" }
        order = frames + frames.asReversed()
    }

    fun next(): T {
        val frame = order[index]
        index = (index + 1) % order.size
        return frame
    }
}
