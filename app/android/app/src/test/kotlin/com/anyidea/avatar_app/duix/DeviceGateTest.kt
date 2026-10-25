package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeviceGateTest {
    private val gb8 = 7_600L * 1024 * 1024

    @Test
    fun supportedPhonePasses() {
        assertNull(DeviceGate.reason(listOf("arm64-v8a", "armeabi-v7a"), gb8, 7000, libraryLoaded = true, storageReady = true))
    }

    @Test
    fun reasonsAreReportedInPriorityOrder() {
        assertEquals(DeviceGate.ABI_UNSUPPORTED, DeviceGate.reason(listOf("x86_64"), 0, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.LOW_MEMORY, DeviceGate.reason(listOf("arm64-v8a"), 6_000L * 1024 * 1024, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.LIBRARY_MISSING, DeviceGate.reason(listOf("arm64-v8a"), gb8, 7000, libraryLoaded = false, storageReady = false))
        assertEquals(DeviceGate.STORAGE_UNAVAILABLE, DeviceGate.reason(listOf("arm64-v8a"), gb8, 7000, libraryLoaded = true, storageReady = false))
    }

    @Test
    fun memoryThresholdIsInclusive() {
        assertNull(DeviceGate.reason(listOf("arm64-v8a"), 7000L * 1024 * 1024, 7000, libraryLoaded = true, storageReady = true))
    }
}
