package com.abyyworld.arise.life

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationManagerCompat
import androidx.health.connect.client.PermissionController
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.time.Instant
import java.time.LocalDate

// Your life, Android: what the app's Settings (src/life/android-sense.ts) asks of the phone.
// Every read happens only when the app asks, while it's open, and hands the rows straight back:
// nothing is sent anywhere from here. The notification recorder (NotificationRecorder) is the only
// part that runs while the app is closed, and only while the Player has it on.
@CapacitorPlugin(
    name = "AriseLife",
    permissions = [
        Permission(alias = "calls", strings = [Manifest.permission.READ_CALL_LOG]),
        Permission(alias = "contacts", strings = [Manifest.permission.READ_CONTACTS]),
        Permission(alias = "calendar", strings = [Manifest.permission.READ_CALENDAR]),
    ],
)
class LifePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val healthContract by lazy { PermissionController.createRequestPermissionResultContract() }

    override fun handleOnDestroy() {
        scope.cancel()
    }

    // Runs the work away from the app's main thread, and answers the app with what it gives.
    private fun work(call: PluginCall, block: suspend () -> JSObject) {
        scope.launch {
            try {
                call.resolve(block())
            } catch (e: SecurityException) {
                call.reject("Arise isn't allowed to read this.", "denied")
            } catch (e: Exception) {
                call.reject(e.message ?: "Something went wrong.", "failed")
            }
        }
    }

    private fun granted(alias: String) = getPermissionState(alias) == PermissionState.GRANTED

    // A whole number the app sent. (Capacitor's getLong only takes numbers too big for an Int.)
    private fun PluginCall.long(name: String, default: Long): Long = if (data.has(name)) data.optLong(name, default) else default

    // What the phone allows right now, and what's waiting.
    @PluginMethod
    fun status(call: PluginCall) {
        work(call) {
            val ctx = context
            // (Health Connect can fail on its own, say while it's being updated: that's "nothing allowed".)
            val health = try {
                HealthReader.granted(ctx)
            } catch (_: Exception) {
                emptyList()
            }
            JSObject()
                .put("sdk", Build.VERSION.SDK_INT)
                .put("notificationAccess", NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName))
                .put("notificationsOn", LifePrefs.notificationsOn(ctx))
                .put("queued", LifeQueue.count(ctx))
                .put("usageAccess", UsageReader.hasAccess(ctx))
                .put("health", HealthReader.availability(ctx))
                .put("healthGranted", JSONArray(health))
        }
    }

    // ---------- notifications

    // Turns the recorder on or off. Off: Android stops it, and what waits for the app is deleted.
    @PluginMethod
    fun setNotifications(call: PluginCall) {
        val ctx = context
        val on = call.getBoolean("on", false) ?: false
        val text = call.getBoolean("text", false) ?: false
        LifePrefs.setNotifications(ctx, on, text)
        val component = ComponentName(ctx, NotificationRecorder::class.java)
        ctx.packageManager.setComponentEnabledSetting(
            component,
            if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
        if (on) {
            try {
                NotificationListenerService.requestRebind(component)
            } catch (_: Exception) {
                // Not allowed yet: Android starts it once the Player gives Notification access.
            }
        } else {
            LifeQueue.clear(ctx)
        }
        call.resolve()
    }

    // The oldest notifications waiting, and the number of the last one (to say "got them").
    @PluginMethod
    fun readNotifications(call: PluginCall) {
        val max = (call.getInt("max", 500) ?: 500).coerceIn(1, 2000)
        work(call) {
            val (items, last) = LifeQueue.read(context, max)
            JSObject().put("items", JSArray(items)).put("last", last)
        }
    }

    @PluginMethod
    fun ackNotifications(call: PluginCall) {
        val upTo = call.long("upTo", -1L)
        if (upTo < 0L) {
            call.reject("upTo is missing.")
            return
        }
        work(call) {
            LifeQueue.ack(context, upTo)
            JSObject()
        }
    }

    // ---------- calls, app use, calendar

    @PluginMethod
    fun readCalls(call: PluginCall) {
        if (!granted("calls")) {
            call.reject("Arise isn't allowed to read the call log.", "denied")
            return
        }
        val since = call.long("since", 0L)
        val max = (call.getInt("max", 500) ?: 500).coerceIn(1, 2000)
        val contacts = granted("contacts")
        work(call) { JSObject().put("calls", CallReader.read(context, since, max, contacts)) }
    }

    @PluginMethod
    fun readUsage(call: PluginCall) {
        if (!UsageReader.hasAccess(context)) {
            call.reject("Arise doesn't have Usage access.", "denied")
            return
        }
        val from = call.long("from", 0L)
        val to = call.long("to", 0L)
        work(call) { JSObject().put("usage", UsageReader.read(context, from, to)) }
    }

    @PluginMethod
    fun readCalendar(call: PluginCall) {
        if (!granted("calendar")) {
            call.reject("Arise isn't allowed to read the calendar.", "denied")
            return
        }
        val from = call.long("from", 0L)
        val to = call.long("to", 0L)
        val max = (call.getInt("max", 1000) ?: 1000).coerceIn(1, 5000)
        work(call) { JSObject().put("events", CalendarReader.read(context, from, to, max)) }
    }

    // ---------- Health Connect

    // Asks for Arise's health permissions on Health Connect's own screen. On Android 13 and older,
    // Health Connect may need installing first: then the Play Store opens.
    @PluginMethod
    fun requestHealth(call: PluginCall) {
        when (HealthReader.availability(context)) {
            "available" -> startActivityForResult(call, healthContract.createIntent(context, HealthReader.PERMISSIONS), "healthAnswered")
            "install" -> {
                openFirst(
                    listOf(
                        Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$HEALTH_APP&url=healthconnect%3A%2F%2Fonboarding")).setPackage("com.android.vending"),
                        Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$HEALTH_APP")),
                    ),
                )
                call.resolve(JSObject().put("health", "install").put("granted", JSONArray()))
            }
            else -> call.resolve(JSObject().put("health", "unsupported").put("granted", JSONArray()))
        }
    }

    @ActivityCallback
    private fun healthAnswered(call: PluginCall, result: ActivityResult) {
        work(call) { JSObject().put("health", "available").put("granted", JSONArray(HealthReader.granted(context))) }
    }

    // Steps and heart rate for whole days in [fromDay, toDay), and sleep and workouts in [from, to).
    @PluginMethod
    fun readHealth(call: PluginCall) {
        if (HealthReader.availability(context) != "available") {
            call.reject("Health Connect isn't available.", "unavailable")
            return
        }
        val fromDay = call.getString("fromDay")
        val toDay = call.getString("toDay")
        val from = call.long("from", 0L)
        val to = call.long("to", 0L)
        work(call) {
            val days = if (fromDay != null && toDay != null) HealthReader.days(context, LocalDate.parse(fromDay), LocalDate.parse(toDay)) else JSONArray()
            val sessions = HealthReader.sessions(context, Instant.ofEpochMilli(from), Instant.ofEpochMilli(to))
            JSObject().put("days", days).put("sessions", sessions)
        }
    }

    // ---------- turning one off

    // The Player turned one off: Arise gives back what it can. Health Connect forgets Arise's
    // permissions straight away; a phone permission goes once the app is closed (Android 13 and
    // later; on older ones the Player takes it back in App info).
    @PluginMethod
    fun forget(call: PluginCall) {
        val what = call.getString("what") ?: ""
        if (what == "health") {
            work(call) {
                HealthReader.revoke(context)
                JSObject()
            }
            return
        }
        val permissions = when (what) {
            "calls" -> listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_CONTACTS)
            "calendar" -> listOf(Manifest.permission.READ_CALENDAR)
            else -> emptyList()
        }
        if (permissions.isNotEmpty() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                context.revokeSelfPermissionsOnKill(permissions)
            } catch (_: Exception) {
            }
        }
        call.resolve()
    }

    // ---------- opening the phone's own screens

    // "notifications": Notification access; "usage": Usage access; "health": Health Connect;
    // anything else: Arise's App info (permissions, "Allow restricted settings").
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val ctx = context
        val pkg = Uri.parse("package:${ctx.packageName}")
        val intents = when (call.getString("screen")) {
            "notifications" -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(ctx, NotificationRecorder::class.java).flattenToString())
                } else {
                    null
                },
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
            )
            "usage" -> listOf(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, pkg), Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
            "health" -> listOf(Intent(HEALTH_SETTINGS))
            else -> listOf(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        }
        if (openFirst(intents)) call.resolve() else call.reject("Couldn't open that screen.", "failed")
    }

    // A web page (the newest Arise.apk) in the browser.
    @PluginMethod
    fun openUrl(call: PluginCall) {
        val url = call.getString("url") ?: ""
        if (!url.startsWith("https://")) {
            call.reject("Only https links open.", "failed")
            return
        }
        if (openFirst(listOf(Intent(Intent.ACTION_VIEW, Uri.parse(url))))) call.resolve() else call.reject("No browser to open it.", "failed")
    }

    private fun openFirst(intents: List<Intent>): Boolean {
        val ctx = context
        for (intent in intents) {
            try {
                // From the app's own screen, Back comes back to Arise.
                if (ctx !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(intent)
                return true
            } catch (_: Exception) {
                // That screen isn't on this phone: try the next.
            }
        }
        return false
    }

    companion object {
        private const val HEALTH_APP = "com.google.android.apps.healthdata"
        private const val HEALTH_SETTINGS = "androidx.health.ACTION_HEALTH_CONNECT_SETTINGS"
    }
}
