# Task 3: Kotlin 模型下载、校验与解压

**Files:**
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/InstallLayout.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ZipGuard.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ResumePlan.kt`
- Create: `app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ModelInstaller.kt`
- Modify: `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/InstallLayoutTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ZipGuardTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ResumePlanTest.kt`
- Create: `app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ModelInstallerTest.kt`

**Interfaces:**
- Consumes: `DuixChannels`、`DeviceGate`、`DuixDiag`（Task 2）
- Produces:
  - `class InstallLayout(root: File)`：`dir(name)`、`marker(name)`、`shaFile(name)`、`partFile(id)`、`staging(name)`、`isInstalled(name, sha256)`，常量 `SHA_FILE = ".anyidea-sha256"`、`BASE_DIR = "gj_dh_res"`；
  - `data class InstallAsset(id, dir, url, sha256, bytes)`，带 `InstallAsset.parse(Map<*, *>)`；
  - `class InstallException(val code: String)`；
  - `class ModelInstaller(layout, open, freeBytes)`：`install(asset, progress)`、`cancel(id)`、`isInstalled(dir, sha256)`；
  - 通道方法 `installStatus`、`install`、`cancelInstall`；
  - 事件 `{type: "install", id, phase, received, total}`。

规则（spec §4.4、§8）：
- 只接受 https；
- 开始前可用空间至少要是包大小的 3 倍；
- 已下载的部分用 `Range` 续传；服务器不支持续传、返回 200 时，从头重下；
- 下载完先比对大小，再比对 sha256；
- 解压到 `staging/<dir>`：每个条目必须在顶层目录 `<dir>/` 下，不能含 `..`、`.`、绝对路径或 `\0`；规范化后的路径必须在 staging 目录内；条目数最多 10,000；解压总量最多 1.5 GB；
- 解压成功后改名为 `model/<dir>`，再写 `model/<dir>/.anyidea-sha256`，最后建标记目录 `model/tmp/<dir>`；
- 取消时保留已下载的部分，下次接着下。

- [x] **Step 1: 写失败的纯逻辑测试**

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ZipGuardTest.kt`：

```kotlin
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
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ResumePlanTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumePlanTest {
    @Test
    fun asksForTheRestOfAPartialFile() {
        assertEquals("bytes=100-", ResumePlan.rangeHeader(100, 1000))
        assertNull(ResumePlan.rangeHeader(0, 1000))
        assertNull(ResumePlan.rangeHeader(1000, 1000))
    }

    @Test
    fun appendsOnlyOnPartialContent() {
        assertTrue(ResumePlan.canAppend(requestedRange = true, status = 206))
        assertFalse(ResumePlan.canAppend(requestedRange = true, status = 200))
        assertFalse(ResumePlan.canAppend(requestedRange = false, status = 206))
    }
}
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/InstallLayoutTest.kt`：

```kotlin
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
```

`app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ModelInstallerTest.kt`：

```kotlin
package com.anyidea.avatar_app.duix

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

    private class FakeConnection(url: URL, private val status: Int, private val body: InputStream) : HttpURLConnection(url) {
        val sent = HashMap<String, String>()
        override fun setRequestProperty(key: String, value: String) { sent[key] = value }
        override fun getResponseCode() = status
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
    fun rejectsAShaMismatchAndDropsThePart() {
        val layout = InstallLayout(tmp.root)
        val installer = ModelInstaller(layout, open = { FakeConnection(it, 200, ByteArrayInputStream(goodZip)) })
        expectCode("sha_mismatch") { installer.install(asset(goodZip, digest = "0".repeat(64))) { _, _, _ -> } }
        assertFalse(layout.partFile("lily").exists())
        assertFalse(layout.dir("Lily").exists())
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

    private fun expectCode(code: String, block: () -> Unit) {
        try {
            block()
            fail("expected $code")
        } catch (e: InstallException) {
            assertEquals(code, e.code)
        }
    }
}
```

`FakeConnection` 覆盖了 `setRequestProperty`，直接记下安装器设置的请求头，不依赖 `URLConnection` 基类的行为。

- [x] **Step 2: 跑测试确认失败**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：编译失败，报 `Unresolved reference: ZipGuard`、`ResumePlan`、`InstallLayout`、`ModelInstaller`、`InstallAsset`、`InstallException`。

- [x] **Step 3: 写实现**

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/InstallLayout.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import java.io.File

/** Files under getExternalFilesDir("duix"). The SDK loader requires model/<dir> plus the marker model/tmp/<dir>. */
class InstallLayout(val root: File) {
    val modelRoot: File get() = File(root, "model")

