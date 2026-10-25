package com.aihero.avatar.bontime.duix

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 24 kHz reply player for Duix mode; its head position is also the lip clock.
 * Same attributes as flutter_pcm_sound (USAGE_MEDIA / CONTENT_TYPE_MUSIC) so echo cancellation behaves alike.
 */
class DuixAudioPlayer(private val listener: Listener) {
    interface Listener {
        /** Real audio of [seq] has played out (padding excluded). Called on the writer thread. */
        fun onEnded(seq: Int, playedMs: Int)

        /** Playback of [seq] failed and was dropped. Called on the writer or caller thread. */
        fun onError(seq: Int, code: String)
    }

    data class StopResult(val seq: Int, val playedMs: Int)

    private class Chunk(val generation: Int, val bytes: ByteArray)

    private val lock = Any()
    private val clock = AudioClock(SAMPLE_RATE)
    private val queue = LinkedBlockingQueue<Chunk>()
    private val track: AudioTrack = AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build(),
        )
        .setAudioFormat(
            AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build(),
        )
        .setBufferSizeInBytes(
            maxOf(
                AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT),
                SAMPLE_RATE * 2 / 10, // >= 100 ms
            ),
        )
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()

    // All fields below are guarded by lock.
    private var generation = 0
    private var seq = 0
    private var realFrames = 0L
    private var endMarked = false
    private var playing = false

    @Volatile
    private var running = true
    private val writer = Thread({ writeLoop() }, "duix-audio").apply {
        isDaemon = true
        start()
    }

    /** Drops anything queued and arms [seq]; the track stays paused until [play]. */
    fun begin(seq: Int) {
        synchronized(lock) {
            generation++
            queue.clear()
            resetTrack()
            this.seq = seq
            realFrames = 0L
            endMarked = false
            clock.begin(track.playbackHeadPosition)
        }
    }

    /** Queues PCM16 for [seq]; [real] is false for padding silence, which never counts as played. */
    fun enqueue(seq: Int, pcm24: ByteArray, real: Boolean) {
        if (pcm24.isEmpty()) return
        synchronized(lock) {
            if (seq != this.seq) return
            if (real) realFrames += pcm24.size / 2
            queue.add(Chunk(generation, pcm24))
        }
    }

    fun markEnd(seq: Int) {
        synchronized(lock) {
            if (seq == this.seq) endMarked = true
        }
    }

    /** Starts the track for [seq]; false when [seq] is not active, already playing, or the track failed. */
    fun play(seq: Int): Boolean {
        val failed = synchronized(lock) {
            if (seq != this.seq || playing) return false
            try {
                track.play()
                playing = true
                false
            } catch (e: IllegalStateException) {
                true
            }
        }
        if (failed) {
            dropActive(generationSnapshot(), "play_failed")
            return false
        }
        return true
    }

    fun isPlaying(seq: Int): Boolean = synchronized(lock) { playing && seq == this.seq }

    fun lipIndex(): Int = synchronized(lock) { clock.lipIndex(track.playbackHeadPosition) }

    /** Silences at once and reports how much real audio was heard. Safe from any thread. */
    fun hardStop(): StopResult {
        synchronized(lock) {
            val stopped = seq
            if (stopped == 0) return StopResult(0, 0)
            val ms = clock.playedMs(track.playbackHeadPosition, realFrames)
            generation++
            queue.clear()
            resetTrack()
            seq = 0
            endMarked = false
            return StopResult(stopped, ms)
        }
    }

    fun release() {
        running = false
        writer.interrupt()
        writer.join(WRITER_JOIN_MS)
        synchronized(lock) {
            seq = 0
            queue.clear()
            resetTrack()
            track.release()
        }
    }

    private fun generationSnapshot(): Int = synchronized(lock) { generation }

    /** Caller holds lock. */
    private fun resetTrack() {
        if (playing) {
            try {
                track.pause()
            } catch (_: IllegalStateException) {
            }
        }
        try {
            track.flush()
        } catch (_: IllegalStateException) {
        }
        playing = false
    }

    private fun writeLoop() {
        var chunk: Chunk? = null
        var offset = 0
        try {
            while (running) {
                checkEnded()
                val current = chunk ?: queue.poll(POLL_MS, TimeUnit.MILLISECONDS)?.also { offset = 0 }
                if (current == null) continue
                val written = synchronized(lock) {
                    if (current.generation != generation) {
                        WRITE_STALE
                    } else {
                        track.write(current.bytes, offset, current.bytes.size - offset, AudioTrack.WRITE_NON_BLOCKING)
                    }
                }
                when {
                    written == WRITE_STALE -> chunk = null
                    written < 0 -> {
                        chunk = null
                        dropActive(current.generation, "write_${-written}")
                    }
                    else -> {
                        offset += written
                        if (offset >= current.bytes.size) {
                            chunk = null
                        } else {
                            chunk = current
                            if (written == 0) Thread.sleep(FULL_SLEEP_MS) // buffer full: wait, never spin
                        }
                    }
                }
            }
        } catch (_: InterruptedException) {
            // release() stops the writer
        }
    }

    private fun checkEnded() {
        val ended: StopResult
        synchronized(lock) {
            if (!endMarked || seq == 0 || !playing) return
            val head = track.playbackHeadPosition
            if (clock.playedFrames(head) < realFrames) return
            ended = StopResult(seq, clock.playedMs(head, realFrames))
            // Real audio is done. Drop the padding still queued and leave the track paused,
            // so the tail silence is not played and the track does not idle in PLAYING.
            generation++
            queue.clear()
            resetTrack()
            seq = 0
            endMarked = false
        }
        listener.onEnded(ended.seq, ended.playedMs)
    }

    private fun dropActive(chunkGeneration: Int, code: String) {
        val failed: Int
        synchronized(lock) {
            if (chunkGeneration != generation || seq == 0) return
            failed = seq
            generation++
            queue.clear()
            resetTrack()
            seq = 0
            endMarked = false
        }
        listener.onError(failed, code)
    }

    private companion object {
        const val SAMPLE_RATE = 24_000
        const val POLL_MS = 20L
        const val FULL_SLEEP_MS = 5L
        const val WRITER_JOIN_MS = 500L
        const val WRITE_STALE = Int.MIN_VALUE
    }
}
