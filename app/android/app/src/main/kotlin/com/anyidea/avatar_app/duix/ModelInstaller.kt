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
