package com.anyidea.avatar_app.duix

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class InstallLayoutTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun installedNeedsDirMarkerAndMatchingSha() {
        val layout = InstallLayout(tmp.root)
        assertFalse(layout.isInstalled("Lily", "ab"))
        layout.dir("Lily").mkdirs()
        layout.shaFile("Lily").writeText("ab")
        assertFalse(layout.isInstalled("Lily", "ab"))
        layout.marker("Lily").mkdirs()
        assertTrue(layout.isInstalled("Lily", "ab"))
        assertFalse(layout.isInstalled("Lily", "cd"))
    }

    @Test
    fun pathsFollowTheSdkLayout() {
        val layout = InstallLayout(tmp.root)
        assertTrue(layout.dir("Lily").path.endsWith("model/Lily"))
        assertTrue(layout.marker("Lily").path.endsWith("model/tmp/Lily"))
        assertTrue(layout.partFile("lily").path.endsWith("downloads/lily.zip.part"))
    }
}