    fun dir(name: String) = File(modelRoot, name)
    fun marker(name: String) = File(modelRoot, "tmp/$name")
    fun shaFile(name: String) = File(dir(name), SHA_FILE)
    fun partFile(id: String) = File(root, "downloads/$id.zip.part")
    fun staging(name: String) = File(root, "staging/$name")

    fun isInstalled(name: String, sha256: String): Boolean {
        val sha = shaFile(name)
        return dir(name).isDirectory && marker(name).isDirectory && sha.isFile && sha.readText().trim() == sha256
    }

    companion object {
        const val SHA_FILE = ".anyidea-sha256"
        const val BASE_DIR = "gj_dh_res"
    }
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ZipGuard.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** First line of zip-slip defence; ModelInstaller also checks the canonical path. */
object ZipGuard {
    /** The normalized relative path, or null when the entry must be rejected. */
    fun safeRelative(entryName: String, topDir: String): String? {
        val name = entryName.replace('\\', '/')
        if (name.isEmpty() || name.startsWith("/") || name.contains('\u0000')) return null
        val parts = name.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty() || parts.any { it == ".." || it == "." }) return null
        if (parts.first() != topDir) return null
        return parts.joinToString("/")
    }
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ResumePlan.kt`：

```kotlin
package com.anyidea.avatar_app.duix

/** HTTP range decisions for resuming a partial download. */
object ResumePlan {
    fun rangeHeader(partBytes: Long, expectedBytes: Long): String? =
        if (partBytes in 1 until expectedBytes) "bytes=$partBytes-" else null

