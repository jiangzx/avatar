package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class DuixRuntimeConfigTest {
    private val ok = mapOf(
        "modelDir" to "Lily",
        "minSegmentMs" to 1000,
        "lipReadyTimeoutMs" to 1500,
        "statsIntervalMs" to 5000,
        "prepareTimeoutMs" to 60000,
    )

    @Test
    fun parsesValidArgs() {
        assertEquals(DuixRuntimeConfig("Lily", 1000, 1500, 5000, 60000), DuixRuntimeConfig.parse(ok))
    }

    @Test
    fun rejectsOutOfRangeValues() {
        for ((key, value) in listOf("minSegmentMs" to 799, "lipReadyTimeoutMs" to 5001, "statsIntervalMs" to 999, "prepareTimeoutMs" to 4999)) {
            expectBadArgs(ok + (key to value))
        }
        expectBadArgs(ok - "minSegmentMs")
    }

    @Test
    fun rejectsUnsafeOrBaseModelDirs() {
        for (dir in listOf("../Lily", "Li/ly", "", InstallLayout.BASE_DIR)) expectBadArgs(ok + ("modelDir" to dir))
    }

    private fun expectBadArgs(args: Map<String, Any>) {
        try {
            DuixRuntimeConfig.parse(args)
            fail("expected bad_args for $args")
        } catch (e: DuixInitException) {
            assertEquals("bad_args", e.code)
        }
    }
}
