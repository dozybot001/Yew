package cn.tenonai.apps.yew.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.content.edit
import cn.tenonai.apps.yew.MainActivity
import cn.tenonai.apps.yew.R
import cn.tenonai.apps.yew.api.Center
import cn.tenonai.apps.yew.api.int
import cn.tenonai.apps.yew.api.list
import cn.tenonai.apps.yew.api.str
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** What a notification says once read (src/server/push.ts): one to show, or a list to take away. */
class Note(
    val id: String?,
    val kind: String?,
    val title: String?,
    val body: String?,
    /** The session to open when it is tapped; without one, the approval center. */
    val session: String?,
    /** For `many`: how many items it sums up. */
    val n: Int?,
    val code: String?,
    val badge: Int?,
    /** Ids of notifications that were handled and come off the screen. */
    val clear: List<String>?,
) {
    companion object {
        fun parse(data: String): Note? {
            val json = runCatching { Json.parseToJsonElement(data).jsonObject }.getOrNull() ?: return null
            return Note(
                id = json.str("id"),
                kind = json.str("kind"),
                title = json.str("title"),
                body = json.str("body"),
                session = json.str("session"),
                n = json.int("n"),
                code = json.str("code"),
                badge = json.int("badge"),
                clear = if (json.containsKey("clear")) {
                    json.list("clear").mapNotNull { (it as? JsonPrimitive)?.content }
                } else {
                    null
                },
            )
        }
    }
}

/** A notification's words: the session or item as the title, what happened as the body (as the iPhone app writes them). */
class NoteText(note: Note, text: (Int) -> String, count: (Int, Int) -> String) {
    val title: String
    val body: String

    init {
        val label = when (note.kind) {
            "permission" -> text(R.string.push_permission)
            "question" -> text(R.string.push_question)
            "card" -> text(R.string.push_card)
            "letter" -> text(R.string.push_letter)
            "error" -> text(R.string.push_error)
            "review" -> text(R.string.push_review)
            "task" -> when (note.code) {
                "given_up" -> text(R.string.push_task_given_up)
                "failed" -> text(R.string.push_task_failed)
                else -> text(R.string.push_task_done)
            }
            "schedule" -> text(if (note.code == "error") R.string.push_schedule_error else R.string.push_schedule_done)
            "budget" -> text(if (note.code == "budget-reached") R.string.push_budget_reached else R.string.push_budget_warning)
            "many" -> count(R.plurals.push_many, note.n ?: 0)
            else -> text(R.string.push_fallback)
        }
        val detail = note.body.orEmpty()
        title = note.title.orEmpty().ifEmpty { "Yew Harness" }
        body = if (detail.isEmpty()) label else label + text(R.string.push_separator) + detail
    }
}

/**
 * Shows what the computer tells this phone as Android notifications, and takes them away when the
 * computer says they were handled. The computer decides what is worth a notification and when; the
 * phone only puts it into words.
 */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val prefs = context.getSharedPreferences("notes", Context.MODE_PRIVATE)

    init {
        manager.createNotificationChannel(
            NotificationChannel(NEEDS, context.getString(R.string.channel_needs), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(LINK, context.getString(R.string.channel_link), NotificationManager.IMPORTANCE_MIN)
                .apply { setShowBadge(false) },
        )
    }

    /** One `note` event from `GET /api/notes`. */
    fun handle(data: String) {
        val note = Note.parse(data) ?: return
        if (note.clear != null) {
            for (id in note.clear) manager.cancel(id, NOTE)
            if (note.badge == 0) manager.cancel(CAUGHT_UP, NOTE)
        } else {
            show(note, note.id ?: return)
        }
    }

    private fun show(note: Note, tag: String) {
        val text = NoteText(note, { context.getString(it) }) { id, n -> context.resources.getQuantityString(id, n, n) }
        val open = Intent(context, MainActivity::class.java)
            .setAction("yew.open.$tag")
            .putExtra(MainActivity.OPEN, true)
            .putExtra(MainActivity.SESSION, note.session)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val notification = Notification.Builder(context, NEEDS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(text.title)
            .setContentText(text.body)
            .setStyle(Notification.BigTextStyle().bigText(text.body))
            .setContentIntent(
                PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setGroup(note.session ?: "center")
            .apply { note.badge?.let(::setNumber) }
            .build()
        runCatching { manager.notify(tag, NOTE, notification) }
    }

    /**
     * The approval center as it is now. After the phone was away from the computer ([back]), items
     * it has not seen get one notification that sums them up; the computer keeps nothing for a
     * phone that was not listening.
     */
    fun waiting(center: Center, back: Boolean = false) {
        val keys = center.keys
        val seen = prefs.getStringSet(SEEN, null)
        val fresh = if (seen == null) emptySet() else keys - seen
        prefs.edit { putStringSet(SEEN, keys) }
        if (keys.isEmpty()) {
            // Nothing is waiting, so no notification stays.
            for (shown in manager.activeNotifications) if (shown.id == NOTE) manager.cancel(shown.tag, NOTE)
            return
        }
        if (!back || fresh.isEmpty()) return
        val titles = center.approvals.filter { "approval:${it.id}" in fresh }.map { it.line } +
            center.cards.filter { "card:${it.id}" in fresh }.map { "#${it.number} ${it.title}" } +
            center.held.filter { "letter:${it.id}" in fresh }.map { it.summary }
        val body = titles.filter { it.isNotEmpty() }.joinToString(" · ").take(240)
        show(Note(null, "many", "", body, null, fresh.size, null, keys.size, null), CAUGHT_UP)
    }

    /** Unpaired: nothing of the old pairing stays on the screen or in the list of seen items. */
    fun forget() {
        for (shown in manager.activeNotifications) if (shown.id == NOTE) manager.cancel(shown.tag, NOTE)
        prefs.edit { remove(SEEN) }
    }

    /** Takes down the connection service's standing notification, when it is not running. */
    fun clearStanding() = manager.cancel(SERVICE)

    /** The system lets this app show notifications (the permission on Android 13 and later, and the app's switch). */
    val allowed: Boolean get() = manager.areNotificationsEnabled()

    /** The person's own switch in Yew's settings; on until they turn it off. */
    var wanted: Boolean
        get() = prefs.getBoolean(WANTED, true)
        set(value) = prefs.edit { putBoolean(WANTED, value) }

    /**
     * Whether the connection is kept after Yew is closed (swiped away), after the phone starts and
     * after an update. Off until the person turns it on: then Yew connects only while it is open.
     */
    var keepAfterClose: Boolean
        get() = prefs.getBoolean(KEEP, false)
        set(value) = prefs.edit { putBoolean(KEEP, value) }

    /** Android has been asked for the permission once; after a refusal only system settings can change it. */
    var asked: Boolean
        get() = prefs.getBoolean(ASKED, false)
        set(value) = prefs.edit { putBoolean(ASKED, value) }

    companion object {
        const val NEEDS = "needs"
        const val LINK = "link"
        /** Every notification about Yew's content has this id and its own tag; the service's has [SERVICE]. */
        const val NOTE = 1
        const val SERVICE = 2
        private const val CAUGHT_UP = "caught-up"
        private const val SEEN = "seen"
        private const val WANTED = "wanted"
        private const val ASKED = "asked"
        private const val KEEP = "keep-after-close"
    }
}
