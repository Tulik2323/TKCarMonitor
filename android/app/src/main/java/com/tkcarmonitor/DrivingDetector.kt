package com.tkcarmonitor

import java.util.UUID
import kotlin.math.abs

const val GRAVITY = 9.80665

data class Thresholds(
    val hardBrakeMps2: Double = 0.4 * GRAVITY,
    val hardAccelMps2: Double = 0.35 * GRAVITY,
    val sharpTurnMps2: Double = 0.35 * GRAVITY,
    val crashMps2: Double = 4.0 * GRAVITY,
    val speedLimitKmh: Double = 110.0,
    val minSpeedMps: Double = 5.0,
    val cooldownMs: Long = 10_000L,
)

data class DrivingEvent(
    val type: String,
    val ts: Long,
    val lat: Double?,
    val lon: Double?,
    val speedKmh: Double?,
    val value: Double?,
    val id: String = UUID.randomUUID().toString(),
)

/**
 * Turns raw GPS fixes, gyroscope and linear-acceleration readings into driving events.
 * Pure Kotlin on purpose: no Android types, so it can be unit-tested on the JVM.
 * Not thread-safe: feed it from a single thread.
 */
class DrivingDetector(private val thresholds: Thresholds = Thresholds()) {

    private data class Fix(val ts: Long, val lat: Double, val lon: Double, val speedMps: Double)

    private var lastFix: Fix? = null
    private var yawRateRadPerSec = 0.0
    private var overLimit = false
    private val lastEmittedAt = mutableMapOf<String, Long>()

    fun onGyro(zRadPerSec: Double) {
        yawRateRadPerSec = zRadPerSec
    }

    fun onLocation(ts: Long, lat: Double, lon: Double, speedMps: Double): List<DrivingEvent> {
        val out = mutableListOf<DrivingEvent>()
        val prev = lastFix
        lastFix = Fix(ts, lat, lon, speedMps)
        val kmh = speedMps * 3.6

        // Speeding is edge-triggered: one event per excursion above the limit.
        val above = kmh > thresholds.speedLimitKmh
        if (above && !overLimit) {
            emit(out, "speeding", ts, lat, lon, kmh, kmh - thresholds.speedLimitKmh)
        }
        overLimit = above

        if (prev != null && speedMps >= thresholds.minSpeedMps) {
            val dtSec = (ts - prev.ts) / 1000.0
            // Ignore gaps that are too short to measure or too long to trust.
            if (dtSec in 0.5..5.0) {
                val accel = (speedMps - prev.speedMps) / dtSec
                if (accel <= -thresholds.hardBrakeMps2) {
                    emit(out, "hard_brake", ts, lat, lon, kmh, abs(accel))
                } else if (accel >= thresholds.hardAccelMps2) {
                    emit(out, "hard_accel", ts, lat, lon, kmh, accel)
                }
            }
        }

        // Lateral acceleration = speed * yaw rate.
        val lateral = abs(speedMps * yawRateRadPerSec)
        if (speedMps >= thresholds.minSpeedMps && lateral >= thresholds.sharpTurnMps2) {
            emit(out, "sharp_turn", ts, lat, lon, kmh, lateral)
        }
        return out
    }

    fun onLinearAcceleration(ts: Long, magnitudeMps2: Double): List<DrivingEvent> {
        if (magnitudeMps2 < thresholds.crashMps2) return emptyList()
        val out = mutableListOf<DrivingEvent>()
        val fix = lastFix
        emit(
            out,
            "crash",
            ts,
            fix?.lat,
            fix?.lon,
            fix?.let { it.speedMps * 3.6 },
            magnitudeMps2,
        )
        return out
    }

    private fun emit(
        out: MutableList<DrivingEvent>,
        type: String,
        ts: Long,
        lat: Double?,
        lon: Double?,
        kmh: Double?,
        value: Double,
    ) {
        val last = lastEmittedAt[type]
        if (last != null && ts - last < thresholds.cooldownMs) return
        lastEmittedAt[type] = ts
        out.add(DrivingEvent(type, ts, lat, lon, kmh, value))
    }
}
