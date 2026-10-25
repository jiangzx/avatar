# Task 4: 24 kHz 播放器、口型时钟、短段补齐、口型门

**Files:**
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/AudioClock.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SegmentPadding.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/LipGate.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixAudioPlayer.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/AudioClockTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SegmentPaddingTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/LipGateTest.kt`

**Interfaces:**
- Consumes: —
- Produces:
  - `class AudioClock(sampleRate: Int)`：`begin(headFrames: Int)`、`playedFrames(headFrames: Int): Long`、`playedMs(headFrames: Int, realFrames: Long): Int`、`lipIndex(headFrames: Int): Int`；
  - `object SegmentPadding`：`pad16(pushed16Bytes: Long, minSegmentMs: Int): Int`、`pad24(pad16Bytes: Int): Int`；
  - `class LipGate(timeoutMs: Long)`：`reset()`、`onAudio(nowMs)`、`decide(nowMs, readyCount): Decision`，其中 `Decision` 取值 `WAIT`、`START`、`START_NO_LIPS`；
  - `class DuixAudioPlayer(listener)`，内含 `StopResult(seq, playedMs)`，接口见总览。

背景（spec §4.1、§4.2）：
- 口型时钟就是这条 24 kHz AudioTrack 的播放头，`lipIndex = 已播帧数 × 1000 / 24000 / 40`。
- AudioTrack 的播放头是一个按无符号 32 位理解的 int，所以每段记一个基准值，按 2³² 取模相减。
- 不到 `minSegmentMs` 的段用静音补齐，否则 Duix 永远不出口型，也不会结束。
- 「播完」指真实音频播完，补的静音不算。

- [x] **Step 1: 写失败的测试**

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/AudioClockTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioClockTest {
    @Test
    fun measuresFromTheSegmentBase() {
        val clock = AudioClock(24_000)
        clock.begin(1_000)
        assertEquals(24_000L, clock.playedFrames(25_000))
        assertEquals(1_000, clock.playedMs(25_000, realFrames = 48_000))
        assertEquals(25, clock.lipIndex(25_000))
    }

    @Test
    fun clampsToRealAudio() {
        val clock = AudioClock(24_000)
        clock.begin(0)
        assertEquals(500, clock.playedMs(48_000, realFrames = 12_000))
    }

    @Test
    fun survivesHeadWrapAround() {
        val clock = AudioClock(24_000)
        clock.begin(-10) // unsigned 4294967286
        assertEquals(15L, clock.playedFrames(5))
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SegmentPaddingTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class SegmentPaddingTest {
    @Test
    fun padsShortSegmentsToTheMinimum() {
        assertEquals(32_000, SegmentPadding.pad16(0, 1000))
        assertEquals(22_000, SegmentPadding.pad16(10_000, 1000))
        assertEquals(0, SegmentPadding.pad16(32_000, 1000))
        assertEquals(0, SegmentPadding.pad16(40_000, 1000))
    }

    @Test
    fun padsTheMatching24kStreamWithEvenBytes() {
        assertEquals(33_000, SegmentPadding.pad24(22_000))
        assertEquals(2, SegmentPadding.pad24(2))
        assertEquals(0, SegmentPadding.pad24(0))
    }

    @Test
    fun keepsOddInputEven() {
        assertEquals(0, SegmentPadding.pad16(10_001, 1000) % 2)
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/LipGateTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

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
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：编译失败，报 `Unresolved reference: AudioClock`、`SegmentPadding`、`LipGate`。

- [x] **Step 3: 写纯逻辑**

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/AudioClock.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** Turns AudioTrack head positions (unsigned 32-bit) into per-segment played time. */
class AudioClock(private val sampleRate: Int) {
    private var base = 0L

    fun begin(headFrames: Int) {
        base = unsigned(headFrames)
    }

    fun playedFrames(headFrames: Int): Long = (unsigned(headFrames) - base) and MASK

    fun playedMs(headFrames: Int, realFrames: Long): Int =
        (minOf(playedFrames(headFrames), realFrames) * 1000 / sampleRate).toInt()

    /** Duix lip features are indexed in 40 ms blocks. */
    fun lipIndex(headFrames: Int): Int = (playedFrames(headFrames) * 1000 / sampleRate / 40).toInt()

    private companion object {
        const val MASK = 0xffffffffL
        fun unsigned(value: Int): Long = value.toLong() and MASK
    }
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SegmentPadding.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** Duix computes lip features only after 800 ms of audio; shorter segments are padded with silence. */
object SegmentPadding {
    /** Bytes of 16 kHz PCM16 silence needed after [pushed16Bytes]; always even. */
    fun pad16(pushed16Bytes: Long, minSegmentMs: Int): Int {
        val min = 16_000L * 2 * minSegmentMs / 1000
        if (pushed16Bytes >= min) return 0
        return ((min - pushed16Bytes + 1) and 1L.inv()).toInt()
    }

    /** The same duration of 24 kHz PCM16 silence, so audio and lips stay equally long; always even. */
    fun pad24(pad16Bytes: Int): Int = ((pad16Bytes.toLong() * 3 / 2) and 1L.inv()).toInt()
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/LipGate.kt`：

```kotlin
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
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：`BUILD SUCCESSFUL`，本任务新增的 11 个测试通过，之前的测试也都通过。

- [x] **Step 5: 写播放器**

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixAudioPlayer.kt`：

```kotlin
package com.anyidea.avatar_app.duix

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
```

要点：
- 所有状态都由 `lock` 保护；`hardStop` 可以在任意线程调用，持锁很短，不等渲染线程。
- 写线程用 `WRITE_NON_BLOCKING`，缓冲写满就睡 5 ms，不空转。
- 播放器是在开播之前就往 AudioTrack 里预写的（MODE_STREAM 允许这样做），`play()` 之后才开始出声。

- [x] **Step 6: 编译并全量回归**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest
cd .. && flutter build apk --debug --dart-define-from-file=dev.json
```

Expected：全部 Kotlin 测试通过，APK 构建成功。`DuixAudioPlayer` 依赖 Android API，没有 JVM 单测，真机行为放在 Task 13 验证。

- [x] **Step 7: 提交**

```bash
git add app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/AudioClock.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SegmentPadding.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/LipGate.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixAudioPlayer.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/AudioClockTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SegmentPaddingTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/LipGateTest.kt
git commit -m "feat(duix): add the 24 kHz Duix player with a lip-sync clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
