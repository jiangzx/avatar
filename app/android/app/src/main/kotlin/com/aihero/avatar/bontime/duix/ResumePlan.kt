package com.aihero.avatar.bontime.duix

/** HTTP range decisions for resuming a partial download. */
object ResumePlan {
    fun rangeHeader(partBytes: Long, expectedBytes: Long): String? =
        if (partBytes in 1 until expectedBytes) "bytes=$partBytes-" else null

    fun canAppend(requestedRange: Boolean, status: Int): Boolean = requestedRange && status == 206
}
