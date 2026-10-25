package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class WatermarkCoverTest {
    @Test
    fun copiesTheBackdropRowOverTheMeasuredTextBox() {
        val width = WatermarkCover.SRC_W
        val height = WatermarkCover.SRC_H
        val rgb = ByteArray(width * height * 3) { 40 }
        val sampleY = WatermarkCover.Y - WatermarkCover.SAMPLE_ABOVE
        for (x in 0 until width) {
            val i = (sampleY * width + x) * 3
            rgb[i] = 9
            rgb[i + 1] = 8
            rgb[i + 2] = 7
        }
        val textX = WatermarkCover.X + 4
        val textY = WatermarkCover.Y + 4
        val text = (textY * width + textX) * 3
        rgb[text] = 255.toByte()
        rgb[text + 1] = 255.toByte()
        rgb[text + 2] = 255.toByte()

        WatermarkCover.cover(rgb, width, height)

        assertEquals(9.toByte(), rgb[text])
        assertEquals(8.toByte(), rgb[text + 1])
        assertEquals(7.toByte(), rgb[text + 2])
    }
}
