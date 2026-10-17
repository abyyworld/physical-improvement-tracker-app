package com.abyyworld.arise.life

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.Period

// Health Connect: steps, sleep, workouts and heart rate, read only while the app is open (Android
// only lets an app read Health Connect in the background with yet another permission).
object HealthReader {
    private val STEPS = HealthPermission.getReadPermission(StepsRecord::class)
    private val SLEEP = HealthPermission.getReadPermission(SleepSessionRecord::class)
    private val EXERCISE = HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    private val HEART = HealthPermission.getReadPermission(HeartRateRecord::class)
    val PERMISSIONS = setOf(STEPS, SLEEP, EXERCISE, HEART)

    // "available", "install" (Health Connect needs installing or updating, on Android 13 and older)
    // or "unsupported".
    fun availability(ctx: Context): String = when (HealthConnectClient.getSdkStatus(ctx)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "install"
        else -> "unsupported"
    }

    private fun client(ctx: Context) = HealthConnectClient.getOrCreate(ctx)

    // Which of Arise's health permissions the Player allowed: "steps", "sleep", "exercise", "heart".
    suspend fun granted(ctx: Context): List<String> {
        if (availability(ctx) != "available") return emptyList()
        val granted = client(ctx).permissionController.getGrantedPermissions()
        return listOfNotNull(
            if (STEPS in granted) "steps" else null,
            if (SLEEP in granted) "sleep" else null,
            if (EXERCISE in granted) "exercise" else null,
            if (HEART in granted) "heart" else null,
        )
    }

    suspend fun revoke(ctx: Context) {
        if (availability(ctx) == "available") client(ctx).permissionController.revokeAllPermissions()
    }

    // Steps and heart rate for each whole day in [from, to) on the phone's clock, as
    // { day: "2026-10-16", steps?, hrMin?, hrAvg?, hrMax? }.
    suspend fun days(ctx: Context, from: LocalDate, to: LocalDate): JSONArray {
        val out = JSONArray()
        if (!from.isBefore(to)) return out
        val client = client(ctx)
        val granted = client.permissionController.getGrantedPermissions()
        val metrics = HashSet<AggregateMetric<*>>()
        if (STEPS in granted) metrics.add(StepsRecord.COUNT_TOTAL)
        if (HEART in granted) metrics.addAll(listOf(HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MAX))
        if (metrics.isEmpty()) return out
        val groups = client.aggregateGroupByPeriod(
            AggregateGroupByPeriodRequest(
                metrics = metrics,
                timeRangeFilter = TimeRangeFilter.between(from.atStartOfDay(), to.atStartOfDay()),
                timeRangeSlicer = Period.ofDays(1),
            ),
        )
        for (g in groups) {
            val o = JSONObject().put("day", g.startTime.toLocalDate().toString())
            g.result[StepsRecord.COUNT_TOTAL]?.let { o.put("steps", it) }
            g.result[HeartRateRecord.BPM_MIN]?.let { o.put("hrMin", it) }
            g.result[HeartRateRecord.BPM_AVG]?.let { o.put("hrAvg", it) }
            g.result[HeartRateRecord.BPM_MAX]?.let { o.put("hrMax", it) }
            if (o.length() > 1) out.put(o)
        }
        return out
    }

    // Sleep and workouts that ended in [from, to), as
    // { id, kind: "sleep" | "workout", start, end, title, type? }.
    suspend fun sessions(ctx: Context, from: Instant, to: Instant): JSONArray {
        val out = JSONArray()
        if (!from.isBefore(to)) return out
        val client = client(ctx)
        val granted = client.permissionController.getGrantedPermissions()
        val range = TimeRangeFilter.between(from, to)
        if (SLEEP in granted) {
            var token: String? = null
            do {
                val page = client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, range, pageToken = token))
                for (r in page.records) {
                    out.put(
                        JSONObject()
                            .put("id", r.metadata.id)
                            .put("kind", "sleep")
                            .put("start", r.startTime.toEpochMilli())
                            .put("end", r.endTime.toEpochMilli())
                            .put("title", r.title ?: ""),
                    )
                }
                token = page.pageToken
            } while (!token.isNullOrEmpty() && out.length() < 2000)
        }
        if (EXERCISE in granted) {
            var token: String? = null
            do {
                val page = client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, range, pageToken = token))
                for (r in page.records) {
                    out.put(
                        JSONObject()
                            .put("id", r.metadata.id)
                            .put("kind", "workout")
                            .put("start", r.startTime.toEpochMilli())
                            .put("end", r.endTime.toEpochMilli())
                            .put("title", r.title ?: "")
                            .put("type", exerciseName(r.exerciseType)),
                    )
                }
                token = page.pageToken
            } while (!token.isNullOrEmpty() && out.length() < 4000)
        }
        return out
    }

    // A plain name for the most common kinds of workout ("" for the rest).
    private fun exerciseName(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "Walk"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "Run"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "Treadmill run"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "Hike"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "Bike ride"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "Indoor cycling"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "Swim"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "Swim"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "Strength training"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "Weightlifting"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "Calisthenics"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIIT"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "Yoga"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "Pilates"
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING -> "Stretching"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "Football"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "Basketball"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "Tennis"
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "Badminton"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE -> "Rowing"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "Elliptical"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "Dancing"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "Martial arts"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "Boxing"
        else -> ""
    }
}
