package com.tkcarmonitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DrivingDetectorTest {

    private fun DrivingDetector.types(events: List<DrivingEvent>) = events.map { it.type }

    @Test
    fun hardBrakeIsDetectedFromSpeedDrop() {
        val d = DrivingDetector()
        assertTrue(d.onLocation(0, 32.0, 34.0, 20.0).isEmpty())
        // 20 m/s -> 15 m/s in one second is 5 m/s², above the 0.4g threshold.
        val events = d.onLocation(1_000, 32.0, 34.0, 15.0)
        assertEquals(listOf("hard_brake"), d.types(events))
        assertEquals(5.0, events[0].value!!, 0.001)
    }

    @Test
    fun gentleSlowdownIsNotHardBraking() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 20.0)
        assertTrue(d.onLocation(1_000, 32.0, 34.0, 19.0).isEmpty())
    }

    @Test
    fun speedingFiresOncePerExcursion() {
        val d = DrivingDetector()
        // 31 m/s is about 111.6 km/h, above the 110 km/h default.
        val first = d.onLocation(0, 32.0, 34.0, 31.0)
        assertEquals(listOf("speeding"), d.types(first).filter { it == "speeding" })
        // Still above the limit: no new event.
        assertTrue(d.onLocation(1_000, 32.0, 34.0, 31.0).none { it.type == "speeding" })
        // Back under the limit, then above again: a second event.
        d.onLocation(2_000, 32.0, 34.0, 20.0)
        val again = d.onLocation(20_000, 32.0, 34.0, 31.0)
        assertTrue(again.any { it.type == "speeding" })
    }

    @Test
    fun crashRequiresLinearAccelerationAboveFourG() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0)
        assertTrue(d.onLinearAcceleration(500, 3.0 * GRAVITY).isEmpty())
        val events = d.onLinearAcceleration(1_000, 4.5 * GRAVITY)
        assertEquals(listOf("crash"), d.types(events))
        assertEquals(54.0, events[0].speedKmh!!, 0.001)
    }

    @Test
    fun phoneBumpWhileParkedIsNotACrash() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 0.0)
        assertTrue(d.onLinearAcceleration(1_000, 6.0 * GRAVITY).isEmpty())
    }

    @Test
    fun crashIsIgnoredWhenTheSpeedFixIsStale() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0)
        assertTrue(d.onLinearAcceleration(10_000, 6.0 * GRAVITY).isEmpty())
    }

    @Test
    fun crashWithoutAnyFixIsIgnored() {
        val d = DrivingDetector()
        assertTrue(d.onLinearAcceleration(0, 6.0 * GRAVITY).isEmpty())
    }

    @Test
    fun sharpTurnUsesGpsHeadingChange() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0, bearingDeg = 0.0)
        // 20 degrees in one second at 15 m/s is about 5.2 m/s², above 0.35g.
        val events = d.onLocation(1_000, 32.0, 34.0, 15.0, bearingDeg = 20.0)
        assertEquals(listOf("sharp_turn"), d.types(events))
    }

    @Test
    fun drivingStraightIsNotASharpTurn() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0, bearingDeg = 90.0)
        assertTrue(d.onLocation(1_000, 32.0, 34.0, 15.0, bearingDeg = 92.0).none { it.type == "sharp_turn" })
    }

    @Test
    fun headingWrapsAroundNorth() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0, bearingDeg = 350.0)
        // 350 -> 10 is a 20 degree turn, not a 340 degree one.
        val events = d.onLocation(1_000, 32.0, 34.0, 15.0, bearingDeg = 10.0)
        assertEquals(listOf("sharp_turn"), d.types(events))
    }

    @Test
    fun turnWithoutBearingIsIgnored() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0)
        assertTrue(d.onLocation(1_000, 32.0, 34.0, 15.0).none { it.type == "sharp_turn" })
    }

    @Test
    fun repeatedSignalsInsideCooldownAreMerged() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 15.0)
        assertEquals(1, d.onLinearAcceleration(0, 50.0).size)
        d.onLocation(5_000, 32.0, 34.0, 15.0)
        assertTrue(d.onLinearAcceleration(5_000, 50.0).isEmpty())
        d.onLocation(20_000, 32.0, 34.0, 15.0)
        assertEquals(1, d.onLinearAcceleration(20_000, 50.0).size)
    }

    @Test
    fun gpsGapsTooLongToMeasureAreIgnored() {
        val d = DrivingDetector()
        d.onLocation(0, 32.0, 34.0, 25.0)
        // 60 seconds later a 20 m/s drop is not trusted as braking.
        assertTrue(d.onLocation(60_000, 32.0, 34.0, 5.0).none { it.type == "hard_brake" })
    }
}
