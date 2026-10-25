# Task 5: Kotlin 渲染引擎、PlatformView 与完整 DuixHost

**Files:**
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SilenceLoop.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/RenderStats.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfig.kt`
- Create: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/ForwardingSink.kt`
- Create: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatformView.kt`
- Create: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixEngine.kt`
- Modify: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt`（整体替换）
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SilenceLoopTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/RenderStatsTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfigTest.kt`

**Interfaces:**
- Consumes:
  - Task 3：`InstallLayout`、`ModelInstaller`、`InstallAsset`、`InstallException`、`ZipGuard`；
  - Task 4：`DuixAudioPlayer`、`LipGate`、`SegmentPadding`；
  - SDK（AAR）：`DuixNcnn`、`ModelInfoLoader.load(Context, Object, String, String)`、`ModelInfo`（`width`、`height`、`isHasMask`、`unetparam`、`unetbin`、`unetmsk`、`wenetfn`、`modelkind`、`silenceRegion`、`motionRegions`）、`ModelInfo.Region`（`name`、`frames`）、`ModelInfo.Frame`（`rawPath`、`sgPath`、`maskPath`、`rect`）、`ImageFrame`、`RenderSink`、`DUIXRenderer`、`DUIXTextureView`。
- Produces:
  - `class DuixInitException(code)`；
  - `DuixRuntimeConfig.parse(Map<*, *>)`；
  - `SilenceLoop<T>`、`RenderStats`；
  - `DuixEngine`，接口见总览；
  - spec §4.4 的全部通道方法和事件；
  - PlatformView `anyidea/duix_view`。

背景（spec §4.1、§4.3）：
- 渲染线程每 40 ms 执行一次：先查口型是否就绪（`readycnt`），由 `LipGate` 决定何时开播；然后取下一帧（有动作区间就先播动作帧，否则播静默循环，循环方式是先正向再反向）；正在播且口型就绪时调用 `filerst`，否则调用 `fileload`；最后把帧交给 `ForwardingSink`。
- 两套画面缓冲交替使用，避免 GL 线程读到正在写的那一帧。
- `free(0)` 只能在渲染线程退出前、在这个线程上执行；只要旧的渲染线程还活着，就不能开始新的 `prepare`。

