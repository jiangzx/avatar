package com.aihero.avatar.bontime.duix

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
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
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
            "ensureBundled" -> ensureBundled(result)
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

    private fun ensureBundled(result: MethodChannel.Result) {
        val inst = installer ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val lay = layout ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val version = bundleVersion()
        installs.execute {
            val outcome = try {
                for ((id, dir) in listOf("gj_dh_res" to "gj_dh_res", "lily" to "Lily", "kai" to "Kai")) {
                    if (inst.isBundleCurrent(dir, version)) continue
                    val tmp = File(lay.root, "downloads/$id.zip")
                    tmp.parentFile?.mkdirs()
                    activity.assets.open("duix/$id.zip").use { input ->
                        FileOutputStream(tmp).use { out -> input.copyTo(out) }
                    }
                    inst.installLocal(dir, tmp, version)
                    tmp.delete()
                }
                null
            } catch (e: FileNotFoundException) {
                "asset_missing"
            } catch (e: InstallException) {
                e.code
            } catch (e: Exception) {
                "storage"
            }
            DuixDiag.log("duix_bundle", "result" to (outcome ?: "ok"))
            main.post { if (outcome == null) result.success(null) else result.error(outcome, null, null) }
        }
    }

    private fun bundleVersion(): String {
        val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        return code.toString()
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
