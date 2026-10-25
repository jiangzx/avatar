package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Test

class DiagFormatTest {
    @Test
    fun formatsLikeTheDartDiagLine() {
        assertEquals(
            "anyidea.diag event=duix_probe supported=true reason=none",
            DiagFormat.line("duix_probe", listOf("supported" to true, "reason" to "none")),
        )
    }

    @Test
    fun replacesUnsafeValues() {
        assertEquals(
            "anyidea.diag event=x code=invalid",
            DiagFormat.line("x", listOf("code" to "has space and 中文")),
        )
    }
}
