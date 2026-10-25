package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ZipGuardTest {
    @Test
    fun acceptsEntriesUnderTheTopDir() {
        assertEquals("Lily/raw_jpgs/1.sij", ZipGuard.safeRelative("Lily/raw_jpgs/1.sij", "Lily"))
        assertEquals("Lily", ZipGuard.safeRelative("Lily/", "Lily"))
        assertEquals("Lily/a", ZipGuard.safeRelative("Lily\\a", "Lily"))
    }

    @Test
    fun rejectsTraversalAbsoluteAndForeignEntries() {
        assertNull(ZipGuard.safeRelative("Lily/../evil", "Lily"))
        assertNull(ZipGuard.safeRelative("Lily/./a", "Lily"))
        assertNull(ZipGuard.safeRelative("/Lily/a", "Lily"))
        assertNull(ZipGuard.safeRelative("Other/a", "Lily"))
        assertNull(ZipGuard.safeRelative("", "Lily"))
        assertNull(ZipGuard.safeRelative("Lily/a\u0000b", "Lily"))
    }
}
