package com.tkcarmonitor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/** Setup screen: server address, device token, speed limit, and start/stop. */
class MainActivity : AppCompatActivity() {

    private lateinit var config: Config
    private lateinit var serverUrl: EditText
    private lateinit var deviceToken: EditText
    private lateinit var speedLimit: EditText
    private lateinit var status: TextView

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
                startMonitoring()
            } else {
                status.text = "צריך הרשאת מיקום כדי להפעיל את הניטור"
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        config = Config(this)
        setContentView(buildLayout())
        loadFields()
        refreshStatus()
    }

    private fun buildLayout(): LinearLayout {
        serverUrl = EditText(this).apply {
            hint = "כתובת השרת (https://...)"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        deviceToken = EditText(this).apply {
            hint = "סיסמת המכשיר"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        speedLimit = EditText(this).apply {
            hint = "מהירות מותרת (קמ\"ש)"
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
        }
        status = TextView(this).apply { textSize = 16f }

        val startButton = Button(this).apply {
            text = "שמור והפעל ניטור"
            setOnClickListener { onStartClicked() }
        }
        val stopButton = Button(this).apply {
            text = "עצור ניטור"
            setOnClickListener {
                startService(Intent(this@MainActivity, MonitorService::class.java).setAction(MonitorService.ACTION_STOP))
                config.monitoring = false
                refreshStatus()
            }
        }

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            layoutDirection = LinearLayout.LAYOUT_DIRECTION_RTL
            addView(TextView(context).apply { text = "ניטור נהיגה"; textSize = 22f })
            addView(serverUrl, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(deviceToken, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(speedLimit, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(startButton, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(stopButton, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(status, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
    }

    private fun loadFields() {
        serverUrl.setText(config.serverUrl)
        deviceToken.setText(config.deviceToken)
        speedLimit.setText(config.speedLimitKmh.toString())
    }

    private fun onStartClicked() {
        val url = serverUrl.text.toString().trim()
        val token = deviceToken.text.toString().trim()
        val limit = speedLimit.text.toString().toFloatOrNull()
        when {
            !url.startsWith("https://") -> status.text = "כתובת השרת חייבת להתחיל ב-https://"
            token.isEmpty() -> status.text = "צריך להזין את סיסמת המכשיר"
            limit == null || limit <= 0f -> status.text = "מהירות מותרת לא תקינה"
            else -> {
                config.serverUrl = url
                config.deviceToken = token
                config.speedLimitKmh = limit
                requestNeededPermissions()
            }
        }
    }

    private fun requestNeededPermissions() {
        val needed = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val missing = needed.any {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing) {
            requestPermissions.launch(needed.toTypedArray())
        } else {
            startMonitoring()
        }
    }

    private fun startMonitoring() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, MonitorService::class.java).setAction(MonitorService.ACTION_START),
        )
        config.monitoring = true
        refreshStatus()
    }

    private fun refreshStatus() {
        status.text = if (config.monitoring) {
            "הניטור פעיל. מומלץ לבטל אופטימיזציית סוללה לאפליקציה כדי שלא תיעצר."
        } else {
            "הניטור כבוי"
        }
    }
}
