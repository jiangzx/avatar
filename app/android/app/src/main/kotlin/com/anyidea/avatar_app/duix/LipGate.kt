package com.anyidea.avatar_app.duix

/** Starts playback once lip features are ready, or without lips after [timeoutMs] so a reply is never silent. */
class LipGate(private val timeoutMs: Long) {
    enum class Decision { WAIT, START, START_NO_LIPS }

    private var firstAudioAt = -1L
    private var started = false

    fun reset() {
        firstAudioAt = -1L
        started = false
    }

    fun onAudio(nowMs: Long) {
        if (firstAudioAt < 0) firstAudioAt = nowMs
    }

    fun decide(nowMs: Long, readyCount: Int): Decision {
        if (started || firstAudioAt < 0) return Decision.WAIT
        if (readyCount > 0) {
            started = true
            return Decision.START
        }
        if (nowMs - firstAudioAt >= timeoutMs) {
            started = true
            return Decision.START_NO_LIPS
        }
        return Decision.WAIT
    }
}
