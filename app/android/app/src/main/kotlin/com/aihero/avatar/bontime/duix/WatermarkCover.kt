package com.aihero.avatar.bontime.duix

/**
 * Covers the backdrop text on a Lily frame by copying the row just above it.
 * The box was measured on the 540x960 public frames; other sizes scale from that.
 */
internal object WatermarkCover {
    const val SRC_W = 540
    const val SRC_H = 960
    const val X = 70
    const val Y = 82
    const val BOX_W = 125
    const val BOX_H = 36
    const val SAMPLE_ABOVE = 6

    fun cover(rgb: ByteArray, width: Int, height: Int) {
        if (width < 2 || height < 2 || rgb.size < width * height * 3) return
        val x0 = X * width / SRC_W
        val y0 = Y * height / SRC_H
        val x1 = ((X + BOX_W) * width / SRC_W).coerceAtMost(width)
        val y1 = ((Y + BOX_H) * height / SRC_H).coerceAtMost(height)
        val sampleY = (y0 - SAMPLE_ABOVE * height / SRC_H).coerceAtLeast(0)
        for (y in y0 until y1) {
            for (x in x0 until x1) {
                val src = (sampleY * width + x) * 3
                val dst = (y * width + x) * 3
                rgb[dst] = rgb[src]
                rgb[dst + 1] = rgb[src + 1]
                rgb[dst + 2] = rgb[src + 2]
            }
        }
    }
}
