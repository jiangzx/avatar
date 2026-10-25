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
