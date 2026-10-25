package com.aihero.avatar.bontime.duix

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class ModelInstallerTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class FakeConnection(
        url: URL,
        private val status: Int,
        private val body: InputStream,
        private val landed: URL? = null,
    ) : HttpURLConnection(url) {
        val sent = HashMap<String, String>()
        override fun setRequestProperty(key: String, value: String) { sent[key] = value }
        override fun getResponseCode() = status
        override fun getURL(): URL = landed ?: super.getURL()
        override fun getInputStream() = body
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
    }

    private fun zipOf(vararg entries: Pair<String, ByteArray?>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            for ((name, data) in entries) {
                zip.putNextEntry(ZipEntry(name))
                if (data != null) zip.write(data)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun asset(zip: ByteArray, url: String = "https://example.test/Lily.zip", digest: String = sha(zip)) =
        InstallAsset(id = "lily", dir = "Lily", url = url, sha256 = digest, bytes = zip.size.toLong())

    private val goodZip = zipOf("Lily/" to null, "Lily/config.j" to byteArrayOf(1, 2, 3))

    @Test
    fun downloadsVerifiesAndUnpacks() {
        val layout = InstallLayout(tmp.root)
        val phases = mutableListOf<String>()
        val installer = ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip)) })
        installer.install(asset(goodZip)) { phase, _, _ -> phases += phase }
        assertTrue(layout.isInstalled("Lily", sha(goodZip)))
        assertArrayEquals(byteArrayOf(1, 2, 3), File(layout.dir("Lily"), "config.j").readBytes())
        assertFalse(layout.partFile("lily").exists())
        assertFalse(layout.staging("Lily").exists())
        assertEquals(listOf("downloading", "verifying", "unzipping", "done"), phases.distinct())
    }

    @Test
    fun resumesAPartialDownloadWithRange() {
        val layout = InstallLayout(tmp.root)
        val part = layout.partFile("lily").apply { parentFile!!.mkdirs(); writeBytes(goodZip.copyOfRange(0, 10)) }
        lateinit var conn: FakeConnection
        val installer = ModelInstaller(layout, open = {
            FakeConnection(it, 206, ByteArrayInputStream(goodZip.copyOfRange(10, goodZip.size))).also { c -> conn = c }
        })
        installer.install(asset(goodZip)) { _, _, _ -> }
        assertEquals("bytes=10-", conn.sent["Range"])
        assertTrue(layout.isInstalled("Lily", sha(goodZip)))
        assertFalse(part.exists())
    }

    @Test
    fun restartsWhenTheServerIgnoresRange() {
        val layout = InstallLayout(tmp.root)
        layout.partFile("lily").apply { parentFile!!.mkdirs(); writeBytes(ByteArray(10) { 9 }) }
        val installer = ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip)) })
        installer.install(asset(goodZip)) { _, _, _ -> }
        assertTrue(layout.isInstalled("Lily", sha(goodZip)))
    }

    @Test
    fun installsWhenTheConfiguredShaDoesNotMatchTheZip() {
        val layout = InstallLayout(tmp.root)
        val installer = ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip)) })
        val digest = "0".repeat(64)
        installer.install(asset(goodZip, digest = digest)) { _, _, _ -> }
        assertTrue(layout.isInstalled("Lily", digest))
        assertFalse(layout.partFile("lily").exists())
    }

    @Test
    fun rejectsZipSlipAndForeignTopDirs() {
        for (evil in listOf(zipOf("Lily/../evil" to byteArrayOf(1)), zipOf("Other/a" to byteArrayOf(1)))) {
            val layout = InstallLayout(tmp.newFolder())
            val installer = ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(evil)) })
            expectCode("zip_layout") { installer.install(asset(evil)) { _, _, _ -> } }
            assertFalse(File(layout.root, "evil").exists())
            assertFalse(File(layout.root, "staging/evil").exists())
            assertFalse(layout.dir("Lily").exists())
        }
    }

    @Test
    fun rejectsInsecureUrlsHttpErrorsAndSizeMismatch() {
        val layout = InstallLayout(tmp.root)
        expectCode("insecure_url") {
            ModelInstaller(layout, open = { fail("must not connect"); throw IllegalStateException() })
                .install(asset(goodZip, url = "http://example.test/Lily.zip")) { _, _, _ -> }
        }
        expectCode("http_404") {
            ModelInstaller(layout, open = { FakeConnection(it, 404, ByteArrayInputStream(ByteArray(0))) })
                .install(asset(goodZip)) { _, _, _ -> }
        }
        expectCode("size_mismatch") {
            ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip + byteArrayOf(0))) })
                .install(asset(goodZip)) { _, _, _ -> }
        }
    }

    @Test
    fun rejectsARedirectThatLeavesHttps() {
        val layout = InstallLayout(tmp.root)
        val http = URL("http://example.test/Lily.zip")
        expectCode("insecure_url") {
            ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip), landed = http) })
                .install(asset(goodZip)) { _, _, _ -> }
        }
        assertFalse(layout.dir("Lily").exists())
    }

    @Test
    fun aFailedSwapKeepsTheInstalledTree() {
        val parent = tmp.newFolder()
        val dest = File(parent, "Lily").apply { mkdirs(); File(this, "old").writeText("keep") }
        val unpacked = File(parent, "stage").apply { mkdirs(); File(this, "new").writeText("next") }
        var calls = 0
        val ok = InstallSwap { from, to ->
            calls++
            if (calls == 3) false else from.renameTo(to)
        }.replace(unpacked, dest)
        assertFalse(ok)
        assertEquals("keep", File(dest, "old").readText())
        assertFalse(File(parent, "Lily.incoming").exists())
        assertFalse(File(parent, "Lily.previous").exists())
    }

    @Test
    fun aSwapReplacesTheInstalledTree() {
        val parent = tmp.newFolder()
        val dest = File(parent, "Lily").apply { mkdirs(); File(this, "old").writeText("keep") }
        val unpacked = File(parent, "stage").apply { mkdirs(); File(this, "new").writeText("next") }
        assertTrue(InstallSwap().replace(unpacked, dest))
        assertEquals("next", File(dest, "new").readText())
        assertFalse(File(dest, "old").exists())
        assertFalse(File(parent, "Lily.incoming").exists())
        assertFalse(File(parent, "Lily.previous").exists())
    }

    @Test
    fun refusesWhenSpaceIsShort() {
        val layout = InstallLayout(tmp.root)
        val installer = ModelInstaller(layout, open = { fail("must not connect"); throw IllegalStateException() }, freeBytes = { 0L })
        expectCode("no_space") { installer.install(asset(goodZip)) { _, _, _ -> } }
    }

    @Test
    fun cancelKeepsThePartForResume() {
        val layout = InstallLayout(tmp.root)
        lateinit var installer: ModelInstaller
        val body = object : InputStream() {
            var sent = 0
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (sent > 0) installer.cancel("lily")
                if (sent >= goodZip.size) return -1
                b[off] = goodZip[sent]
                sent++
                return 1
            }
        }
        installer = ModelInstaller(layout, open = { FakeConnection(it, 200, body) })
        expectCode("cancelled") { installer.install(asset(goodZip)) { _, _, _ -> } }
        assertTrue(layout.partFile("lily").length() > 0)
    }

    @Test
    fun parsesAndValidatesChannelArgs() {
        val ok = InstallAsset.parse(mapOf("id" to "lily", "dir" to "Lily", "url" to "https://a.test/L.zip", "sha256" to "a".repeat(64), "bytes" to 10))
        assertEquals(10L, ok.bytes)
        for (bad in listOf(
            mapOf("id" to "../x", "dir" to "Lily", "url" to "https://a", "sha256" to "a".repeat(64), "bytes" to 10),
            mapOf("id" to "lily", "dir" to "Li ly", "url" to "https://a", "sha256" to "a".repeat(64), "bytes" to 10),
            mapOf("id" to "lily", "dir" to "Lily", "url" to "https://a", "sha256" to "A".repeat(64), "bytes" to 10),
            mapOf("id" to "lily", "dir" to "Lily", "url" to "https://a", "sha256" to "a".repeat(64), "bytes" to 0),
        )) expectCode("bad_args") { InstallAsset.parse(bad) }
    }

    @Test
    fun installLocalRecordsTheBundleVersionAndReplacesIt() {
        val layout = InstallLayout(tmp.root)
        val installer = ModelInstaller(layout)
        val zip = File(tmp.newFile("lily.zip").path)
        zip.writeBytes(goodZip)
        installer.installLocal("Lily", zip, "7")
        assertTrue(layout.isBundleCurrent("Lily", "7"))
        assertFalse(layout.isBundleCurrent("Lily", "8"))
        assertArrayEquals(byteArrayOf(1, 2, 3), File(layout.dir("Lily"), "config.j").readBytes())
        installer.installLocal("Lily", zip, "8")
        assertTrue(layout.isBundleCurrent("Lily", "8"))
    }

    private fun expectCode(code: String, block: () -> Unit) {
        try {
            block()
            fail("expected $code")
        } catch (e: InstallException) {
            assertEquals(code, e.code)
        }
    }
}
