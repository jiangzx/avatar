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
