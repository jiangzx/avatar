package com.anyidea.avatar_app.duix

import android.app.Activity
import android.app.ActivityManager
import android.os.Build
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformViewRegistry
import java.io.Closeable

/** Owns the Duix channels for one Flutter engine. */
class DuixHost(
    private val activity: Activity,
    messenger: BinaryMessenger,
    @Suppress("unused") private val views: PlatformViewRegistry,
) : MethodChannel.MethodCallHandler, Closeable {
    private val methods = MethodChannel(messenger, DuixChannels.METHODS)

    init {
        methods.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "probe" -> result.success(probe(call.argument<Int>("minTotalMemMb") ?: Int.MAX_VALUE))
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
            storageReady = activity.getExternalFilesDir("duix") != null,
        )
        DuixDiag.log("duix_probe", "supported" to (reason == null), "reason" to (reason ?: "none"))
        return mapOf("supported" to (reason == null), "reason" to reason)
    }

    override fun close() {
        methods.setMethodCallHandler(null)
    }

    private fun libraryLoaded(): Boolean = try {
        System.loadLibrary("gjduix")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }
}