- [x] **Step 1: 写失败的纯逻辑测试**

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SilenceLoopTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class SilenceLoopTest {
    @Test
    fun playsForwardThenBackwardLikeTheSdk() {
        val loop = SilenceLoop(listOf("a", "b", "c"))
        assertEquals(listOf("a", "b", "c", "c", "b", "a", "a", "b"), List(8) { loop.next() })
    }

    @Test
    fun singleFrameRepeats() {
        val loop = SilenceLoop(listOf("a"))
        assertEquals(listOf("a", "a", "a"), List(3) { loop.next() })
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAnEmptyRegion() {
        SilenceLoop(emptyList<String>())
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/RenderStatsTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RenderStatsTest {
    @Test
    fun reportsOncePerInterval() {
        val stats = RenderStats(1000)
        assertNull(stats.onFrame(0, 10, lipFrame = false))
        assertNull(stats.onFrame(400, 50, lipFrame = true))
        val snap = stats.onFrame(1000, 20, lipFrame = true)!!
        assertEquals(RenderStats.Snapshot(fps = 3, lipFrames = 2, slowFrames = 1, maxFrameMs = 50), snap)
    }

    @Test
    fun startsAFreshWindowAfterEachReport() {
        val stats = RenderStats(1000)
        stats.onFrame(0, 10, lipFrame = true)
        stats.onFrame(1000, 10, lipFrame = true)
        assertNull(stats.onFrame(1500, 10, lipFrame = false))
        val snap = stats.onFrame(2000, 60, lipFrame = false)!!
        assertEquals(RenderStats.Snapshot(fps = 2, lipFrames = 0, slowFrames = 1, maxFrameMs = 60), snap)
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfigTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class DuixRuntimeConfigTest {
    private val ok = mapOf(
        "modelDir" to "Lily",
        "minSegmentMs" to 1000,
        "lipReadyTimeoutMs" to 1500,
        "statsIntervalMs" to 5000,
        "prepareTimeoutMs" to 60000,
    )

    @Test
    fun parsesValidArgs() {
        assertEquals(DuixRuntimeConfig("Lily", 1000, 1500, 5000, 60000), DuixRuntimeConfig.parse(ok))
    }

    @Test
    fun rejectsOutOfRangeValues() {
        for ((key, value) in listOf("minSegmentMs" to 799, "lipReadyTimeoutMs" to 5001, "statsIntervalMs" to 999, "prepareTimeoutMs" to 4999)) {
            expectBadArgs(ok + (key to value))
        }
        expectBadArgs(ok - "minSegmentMs")
    }

    @Test
    fun rejectsUnsafeOrBaseModelDirs() {
        for (dir in listOf("../Lily", "Li/ly", "", InstallLayout.BASE_DIR)) expectBadArgs(ok + ("modelDir" to dir))
    }

    private fun expectBadArgs(args: Map<String, Any>) {
        try {
            DuixRuntimeConfig.parse(args)
            fail("expected bad_args for $args")
        } catch (e: DuixInitException) {
            assertEquals("bad_args", e.code)
        }
    }
}
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：编译失败，报 `Unresolved reference: SilenceLoop`、`RenderStats`、`DuixRuntimeConfig`、`DuixInitException`。

- [x] **Step 3: 写纯逻辑**

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SilenceLoop.kt`：

```kotlin
package com.anyidea.avatar_app.duix

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
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/RenderStats.kt`：

```kotlin
package com.anyidea.avatar_app.duix

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
```

`RenderStatsTest` 第一个用例：窗口从 0 开始，到 1000 时共 3 帧，`fps = 3 × 1000 / 1000 = 3`。第二个用例：报告后新窗口从 1000 开始，到 2000 时共 2 帧，`fps = 2`。

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfig.kt`：

```kotlin
package com.anyidea.avatar_app.duix

class DuixInitException(val code: String) : Exception(code)

/** prepare() arguments; ranges match app/assets/config/duix.json validation (second boundary check). */
data class DuixRuntimeConfig(
    val modelDir: String,
    val minSegmentMs: Int,
    val lipReadyTimeoutMs: Int,
    val statsIntervalMs: Int,
    val prepareTimeoutMs: Int,
) {
    companion object {
        private val dirToken = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun parse(args: Map<*, *>): DuixRuntimeConfig {
            val dir = args["modelDir"] as? String
            if (dir == null || !dirToken.matches(dir) || dir == InstallLayout.BASE_DIR) throw DuixInitException("bad_args")
            return DuixRuntimeConfig(
                modelDir = dir,
                minSegmentMs = int(args, "minSegmentMs", 800, 3000),
                lipReadyTimeoutMs = int(args, "lipReadyTimeoutMs", 500, 5000),
                statsIntervalMs = int(args, "statsIntervalMs", 1000, 60000),
                prepareTimeoutMs = int(args, "prepareTimeoutMs", 5000, 180000),
            )
        }

        private fun int(args: Map<*, *>, key: String, min: Int, max: Int): Int {
            val value = (args[key] as? Number)?.toInt()
            if (value == null || value < min || value > max) throw DuixInitException("bad_args")
            return value
        }
    }
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：`BUILD SUCCESSFUL`，本任务新增的 8 个测试通过。

- [x] **Step 5: 写画面转发和 PlatformView**

`app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/ForwardingSink.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import ai.guiji.duix.sdk.client.bean.ImageFrame
import ai.guiji.duix.sdk.client.render.RenderSink

/** Lets the engine outlive any one view: frames go to whichever renderer is attached now. */
class ForwardingSink : RenderSink {
    @Volatile
    var target: RenderSink? = null

    override fun onVideoFrame(imageFrame: ImageFrame) {
        target?.onVideoFrame(imageFrame)
    }
}
```

`app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatformView.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import ai.guiji.duix.sdk.client.render.DUIXRenderer
import ai.guiji.duix.sdk.client.render.DUIXTextureView
import android.content.Context
import android.opengl.GLSurfaceView
import android.view.View
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

class DuixViewFactory(private val frames: ForwardingSink) : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
    override fun create(context: Context, viewId: Int, args: Any?): PlatformView = DuixPlatformView(context, frames)
}

/** Full-screen Duix view; DUIXRenderer crops the frame to cover the view. */
class DuixPlatformView(context: Context, private val frames: ForwardingSink) : PlatformView {
    private val view = DUIXTextureView(context)
    private val renderer = DUIXRenderer(context, view)

    init {
        view.setEGLContextClientVersion(2)
        view.setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        view.isOpaque = true // Lily ships no alpha mask
        view.setRenderer(renderer)
        view.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY // must follow setRenderer
        frames.target = renderer
    }

    override fun getView(): View = view

    override fun dispose() {
        if (frames.target === renderer) frames.target = null
    }
}
```

- [x] **Step 6: 写引擎**

`app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixEngine.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import ai.guiji.duix.DuixNcnn
import ai.guiji.duix.sdk.client.bean.ImageFrame
import ai.guiji.duix.sdk.client.loader.ModelInfo
import ai.guiji.duix.sdk.client.loader.ModelInfoLoader
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * One loaded Duix model on its own render thread. Every DuixNcnn call happens on that thread.
 * Public methods are called from the main thread and only post work, except stopNow().
 */
class DuixEngine(
    private val context: Context,
    private val layout: InstallLayout,
    private val frames: ForwardingSink,
    private val emit: (Map<String, Any>) -> Unit,
) {
    data class PrepareResult(val width: Int, val height: Int, val motions: List<String>)

    private val thread = HandlerThread("duix-render").also { it.start() }
    private val handler = Handler(thread.looper)
    private val player = DuixAudioPlayer(object : DuixAudioPlayer.Listener {
        override fun onEnded(seq: Int, playedMs: Int) {
            emit(mapOf("type" to "playEnd", "seq" to seq, "playedMs" to playedMs))
            handler.post { if (activeSeq == seq) clearSegment() }
        }

        override fun onError(seq: Int, code: String) {
            emit(mapOf("type" to "playError", "seq" to seq, "code" to code))
            handler.post { if (activeSeq == seq) clearSegment() }
        }
    })

    // Render-thread state.
    private var ncnn: DuixNcnn? = null
    private var info: ModelInfo? = null
    private var loop: SilenceLoop<ModelInfo.Frame>? = null
    private val motionFrames = ArrayDeque<ModelInfo.Frame>()
    private var motions: Map<String, List<ModelInfo.Frame>> = emptyMap()
    private var buffers: List<Pair<ByteBuffer, ByteBuffer>> = emptyList()
    private var bufferIndex = 0
    private var config: DuixRuntimeConfig? = null
    private var lipGate = LipGate(0)
    private var stats = RenderStats(Long.MAX_VALUE)
    private var session = -1L
    private var activeSeq = 0
    private var pushed16 = 0L
    private var ended = false

    @Volatile
    private var running = false

    @Volatile
    private var rendering = true

    /** Loads the model on the render thread and starts the 25 fps loop. Blocks the calling (control) thread. */
    fun prepare(cfg: DuixRuntimeConfig): PrepareResult {
        val latch = CountDownLatch(1)
        var result: PrepareResult? = null
        var error: Throwable? = null
        handler.post {
            try {
                result = load(cfg)
            } catch (t: Throwable) {
                error = t
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(cfg.prepareTimeoutMs.toLong(), TimeUnit.MILLISECONDS)) throw DuixInitException("prepare_timeout")
        error?.let { e ->
            DuixDiag.log("duix_prepare_error", "type" to e.javaClass.simpleName)
            throw when (e) {
                is DuixInitException -> e
                is UnsatisfiedLinkError -> DuixInitException(DeviceGate.LIBRARY_MISSING)
                else -> DuixInitException("model_config")
            }
        }
        val prepared = result ?: throw DuixInitException("model_config")
        running = true
        handler.post { tick() }
        return prepared
    }

    fun startResponse(seq: Int) {
        handler.post {
            val nc = ncnn ?: return@post
            if (session >= 0 && !ended) nc.finsession(session)
            session = nc.newsession()
            activeSeq = seq
            pushed16 = 0L
            ended = false
            lipGate.reset()
            player.begin(seq)
            if (session < 0) {
                emit(mapOf("type" to "playError", "seq" to seq, "code" to "session"))
                clearSegment()
            }
        }
    }

    fun push(seq: Int, pcm16: ByteArray, pcm24: ByteArray) {
        handler.post {
            val nc = ncnn ?: return@post
            if (seq != activeSeq || session < 0 || ended) return@post
            if (pcm16.isNotEmpty()) {
                nc.pushpcm(session, pcm16, pcm16.size, 0)
                pushed16 += pcm16.size
            }
            if (pcm24.isNotEmpty()) {
                player.enqueue(seq, pcm24, real = true)
                lipGate.onAudio(SystemClock.uptimeMillis())
            }
        }
    }

    fun endResponse(seq: Int) {
        handler.post {
            val nc = ncnn ?: return@post
            val cfg = config ?: return@post
            if (seq != activeSeq || session < 0 || ended) return@post
            val pad16 = SegmentPadding.pad16(pushed16, cfg.minSegmentMs)
            if (pad16 > 0) {
                nc.pushpcm(session, ByteArray(pad16), pad16, 0)
                player.enqueue(seq, ByteArray(SegmentPadding.pad24(pad16)), real = false)
                lipGate.onAudio(SystemClock.uptimeMillis())
            }
            nc.finsession(session)
            ended = true
            player.markEnd(seq)
        }
    }

    /** Barge-in: silences now on the caller thread; the render thread may be busy in feature inference. */
    fun stopNow(): DuixAudioPlayer.StopResult {
        val stopped = player.hardStop()
        handler.post { clearSegment() }
        return stopped
    }

    fun motion(name: String) {
        handler.post {
            val region = motions[name] ?: return@post
            motionFrames.clear()
            motionFrames.addAll(region)
        }
    }

    /** False while the app is in the background: audio and lips keep running, frames are skipped. */
    fun setRendering(on: Boolean) {
        rendering = on
    }

    /** Stops the loop, frees the native engine on its own thread and waits up to 3 s. False if still alive. */
    fun release(): Boolean {
        running = false
        player.hardStop()
        handler.post {
            val nc = ncnn
            ncnn = null
            if (nc != null) {
                if (session >= 0 && !ended) nc.finsession(session)
                nc.free(0)
            }
            session = -1L
        }
        thread.quitSafely()
        thread.join(RELEASE_JOIN_MS)
        player.release()
        return !thread.isAlive
    }

    /** Waits for a render thread that did not stop inside release(). */
    fun awaitStopped(timeoutMs: Long): Boolean {
        thread.join(timeoutMs)
        return !thread.isAlive
    }

    private fun load(cfg: DuixRuntimeConfig): PrepareResult {
        val base = layout.dir(InstallLayout.BASE_DIR)
        val model = layout.dir(cfg.modelDir)
        val installed = base.isDirectory && model.isDirectory &&
            layout.marker(InstallLayout.BASE_DIR).isDirectory && layout.marker(cfg.modelDir).isDirectory
        if (!installed) throw DuixInitException("not_installed")
        val nc = DuixNcnn()
        val loaded: ModelInfo = ModelInfoLoader.load(context, nc, base.absolutePath, model.absolutePath)
            ?: throw DuixInitException("model_config")
        val silence = loaded.silenceRegion?.frames.orEmpty()
        if (silence.isEmpty()) throw DuixInitException("no_frames")
        requireOk(nc.alloc(0, 20, loaded.width, loaded.height), "init_alloc")
        ncnn = nc // allocated: release() frees it from here on
        requireOk(nc.initPcmex(0, 10, 20, 50, 0), "init_pcm")
        val munet = if (loaded.modelkind > 0) {
            nc.initMunetex(loaded.unetparam, loaded.unetbin, loaded.unetmsk, loaded.modelkind)
        } else {
            nc.initMunet(loaded.unetparam, loaded.unetbin, loaded.unetmsk)
        }
        requireOk(munet, "init_munet")
        requireOk(nc.initWenet(loaded.wenetfn), "init_wenet")
        val size = loaded.width * loaded.height * 3
        buffers = List(2) {
            val mask = ByteBuffer.allocate(size)
            if (!loaded.isHasMask) mask.array().fill(0xFF.toByte()) // opaque model: full alpha
            Pair(ByteBuffer.allocate(size), mask)
        }
        info = loaded
        loop = SilenceLoop(silence)
        motions = loaded.motionRegions.orEmpty()
            .filter { !it.name.isNullOrEmpty() && it.frames.orEmpty().isNotEmpty() }
            .associate { it.name to it.frames.orEmpty() }
        config = cfg
        lipGate = LipGate(cfg.lipReadyTimeoutMs.toLong())
        stats = RenderStats(cfg.statsIntervalMs.toLong())
        return PrepareResult(loaded.width, loaded.height, motions.keys.sorted())
    }

    private fun tick() {
        if (!running) return
        val start = SystemClock.uptimeMillis()
        val lip = try {
            step(start)
        } catch (t: Throwable) {
            running = false
            DuixDiag.log("duix_fault", "type" to t.javaClass.simpleName)
            emit(mapOf("type" to "fault", "code" to "render"))
            return
        }
        val used = SystemClock.uptimeMillis() - start
        stats.onFrame(start, used, lip)?.let { s ->
            emit(mapOf("type" to "stats", "fps" to s.fps, "lipFrames" to s.lipFrames, "slowFrames" to s.slowFrames, "maxFrameMs" to s.maxFrameMs))
        }
        handler.postDelayed({ tick() }, (FRAME_MS - used).coerceAtLeast(0L))
    }

    private fun step(now: Long): Boolean {
        val nc = ncnn ?: return false
        val model = info ?: return false
        val ready = if (activeSeq != 0 && session >= 0) nc.readycnt(session) else 0
        if (activeSeq != 0) startPlaybackIfReady(now, ready)
        if (!rendering) return false
        val frame = motionFrames.removeFirstOrNull() ?: loop!!.next()
        val (raw, mask) = buffers[bufferIndex]
        bufferIndex = 1 - bufferIndex
        val size = model.width * model.height * 3
        val pic = frame.sgPath?.takeIf { it.isNotEmpty() } ?: frame.rawPath
        val msk = frame.maskPath ?: ""
        var lip = false
        if (ready > 0 && player.isPlaying(activeSeq)) {
            lip = nc.filerst(session, pic, msk, frame.rect, "", player.lipIndex(), raw.array(), mask.array(), size) >= 0
        }
        if (!lip) nc.fileload(pic, msk, model.width, model.height, raw.array(), mask.array(), size)
        frames.onVideoFrame(ImageFrame(raw, mask, model.width, model.height))
        return lip
    }

    private fun startPlaybackIfReady(now: Long, ready: Int) {
        val decision = lipGate.decide(now, ready)
        if (decision == LipGate.Decision.WAIT) return
        val seq = activeSeq
        if (player.play(seq)) emit(mapOf("type" to "playStart", "seq" to seq, "lips" to (decision == LipGate.Decision.START)))
    }

    /** Render thread only. */
    private fun clearSegment() {
        val nc = ncnn
        if (nc != null && session >= 0 && !ended) nc.finsession(session)
        session = -1L
        activeSeq = 0
        pushed16 = 0L
        ended = false
        lipGate.reset()
    }

    private fun requireOk(code: Int, failure: String) {
        if (code < 0) throw DuixInitException(failure) // JNI convention: negative means failure
    }

    private companion object {
        const val FRAME_MS = 40L
        const val RELEASE_JOIN_MS = 3_000L
    }
}
```

- [x] **Step 7: 写完整版 `DuixHost`**

把 `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt` 整体替换为：

```kotlin
package com.anyidea.avatar_app.duix

import android.app.Activity
import android.app.ActivityManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformViewRegistry
import java.io.Closeable
import java.util.concurrent.Executors

/**
 * Owns the Duix channels for one Flutter engine. prepare/release run one at a time on duix-control,
 * so at most one DuixEngine exists and a new one never starts while an old render thread is alive.
 */
class DuixHost(
    private val activity: Activity,
    messenger: BinaryMessenger,
    views: PlatformViewRegistry,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler, Closeable {
    private val main = Handler(Looper.getMainLooper())
    private val methods = MethodChannel(messenger, DuixChannels.METHODS)
    private val events = EventChannel(messenger, DuixChannels.EVENTS)
    private val installs = Executors.newSingleThreadExecutor { Thread(it, "duix-install") }
    private val control = Executors.newSingleThreadExecutor { Thread(it, "duix-control") }
    private val layout: InstallLayout? = activity.getExternalFilesDir("duix")?.let(::InstallLayout)
    private val installer: ModelInstaller? = layout?.let { ModelInstaller(it) }
    private val frames = ForwardingSink()
    private var sink: EventChannel.EventSink? = null

    @Volatile
    private var engine: DuixEngine? = null

    /** An engine whose render thread outlived release(); control thread only. */
    private var retired: DuixEngine? = null

    init {
        methods.setMethodCallHandler(this)
        events.setStreamHandler(this)
        views.registerViewFactory(DuixChannels.VIEW, DuixViewFactory(frames))
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private fun emit(event: Map<String, Any>) {
        main.post { sink?.success(event) }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "probe" -> result.success(probe(call.argument<Int>("minTotalMemMb") ?: Int.MAX_VALUE))
            "installStatus" -> installStatus(call, result)
            "install" -> install(call, result)
            "cancelInstall" -> {
                call.argument<String>("id")?.let { installer?.cancel(it) }
                result.success(null)
            }
            "prepare" -> prepare(call, result)
            "startResponse" -> {
                call.argument<Int>("seq")?.let { engine?.startResponse(it) }
                result.success(null)
            }
            "push" -> {
                val seq = call.argument<Int>("seq")
                val pcm16 = call.argument<ByteArray>("pcm16")
                val pcm24 = call.argument<ByteArray>("pcm24")
                if (seq != null && pcm16 != null && pcm24 != null) engine?.push(seq, pcm16, pcm24)
                result.success(null)
            }
            "endResponse" -> {
                call.argument<Int>("seq")?.let { engine?.endResponse(it) }
                result.success(null)
            }
            "stopResponse" -> {
                val stopped = engine?.stopNow()
                result.success(mapOf("seq" to (stopped?.seq ?: 0), "playedMs" to (stopped?.playedMs ?: 0)))
            }
            "motion" -> {
                call.argument<String>("name")?.let { engine?.motion(it) }
                result.success(null)
            }
            "setRendering" -> {
                engine?.setRendering(call.argument<Boolean>("on") ?: true)
                result.success(null)
            }
            "release" -> control.execute {
                releaseEngine()
                main.post { result.success(null) }
            }
            else -> result.notImplemented()
        }
    }

    private fun probe(minTotalMemMb: Int): Map<String, Any?> {
        val memory = ActivityManager.MemoryInfo()
        activity.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
        val reason = DeviceGate.reason(
            abis = Build.SUPPORTED_ABIS.toList(),
            totalMemBytes = memory.totalMem,
            minTotalMemMb = minTotalMemMb,
            libraryLoaded = libraryLoaded(),
            storageReady = layout != null,
        )
        DuixDiag.log("duix_probe", "supported" to (reason == null), "reason" to (reason ?: "none"))
        return mapOf("supported" to (reason == null), "reason" to reason)
    }

    /** A few stats and one tiny read per asset: cheap enough for the main thread. */
    private fun installStatus(call: MethodCall, result: MethodChannel.Result) {
        val inst = installer ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val assets = call.argument<List<Map<String, Any?>>>("assets").orEmpty()
        val status = HashMap<String, Boolean>()
        for (a in assets) {
            val id = a["id"] as? String ?: continue
            val dir = a["dir"] as? String
            val sha = a["sha256"] as? String
            status[id] = dir != null && sha != null && ZipGuard.safeRelative(dir, dir) == dir && inst.isInstalled(dir, sha)
        }
        result.success(status)
    }

    private fun install(call: MethodCall, result: MethodChannel.Result) {
        val inst = installer ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val asset = try {
            InstallAsset.parse(call.arguments as? Map<*, *> ?: emptyMap<String, Any>())
        } catch (e: InstallException) {
            return result.error(e.code, null, null)
        }
        installs.execute {
            val outcome = try {
                inst.install(asset) { phase, received, total ->
                    emit(mapOf("type" to "install", "id" to asset.id, "phase" to phase, "received" to received, "total" to total))
                }
                null
            } catch (e: InstallException) {
                e.code
            } catch (e: Exception) {
                "storage"
            }
            DuixDiag.log("duix_install", "id" to asset.id, "result" to (outcome ?: "ok"))
            main.post { if (outcome == null) result.success(null) else result.error(outcome, null, null) }
        }
    }

    private fun prepare(call: MethodCall, result: MethodChannel.Result) {
        val lay = layout ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val cfg = try {
            DuixRuntimeConfig.parse(call.arguments as? Map<*, *> ?: emptyMap<String, Any>())
        } catch (e: DuixInitException) {
            return result.error(e.code, null, null)
        }
        control.execute {
            val outcome: Any = try {
                releaseEngine()
                retired?.let { old ->
                    if (!old.awaitStopped(cfg.prepareTimeoutMs.toLong())) throw DuixInitException("busy")
                }
                retired = null
                val next = try {
                    DuixEngine(activity.applicationContext, lay, frames, ::emit)
                } catch (e: RuntimeException) {
                    throw DuixInitException("audio_init")
                }
                try {
                    val prepared = next.prepare(cfg)
                    engine = next
                    mapOf("width" to prepared.width, "height" to prepared.height, "motions" to prepared.motions)
                } catch (e: DuixInitException) {
                    retire(next)
                    throw e
                }
            } catch (e: DuixInitException) {
                e
            }
            DuixDiag.log("duix_prepare", "result" to (if (outcome is DuixInitException) outcome.code else "ok"))
            main.post {
                if (outcome is DuixInitException) result.error(outcome.code, null, null) else result.success(outcome)
            }
        }
    }

    /** Control thread only. */
    private fun releaseEngine() {
        val current = engine ?: return
        engine = null
        retire(current)
    }

    /** Control thread only. */
    private fun retire(old: DuixEngine) {
        if (!old.release()) {
            DuixDiag.log("duix_release_timeout")
            retired = old
        }
    }

    override fun close() {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        frames.target = null
        control.execute { releaseEngine() }
        control.shutdown()
        installs.shutdownNow()
    }

    private fun libraryLoaded(): Boolean = try {
        System.loadLibrary("gjduix")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }
}
```

- [x] **Step 8: 编译并全量回归**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest
cd .. && flutter build apk --debug --dart-define-from-file=dev.json
```

Expected：全部 Kotlin 测试通过，APK 构建成功（这次编的是 `src/duix`，会用到 SDK 的类）。

如果编译报 `ModelInfo` 的属性名不对（例如 `unetparam`），用 `javap -p -cp <AAR 解出的 libs/resource_loader.jar> ai.guiji.duix.sdk.client.loader.ModelInfo` 核对 getter 名称后修正。Kotlin 会把 `getUnetparam()` 映射成 `unetparam`，把 `isHasMask()` 映射成 `isHasMask`。
如果报 `DUIXTextureView` 的方法签名不对，就照 SDK 源码 `render/DUIXTextureView.java` 修正。

真机验证要等 Dart 侧接好，放在 Task 13。

- [x] **Step 9: 提交**

```bash
git add app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/SilenceLoop.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/RenderStats.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfig.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/ForwardingSink.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixPlatformView.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixEngine.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/SilenceLoopTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/RenderStatsTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/DuixRuntimeConfigTest.kt
git commit -m "feat(duix): render Duix frames with an audio-clocked lip loop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
