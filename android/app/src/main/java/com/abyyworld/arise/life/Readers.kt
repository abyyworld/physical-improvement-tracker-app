package com.abyyworld.arise.life

import android.Manifest
import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.CalendarContract
import android.provider.CallLog
import android.provider.ContactsContract
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

// The phone's call log, oldest first, from a time on. Each row as it is, with the name from the
// contacts when Arise may read them; the app turns rows into life events (src/life/android-sense.ts).
object CallReader {
    fun read(ctx: Context, since: Long, max: Int, withContacts: Boolean): JSONArray {
        val out = JSONArray()
        val projection = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.NUMBER_PRESENTATION,
        )
        val names = HashMap<String, String>()
        ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            projection,
            "${CallLog.Calls.DATE} >= ?",
            arrayOf(since.toString()),
            "${CallLog.Calls.DATE} ASC",
        )?.use { c ->
            while (out.length() < max && c.moveToNext()) {
                val number = c.getString(1) ?: ""
                var name = c.getString(2) ?: ""
                if (withContacts && number.isNotBlank()) {
                    name = names.getOrPut(number) { contactName(ctx, number) ?: "" }.ifBlank { name }
                }
                out.put(
                    JSONObject()
                        .put("id", c.getLong(0))
                        .put("number", number)
                        .put("name", name)
                        .put("type", c.getInt(3))
                        .put("date", c.getLong(4))
                        .put("duration", c.getLong(5))
                        .put("presentation", c.getInt(6)),
                )
            }
        }
        return out
    }

    private fun contactName(ctx: Context, number: String): String? = try {
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
}

// How long each app was on the screen, per hour, from Android's own record of app use (it keeps
// about a week of it).
object UsageReader {
    // (Each Android version has deprecated one of these two names; both still work.)
    @Suppress("DEPRECATION")
    fun hasAccess(ctx: Context): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        } else {
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        }
        return if (mode == AppOpsManager.MODE_DEFAULT) {
            ctx.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED
        } else {
            mode == AppOpsManager.MODE_ALLOWED
        }
    }

    // Time on screen per app and hour, for [from, to) (both on the hour of the phone's clock), as
    // { pkg, app, hour (its start), ms }. The home screen and the system's own screens aren't apps.
    fun read(ctx: Context, from: Long, to: Long): JSONArray {
        val out = JSONArray()
        if (to <= from) return out
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val skip = HashSet<String>(listOf("android", "com.android.systemui"))
        homeApp(ctx)?.let { skip.add(it) }

        val zone = TimeZone.getDefault()
        val totals = HashMap<String, HashMap<Long, Long>>() // package -> hour -> ms
        fun add(pkg: String, start: Long, end: Long) {
            var s = maxOf(start, from)
            val e = minOf(end, to)
            while (s < e) {
                // The start of the hour on the phone's clock (time zones can be half an hour off).
                val offset = zone.getOffset(s).toLong()
                val hour = s - Math.floorMod(s + offset, HOUR)
                val stop = minOf(e, hour + HOUR)
                val hours = totals.getOrPut(pkg) { HashMap() }
                hours[hour] = (hours[hour] ?: 0L) + (stop - s)
                s = stop
            }
        }

        val open = HashMap<String, Long>() // package -> when it came to the front
        val seen = HashSet<String>()
        val events = usm.queryEvents(from, to)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            val pkg = e.packageName ?: continue
            when (e.eventType) {
                RESUMED -> {
                    seen.add(pkg)
                    if (!open.containsKey(pkg)) open[pkg] = e.timeStamp
                }
                PAUSED, STOPPED -> {
                    val start = open.remove(pkg)
                    // On the screen since before `from`.
                    if (start != null) add(pkg, start, e.timeStamp) else if (pkg !in seen) add(pkg, from, e.timeStamp)
                    seen.add(pkg)
                }
                SCREEN_OFF, SHUTDOWN -> {
                    for ((p, start) in open) add(p, start, e.timeStamp)
                    open.clear()
                }
            }
        }
        for ((p, start) in open) add(p, start, to)

        val labels = HashMap<String, String>()
        for ((pkg, hours) in totals) {
            if (pkg in skip) continue
            for ((hour, ms) in hours) {
                out.put(
                    JSONObject()
                        .put("pkg", pkg)
                        .put("app", labels.getOrPut(pkg) { NotificationRecorder.appName(ctx, pkg) })
                        .put("hour", hour)
                        .put("ms", ms),
                )
            }
        }
        return out
    }

    private fun homeApp(ctx: Context): String? = try {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        ctx.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
    } catch (_: Exception) {
        null
    }

    private const val HOUR = 3_600_000L
    // UsageEvents.Event types (the newer names, with the same numbers on every Android version).
    private const val RESUMED = 1 // ACTIVITY_RESUMED, once MOVE_TO_FOREGROUND
    private const val PAUSED = 2 // ACTIVITY_PAUSED, once MOVE_TO_BACKGROUND
    private const val STOPPED = 23 // ACTIVITY_STOPPED
    private const val SCREEN_OFF = 16 // SCREEN_NON_INTERACTIVE
    private const val SHUTDOWN = 26 // DEVICE_SHUTDOWN
}

// Events in the phone's calendars that started in [from, to): the title, when, and whether it
// lasts all day. Cancelled events, and ones the Player said no to, are left out.
object CalendarReader {
    fun read(ctx: Context, from: Long, to: Long, max: Int): JSONArray {
        val out = JSONArray()
        if (to <= from) return out
        val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(builder, from)
        ContentUris.appendId(builder, to)
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.STATUS,
            CalendarContract.Instances.SELF_ATTENDEE_STATUS,
        )
        ctx.contentResolver.query(builder.build(), projection, null, null, "${CalendarContract.Instances.BEGIN} ASC")?.use { c ->
            while (out.length() < max && c.moveToNext()) {
                val begin = c.getLong(1)
                if (begin < from || begin >= to) continue
                if (c.getInt(5) == CalendarContract.Events.STATUS_CANCELED) continue
                if (c.getInt(6) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue
                out.put(
                    JSONObject()
                        .put("id", c.getLong(0))
                        .put("begin", begin)
                        .put("end", c.getLong(2))
                        .put("title", c.getString(3) ?: "")
                        .put("allDay", c.getInt(4) == 1),
                )
            }
        }
        return out
    }
}
