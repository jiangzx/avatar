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
