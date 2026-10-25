package com.aihero.avatar.bontime.duix

import android.util.Log

/** Same shape as the Dart formatDiag line; values that are not short tokens print as `invalid`. */
object DiagFormat {
    private val safe = Regex("^[A-Za-z0-9_.:-]{1,64}$")

    fun line(event: String, fields: List<Pair<String, Any>>): String = buildString {
        append("anyidea.diag event=").append(event)
        for ((key, value) in fields) {
            val text = value.toString()
            append(' ').append(key).append('=').append(if (safe.matches(text)) text else "invalid")
        }
    }
}

/** Content-free logcat diagnostics: `adb logcat -s anyidea.diag:I`. */
object DuixDiag {
    fun log(event: String, vararg fields: Pair<String, Any>) {
        Log.i("anyidea.diag", DiagFormat.line(event, fields.toList()))
    }
}
