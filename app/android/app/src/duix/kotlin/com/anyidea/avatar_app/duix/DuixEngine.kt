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
