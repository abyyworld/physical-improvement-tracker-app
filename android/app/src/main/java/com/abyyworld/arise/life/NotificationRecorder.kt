package com.abyyworld.arise.life

import android.app.Notification
import android.content.Context
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

// Notes the notifications other apps show: which app and when, who it's from (the title of a
// message, a call or an email), and the rest of the title and the text only if the Player turned
// that on. Android runs this while Arise has Notification
// access and the Player has it on in Settings (LifePlugin.setNotifications enables it). Nothing
// leaves the phone from here: each one waits in LifeQueue until the app takes it into the life log.
//
// Skipped: Arise's own, the system's, ongoing ones (music, navigation, a download), group
// summaries (they repeat the ones in the group) and an update that changes nothing.
class NotificationRecorder : NotificationListenerService() {

    // The last thing noted for each notification, so an update without anything new is skipped.
    private val lastSeen = object : LinkedHashMap<String, Int>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?): Boolean = size > 300
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        try {
            record(applicationContext, sbn)
        } catch (_: Exception) {
            // Never let one odd notification stop the recorder.
        }
    }

    private fun record(ctx: Context, sbn: StatusBarNotification) {
        if (!LifePrefs.notificationsOn(ctx)) return
        val pkg = sbn.packageName ?: return
        if (pkg == ctx.packageName || pkg in SYSTEM) return
        if (sbn.isOngoing) return
        val n = sbn.notification ?: return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return
        val category: String? = n.category
        if (category != null && category in SKIP_CATEGORIES) return
        val extras = n.extras ?: return
        if (extras.containsKey(Notification.EXTRA_MEDIA_SESSION)) return
        if (extras.getString(Notification.EXTRA_TEMPLATE)?.contains("MediaStyle") == true) return

        val withText = LifePrefs.notificationText(ctx)
        val fullTitle = clean(extras.getCharSequence(Notification.EXTRA_TITLE), 200)
        val fullText = clean(extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT), 1000)
        if (fullTitle.isEmpty() && fullText.isEmpty()) return
        // The title is who it's from only for a message, a call or an email. For anything else (a
        // bank alert, a delivery) it says what happened, so it's kept only with the text.
        val person = (category != null && category in FROM_SOMEONE) ||
            extras.getString(Notification.EXTRA_TEMPLATE)?.contains("MessagingStyle") == true
        val title = if (withText || person) fullTitle else ""
        val text = if (withText) fullText else ""

        val sig = "$title\u0000$text".hashCode()
        val key = sbn.key ?: "$pkg:${sbn.id}"
        synchronized(lastSeen) {
            if (lastSeen[key] == sig) return
            lastSeen[key] = sig
        }

        val item = JSONObject()
            .put("key", key)
            .put("pkg", pkg)
            .put("app", appName(ctx, pkg))
            .put("title", title)
            .put("person", person)
            .put("at", sbn.postTime)
        if (category != null) item.put("category", category)
        if (text.isNotEmpty()) item.put("text", text)
        LifeQueue.add(ctx, item)
    }

    private fun clean(value: CharSequence?, max: Int): String =
        value?.toString()?.replace(Regex("\\s+"), " ")?.trim()?.take(max) ?: ""

    companion object {
        private val SYSTEM = setOf("android", "com.android.systemui", "com.android.providers.downloads")
        private val SKIP_CATEGORIES = setOf(
            Notification.CATEGORY_PROGRESS,
            Notification.CATEGORY_SERVICE,
            Notification.CATEGORY_TRANSPORT,
            Notification.CATEGORY_SYSTEM,
            Notification.CATEGORY_NAVIGATION,
            Notification.CATEGORY_STATUS,
        )
        // Where the title is the person: messages, calls (and missed ones, "missed_call" from
        // Android 12) and emails.
        private val FROM_SOMEONE = setOf(
            Notification.CATEGORY_MESSAGE,
            Notification.CATEGORY_CALL,
            "missed_call",
            Notification.CATEGORY_EMAIL,
        )

        // The name people see under the app's icon, or its package name if Android won't say.
        fun appName(ctx: Context, pkg: String): String = try {
            val pm = ctx.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Exception) {
            pkg
        }
    }
}
