package com.abyyworld.arise.life

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject
import java.io.File

// What the Player turned on in Settings, Your life, Android, for the parts that run while the app
// is closed (the notification recorder). The app sets it (LifePlugin.setNotifications).
object LifePrefs {
    private const val NAME = "arise-life"
    private const val NOTIFICATIONS = "notifications"
    private const val TEXT = "notificationText"
    const val SEQ = "seq"

    fun prefs(ctx: Context): SharedPreferences = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun notificationsOn(ctx: Context): Boolean = prefs(ctx).getBoolean(NOTIFICATIONS, false)

    // With the text of each notification, or only who and when (the default).
    fun notificationText(ctx: Context): Boolean = prefs(ctx).getBoolean(TEXT, false)

    fun setNotifications(ctx: Context, on: Boolean, text: Boolean) {
        prefs(ctx).edit().putBoolean(NOTIFICATIONS, on).putBoolean(TEXT, on && text).apply()
    }
}

// Notifications noted while the app is closed, kept in a file in the app's own storage (no other
// app can read it) until the app takes them into the life log. One JSON object per line, each
// with a number (`seq`) that only goes up. The app reads them, adds them to the life log, then
// says which it has (ack), so none is lost if the app is closed halfway.
object LifeQueue {
    private const val FILE = "life/notifications.jsonl"
    // At most this many wait for the app. If it isn't opened for a long time, the oldest go first.
    private const val MAX = 5000

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)

    private fun lines(ctx: Context): List<String> {
        val f = file(ctx)
        if (!f.exists()) return emptyList()
        return f.readLines().filter { it.isNotBlank() }
    }

    private fun write(ctx: Context, keep: List<String>) {
        val f = file(ctx)
        if (keep.isEmpty()) {
            f.delete()
            return
        }
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, "${f.name}.tmp")
        tmp.writeText(keep.joinToString("\n", postfix = "\n"))
        if (!tmp.renameTo(f)) {
            f.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun seqOf(line: String): Long = try {
        JSONObject(line).optLong("seq", 0L)
    } catch (_: Exception) {
        0L
    }

    @Synchronized
    fun add(ctx: Context, item: JSONObject) {
        val prefs = LifePrefs.prefs(ctx)
        val seq = prefs.getLong(LifePrefs.SEQ, 0L) + 1
        prefs.edit().putLong(LifePrefs.SEQ, seq).apply()
        item.put("seq", seq)
        val f = file(ctx)
        f.parentFile?.mkdirs()
        f.appendText(item.toString() + "\n")
        if (seq % 200L == 0L) {
            val all = lines(ctx)
            if (all.size > MAX) write(ctx, all.takeLast(MAX))
        }
    }

    // The oldest `max` waiting, and the number of the last one.
    @Synchronized
    fun read(ctx: Context, max: Int): Pair<List<JSONObject>, Long> {
        val out = ArrayList<JSONObject>()
        var last = 0L
        for (line in lines(ctx)) {
            if (out.size >= max) break
            try {
                val o = JSONObject(line)
                out.add(o)
                last = maxOf(last, o.optLong("seq", 0L))
            } catch (_: Exception) {
                // A line cut short (the phone switched off while writing): skipped.
            }
        }
        return Pair(out, last)
    }

    // The app has everything up to `upTo`: those go.
    @Synchronized
    fun ack(ctx: Context, upTo: Long) {
        write(ctx, lines(ctx).filter { seqOf(it) > upTo })
    }

    @Synchronized
    fun count(ctx: Context): Int = lines(ctx).size

    @Synchronized
    fun clear(ctx: Context) {
        file(ctx).delete()
    }
}
