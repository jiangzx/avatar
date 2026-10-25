package com.anyidea.avatar_app.duix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SeqDropTest {
    @Test
    fun aDroppedSeqIsRejectedAndTheNextOneIsAccepted() {
        val drop = SeqDrop()
        assertTrue(drop.accept(1))
        drop.drop(0)
        assertTrue(drop.accept(4))
        drop.drop(4)
        assertFalse(drop.accept(4))
        assertTrue(drop.accept(5))
    }
}
