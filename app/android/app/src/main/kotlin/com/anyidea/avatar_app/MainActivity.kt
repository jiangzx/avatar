package com.anyidea.avatar_app

import com.anyidea.avatar_app.duix.DuixPlatform
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import java.io.Closeable

class MainActivity : FlutterActivity() {
    private var duix: Closeable? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        duix = DuixPlatform.attach(this, flutterEngine)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        duix?.close()
        duix = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