    fun canAppend(requestedRange: Boolean, status: Int): Boolean = requestedRange && status == 206
}
```

`app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ModelInstaller.kt`：

```kotlin
package com.anyidea.avatar_app.duix

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipInputStream

class InstallException(val code: String) : Exception(code)

data class InstallAsset(val id: String, val dir: String, val url: String, val sha256: String, val bytes: Long) {
    companion object {
        private val token = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val hex64 = Regex("^[0-9a-f]{64}$")
        private const val MAX_BYTES = 2L * 1024 * 1024 * 1024

        /** Validates channel arguments; the Dart side validated them already, this is the second boundary. */
        fun parse(args: Map<*, *>): InstallAsset {
            val id = args["id"] as? String
            val dir = args["dir"] as? String
            val url = args["url"] as? String
            val sha = args["sha256"] as? String
            val bytes = (args["bytes"] as? Number)?.toLong()
            if (id == null || !token.matches(id) || dir == null || !token.matches(dir) || url == null ||
                sha == null || !hex64.matches(sha) || bytes == null || bytes <= 0 || bytes > MAX_BYTES
            ) throw InstallException("bad_args")
            return InstallAsset(id, dir, url, sha, bytes)
        }
    }
}

/** Downloads, verifies and unpacks one Duix asset into the SDK layout. Not thread-safe per asset id. */
class ModelInstaller(
    private val layout: InstallLayout,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    private val freeBytes: () -> Long = { layout.root.usableSpace },
) {
    private val cancelled = ConcurrentHashMap<String, Boolean>()

    fun cancel(id: String) {
        cancelled[id] = true
    }

    fun isInstalled(dir: String, sha256: String) = layout.isInstalled(dir, sha256)

    fun install(asset: InstallAsset, progress: (phase: String, received: Long, total: Long) -> Unit) {
        cancelled[asset.id] = false
        if (!asset.url.startsWith("https://")) throw InstallException("insecure_url")
        if (!layout.root.isDirectory && !layout.root.mkdirs()) throw InstallException("storage")
        if (freeBytes() < asset.bytes * 3) throw InstallException("no_space")
        val part = layout.partFile(asset.id)
        part.parentFile?.mkdirs()
        download(asset, part, progress)
        progress("verifying", asset.bytes, asset.bytes)
        if (part.length() != asset.bytes) {
            part.delete()
            throw InstallException("size_mismatch")
        }
        if (sha256(part) != asset.sha256) {
            part.delete()
            throw InstallException("sha_mismatch")
        }
        progress("unzipping", asset.bytes, asset.bytes)
        unpack(asset, part)
        part.delete()
        progress("done", asset.bytes, asset.bytes)
    }

    private fun download(asset: InstallAsset, part: File, progress: (String, Long, Long) -> Unit) {
        var existing = if (part.exists()) part.length() else 0L
        if (existing == asset.bytes) return // finished earlier; verification decides
        if (existing > asset.bytes) {
            part.delete()
            existing = 0L
        }
        val range = ResumePlan.rangeHeader(existing, asset.bytes)
        val conn = open(URL(asset.url))
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.instanceFollowRedirects = true
            if (range != null) conn.setRequestProperty("Range", range)
            val status = conn.responseCode
            if (status == 416) {
                part.delete()
                throw InstallException("http_416")
            }
            val append = ResumePlan.canAppend(range != null, status)
            if (status != 200 && !append) throw InstallException("http_$status")
            var received = if (append) existing else 0L
            var lastReport = 0L
            FileOutputStream(part, append).use { out ->
                conn.inputStream.use { input ->
                    val buffer = ByteArray(BUFFER_BYTES)
                    while (true) {
                        if (cancelled[asset.id] == true) throw InstallException("cancelled")
                        val n = input.read(buffer)
                        if (n < 0) break
                        received += n
                        if (received > asset.bytes) throw InstallException("size_mismatch")
                        out.write(buffer, 0, n)
                        val now = System.nanoTime() / 1_000_000
                        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
                            lastReport = now
                            progress("downloading", received, asset.bytes)
                        }
                    }
                }
            }
            progress("downloading", received, asset.bytes)
        } catch (e: IOException) {
            throw InstallException("network")
        } finally {
            conn.disconnect()
        }
    }

    private fun unpack(asset: InstallAsset, zip: File) {
        val staging = layout.staging(asset.dir)
        staging.deleteRecursively()
        if (!staging.mkdirs()) throw InstallException("storage")
        try {
            val stagingRoot = staging.canonicalFile.path + File.separator
            var entries = 0
            var total = 0L
            ZipInputStream(BufferedInputStream(FileInputStream(zip))).use { zin ->
                val buffer = ByteArray(BUFFER_BYTES)
                while (true) {
                    if (cancelled[asset.id] == true) throw InstallException("cancelled")
                    val entry = zin.nextEntry ?: break
                    if (++entries > MAX_ENTRIES) throw InstallException("zip_layout")
                    val rel = ZipGuard.safeRelative(entry.name, asset.dir) ?: throw InstallException("zip_layout")
                    val target = File(staging, rel).canonicalFile
                    if (!target.path.startsWith(stagingRoot)) throw InstallException("zip_layout")
                    if (entry.isDirectory) {
                        target.mkdirs()
                        continue
                    }
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { out ->
                        while (true) {
                            val n = zin.read(buffer)
                            if (n < 0) break
                            total += n
                            if (total > MAX_UNPACKED_BYTES) throw InstallException("zip_layout")
                            out.write(buffer, 0, n)
                        }
                    }
                }
            }
            val unpacked = File(staging, asset.dir)
            if (!unpacked.isDirectory) throw InstallException("zip_layout")
            val dest = layout.dir(asset.dir)
            dest.deleteRecursively()
            layout.marker(asset.dir).deleteRecursively()
            dest.parentFile?.mkdirs()
            if (!unpacked.renameTo(dest)) throw InstallException("storage")
            layout.shaFile(asset.dir).writeText(asset.sha256)
            val marker = layout.marker(asset.dir)
            if (!marker.mkdirs() && !marker.isDirectory) throw InstallException("storage")
        } catch (e: IOException) {
            throw InstallException("storage")
        } finally {
            staging.deleteRecursively()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(BUFFER_BYTES)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 30_000
        const val BUFFER_BYTES = 64 * 1024
        const val PROGRESS_INTERVAL_MS = 250L
        const val MAX_ENTRIES = 10_000
        const val MAX_UNPACKED_BYTES = 1_610_612_736L // 1.5 GB
    }
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest --tests 'com.anyidea.avatar_app.duix.*'
```

Expected：`BUILD SUCCESSFUL`，Task 2 的 5 个加本任务的 15 个测试全部通过。

- [x] **Step 5: 在 `DuixHost` 接上安装通道和事件通道**

把 `app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt` 整体替换为：

```kotlin
package com.anyidea.avatar_app.duix

import android.app.Activity
import android.app.ActivityManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.platform.PlatformViewRegistry
import java.io.Closeable
import java.util.concurrent.Executors

/** Owns the Duix channels for one Flutter engine. */
class DuixHost(
    private val activity: Activity,
    messenger: BinaryMessenger,
    @Suppress("unused") private val views: PlatformViewRegistry,
) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler, Closeable {
    private val main = Handler(Looper.getMainLooper())
    private val methods = MethodChannel(messenger, DuixChannels.METHODS)
    private val events = EventChannel(messenger, DuixChannels.EVENTS)
    private val installs = Executors.newSingleThreadExecutor { Thread(it, "duix-install") }
    private val layout: InstallLayout? = activity.getExternalFilesDir("duix")?.let(::InstallLayout)
    private val installer: ModelInstaller? = layout?.let { ModelInstaller(it) }
    private var sink: EventChannel.EventSink? = null

    init {
        methods.setMethodCallHandler(this)
        events.setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
        sink = events
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private fun emit(event: Map<String, Any>) {
        main.post { sink?.success(event) }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "probe" -> result.success(probe(call.argument<Int>("minTotalMemMb") ?: Int.MAX_VALUE))
            "installStatus" -> installStatus(call, result)
            "install" -> install(call, result)
            "cancelInstall" -> {
                call.argument<String>("id")?.let { installer?.cancel(it) }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun probe(minTotalMemMb: Int): Map<String, Any?> {
        val memory = ActivityManager.MemoryInfo()
        activity.getSystemService(ActivityManager::class.java).getMemoryInfo(memory)
        val reason = DeviceGate.reason(
            abis = Build.SUPPORTED_ABIS.toList(),
            totalMemBytes = memory.totalMem,
            minTotalMemMb = minTotalMemMb,
            libraryLoaded = libraryLoaded(),
            storageReady = layout != null,
        )
        DuixDiag.log("duix_probe", "supported" to (reason == null), "reason" to (reason ?: "none"))
        return mapOf("supported" to (reason == null), "reason" to reason)
    }

    /** A few stats and one tiny read per asset: cheap enough for the main thread. */
    private fun installStatus(call: MethodCall, result: MethodChannel.Result) {
        val inst = installer ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val assets = call.argument<List<Map<String, Any?>>>("assets").orEmpty()
        val status = HashMap<String, Boolean>()
        for (a in assets) {
            val id = a["id"] as? String ?: continue
            val dir = a["dir"] as? String
            val sha = a["sha256"] as? String
            status[id] = dir != null && sha != null && ZipGuard.safeRelative(dir, dir) == dir && inst.isInstalled(dir, sha)
        }
        result.success(status)
    }

    private fun install(call: MethodCall, result: MethodChannel.Result) {
        val inst = installer ?: return result.error(DeviceGate.STORAGE_UNAVAILABLE, null, null)
        val asset = try {
            InstallAsset.parse(call.arguments as? Map<*, *> ?: emptyMap<String, Any>())
        } catch (e: InstallException) {
            return result.error(e.code, null, null)
        }
        installs.execute {
            val outcome = try {
                inst.install(asset) { phase, received, total ->
                    emit(mapOf("type" to "install", "id" to asset.id, "phase" to phase, "received" to received, "total" to total))
                }
                null
            } catch (e: InstallException) {
                e.code
            } catch (e: Exception) {
                "storage"
            }
            DuixDiag.log("duix_install", "id" to asset.id, "result" to (outcome ?: "ok"))
            main.post { if (outcome == null) result.success(null) else result.error(outcome, null, null) }
        }
    }

    override fun close() {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        installs.shutdownNow()
    }

    private fun libraryLoaded(): Boolean = try {
        System.loadLibrary("gjduix")
        true
    } catch (e: UnsatisfiedLinkError) {
        false
    }
}
```

`installStatus` 里的 `ZipGuard.safeRelative(dir, dir) == dir` 用来拒绝带路径分隔符或 `..` 的目录名。

- [x] **Step 6: 编译并全量回归**

```bash
cd app/android && ./gradlew :app:testDebugUnitTest
cd .. && flutter build apk --debug --dart-define-from-file=dev.json
```

Expected：Kotlin 测试全部通过，APK 构建成功。真机上的安装验证放在 Task 13（那时才有 UI）。

- [x] **Step 7: 提交**

```bash
git add app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/InstallLayout.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ZipGuard.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ResumePlan.kt \
  app/android/app/src/main/kotlin/com/anyidea/avatar_app/duix/ModelInstaller.kt \
  app/android/app/src/duix/kotlin/com/anyidea/avatar_app/duix/DuixHost.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/InstallLayoutTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ZipGuardTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ResumePlanTest.kt \
  app/android/app/src/test/kotlin/com/anyidea/avatar_app/duix/ModelInstallerTest.kt
git commit -m "feat(duix): download, verify and unpack Duix models safely

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
