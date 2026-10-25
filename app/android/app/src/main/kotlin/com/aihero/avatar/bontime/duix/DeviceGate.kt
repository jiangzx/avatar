package com.aihero.avatar.bontime.duix

/** Decides whether this phone and build can run the Duix renderer. */
object DeviceGate {
    const val ABI_UNSUPPORTED = "abi_unsupported"
    const val LOW_MEMORY = "low_memory"
    const val LIBRARY_MISSING = "library_missing"
    const val STORAGE_UNAVAILABLE = "storage_unavailable"

    /** Null means supported; otherwise the first failing reason. */
    fun reason(
        abis: List<String>,
        totalMemBytes: Long,
        minTotalMemMb: Int,
        libraryLoaded: Boolean,
        storageReady: Boolean,
    ): String? = when {
        "arm64-v8a" !in abis -> ABI_UNSUPPORTED
        totalMemBytes < minTotalMemMb.toLong() * 1024L * 1024L -> LOW_MEMORY
        !libraryLoaded -> LIBRARY_MISSING
        !storageReady -> STORAGE_UNAVAILABLE
        else -> null
    }
}
