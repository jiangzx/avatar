package com.aihero.avatar.bontime.duix

import android.app.Activity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.Closeable

/** Build without the Duix AAR: probe says the library is missing and every other call fails. */
object DuixPlatform {
    @Suppress("UNUSED_PARAMETER")
    fun attach(activity: Activity, engine: FlutterEngine): Closeable {
        val channel = MethodChannel(engine.dartExecutor.binaryMessenger, DuixChannels.METHODS)
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "probe" -> result.success(mapOf("supported" to false, "reason" to DeviceGate.LIBRARY_MISSING))
                "installStatus" -> result.success(emptyMap<String, Boolean>())
                else -> result.error(DeviceGate.LIBRARY_MISSING, null, null)
            }
        }
        return Closeable { channel.setMethodCallHandler(null) }
    }
}
