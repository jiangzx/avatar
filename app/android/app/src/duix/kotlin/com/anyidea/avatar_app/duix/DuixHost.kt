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

/** Owns the Duix channels for one Flutter engine. */
class DuixHost(
    private val activity: Activity,
    messenger: BinaryMessenger,
    @Suppress("unused") private val views: PlatformViewRegistry,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler, Closeable {
    private val main = Handler(Looper.getMainLooper())
    private val methods = MethodChannel(messenger, DuixChannels.METHODS)
    private val events = EventChannel(messenger, DuixChannels.EVENTS)
    private val installs = Executors.newSingleThreadExecutor { Thread(it, "duix-install") }
    private val layout: InstallLayout? = activity.getExternalFilesDir("duix")?.let(::InstallLayout)
    private val installer: ModelInstaller? = layout?.let { ModelInstaller(it) }
    private var sink: EventChannel.EventSink? = null

    init {
        methods.setMethodCallHandler(this)
        events.setStreamHandler(this)
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

    override fun close() {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        installs.shutdownNow()
    }

    private fun libraryLoaded(): Boolean = try {
        System.loadLibrary("gjduix")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }
}
