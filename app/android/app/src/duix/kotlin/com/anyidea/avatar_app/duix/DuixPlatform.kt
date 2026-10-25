package com.anyidea.avatar_app.duix

import android.app.Activity
import io.flutter.embedding.engine.FlutterEngine
import java.io.Closeable

/** Build with the Duix AAR. */
object DuixPlatform {
    fun attach(activity: Activity, engine: FlutterEngine): Closeable =
        DuixHost(activity, engine.dartExecutor.binaryMessenger, engine.platformViewsController.registry)
}
