package com.tkcarmonitor

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import kotlin.math.sqrt

/**
 * Foreground service that runs in the car. Reads GPS and motion sensors,
 * feeds them to [DrivingDetector], and uploads results via [Uploader].
 */
class MonitorService : Service(), SensorEventListener {

    private lateinit var config: Config
    private lateinit var queue: EventQueue
    private lateinit var uploader: Uploader
    private lateinit var detector: DrivingDetector
    private lateinit var sensors: SensorManager
    private lateinit var locations: LocationManager

    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var lastFixAt: Long? = null
    private var lastPositionAt = 0L

    private val flushTask = object : Runnable {
        override fun run() {
            uploader.flushAsync(statusJson())
            handler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    private val locationListener = LocationListener { location -> onLocation(location) }

    override fun onCreate() {
        super.onCreate()
        config = Config(this)
        queue = EventQueue(File(filesDir, "queue.jsonl"))
        uploader = Uploader(config, queue)
        detector = DrivingDetector(Thresholds(speedLimitKmh = config.speedLimitKmh.toDouble()))
        sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        locations = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            config.monitoring = false
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(
            NOTIFICATION_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
        )

        if (!hasLocationPermission()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            startListening()
            handler.post(flushTask)
            running = true
        }
        config.monitoring = true
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(flushTask)
        if (running) {
            locations.removeUpdates(locationListener)
            sensors.unregisterListener(this)
            running = false
        }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun hasLocationPermission(): Boolean =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @Suppress("MissingPermission") // Checked in onStartCommand before this is called.
    private fun startListening() {
        locations.requestLocationUpdates(
            LocationManager.GPS_PROVIDER,
            LOCATION_INTERVAL_MS,
            0f,
            locationListener,
            Looper.getMainLooper(),
        )
        sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)?.let {
            sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
            sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    private fun onLocation(location: Location) {
        lastFixAt = location.time
        val speedMps = if (location.hasSpeed()) location.speed.toDouble() else 0.0
        val kmh = speedMps * 3.6

        if (location.time - lastPositionAt >= POSITION_INTERVAL_MS) {
            lastPositionAt = location.time
            queue.add(positionQueueItem(location.time, location.latitude, location.longitude, kmh))
        }
        detector.onLocation(location.time, location.latitude, location.longitude, speedMps)
            .forEach { queue.add(it.toQueueItem()) }
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> detector.onGyro(event.values[2].toDouble())
            Sensor.TYPE_LINEAR_ACCELERATION -> {
                val v = event.values
                val magnitude = sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble())
                detector.onLinearAcceleration(System.currentTimeMillis(), magnitude)
                    .forEach { queue.add(it.toQueueItem()) }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun statusJson(): JSONObject {
        val battery = (getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return JSONObject()
            .put("battery", if (battery in 0..100) battery else JSONObject.NULL)
            .put("lastFixAt", lastFixAt ?: JSONObject.NULL)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "ניטור נהיגה", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ניטור נהיגה פעיל")
            .setContentText("הנסיעה מנוטרת ונשלחת לדשבורד")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .build()

    companion object {
        const val ACTION_START = "com.tkcarmonitor.START"
        const val ACTION_STOP = "com.tkcarmonitor.STOP"
        private const val CHANNEL_ID = "monitor"
        private const val NOTIFICATION_ID = 1
        private const val LOCATION_INTERVAL_MS = 1_000L
        private const val POSITION_INTERVAL_MS = 30_000L
        private const val FLUSH_INTERVAL_MS = 10_000L
    }
}
