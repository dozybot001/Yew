package cn.tenonai.apps.yew.update

import android.content.Context
import androidx.core.content.edit
import cn.tenonai.apps.yew.BuildConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * New versions of the app (blueprint, "版本与更新"): once a day, unless turned off,
 * Gitee, where the app is published, is asked for its newest release; only that request, with the
 * app's version as the user agent. The About page then links to the release page; nothing is
 * downloaded or installed from here.
 */
class ReleaseCheck(context: Context) {
    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(value) = prefs.edit { putBoolean(KEY_ENABLED, value) }

    /** The newest release seen on Gitee, when it is newer than this app. */
    val newer: String?
        get() = prefs.getString(KEY_LATEST, null)?.takeIf { isNewer(it, BuildConfig.VERSION_NAME) }

    /** Checks when a day has passed since the last check. */
    suspend fun checkIfDue(now: Long = System.currentTimeMillis()) {
        if (!enabled || now - prefs.getLong(KEY_CHECKED, 0) < DAY_MS) return
        check(now)
    }

    /** Asks Gitee now; a failure leaves what was known. */
    suspend fun check(now: Long = System.currentTimeMillis()): Unit = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(LATEST)
            .header("User-Agent", "yew-android/${BuildConfig.VERSION_NAME}")
            .header("Accept", "application/json")
            .build()
        runCatching {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use
                val version = latestVersion(response.body.string()) ?: return@use
                prefs.edit {
                    putString(KEY_LATEST, version)
                    putLong(KEY_CHECKED, now)
                }
            }
        }
    }

    companion object {
        private const val LATEST = "https://gitee.com/api/v5/repos/dozybot/yew/releases/latest"
        private const val DAY_MS = 24L * 60 * 60 * 1000
        private const val KEY_ENABLED = "check"
        private const val KEY_LATEST = "latest"
        private const val KEY_CHECKED = "checkedAt"
        private val PLAIN = Regex("""\d+\.\d+\.\d+""")
        private val http by lazy {
            OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()
        }

        /** The page of a release, where its package is downloaded. */
        fun page(version: String) = "https://gitee.com/dozybot/yew/releases/tag/v$version"

        /** The version a release answer names: its tag without the leading v; null when it is not x.y.z. */
        fun latestVersion(body: String): String? = runCatching {
            Json.parseToJsonElement(body).jsonObject["tag_name"]?.jsonPrimitive?.content?.removePrefix("v")
        }.getOrNull()?.takeIf { PLAIN.matches(it) }

        /** Whether version [a] is newer than [b]: x.y.z, anything after a hyphen left out. */
        fun isNewer(a: String, b: String): Boolean {
            fun parts(version: String) = version.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
            val x = parts(a)
            val y = parts(b)
            for (i in 0 until 3) {
                val left = x.getOrElse(i) { 0 }
                val right = y.getOrElse(i) { 0 }
                if (left != right) return left > right
            }
            return false
        }
    }
}
