package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class LipGateTest {
    @Test
    fun waitsUntilAudioArrives() {
        val gate = LipGate(1500)
        assertEquals(LipGate.Decision.WAIT, gate.decide(0, readyCount = 5))
    }

    @Test
    fun startsWithLipsOnceFeaturesAreReady() {
        val gate = LipGate(1500)
        gate.onAudio(100)
        assertEquals(LipGate.Decision.WAIT, gate.decide(200, readyCount = 0))
        assertEquals(LipGate.Decision.START, gate.decide(900, readyCount = 1))
        assertEquals(LipGate.Decision.WAIT, gate.decide(950, readyCount = 3))
    }

    @Test
    fun startsWithoutLipsAfterTheTimeoutSoTheReplyIsNeverSilent() {
        val gate = LipGate(1500)
        gate.onAudio(100)
        assertEquals(LipGate.Decision.WAIT, gate.decide(1599, readyCount = 0))
        assertEquals(LipGate.Decision.START_NO_LIPS, gate.decide(1600, readyCount = 0))
        assertEquals(LipGate.Decision.WAIT, gate.decide(1700, readyCount = 1))
    }

    @Test
    fun resetArmsTheNextSegment() {
        val gate = LipGate(1500)
        gate.onAudio(0)
        gate.decide(10, readyCount = 1)
        gate.reset()
        gate.onAudio(2000)
        assertEquals(LipGate.Decision.START, gate.decide(2010, readyCount = 1))
    }

    @Test
    fun keepsTheFirstAudioTime() {
        val gate = LipGate(1500)
        gate.onAudio(100)
        gate.onAudio(1000)
        assertEquals(LipGate.Decision.START_NO_LIPS, gate.decide(1600, readyCount = 0))
    }
}
