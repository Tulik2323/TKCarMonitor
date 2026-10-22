package com.tkcarmonitor

import android.content.Context

/** Settings typed into the main screen, plus whether the user wants monitoring running. */
class Config(context: Context) {

    private val prefs = context.getSharedPreferences("tkcarmonitor", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_URL, value.trim().trimEnd('/')).apply()

    var deviceToken: String
        get() = prefs.getString(KEY_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_TOKEN, value.trim()).apply()

    var speedLimitKmh: Float
        get() = prefs.getFloat(KEY_SPEED_LIMIT, DEFAULT_SPEED_LIMIT)
        set(value) = prefs.edit().putFloat(KEY_SPEED_LIMIT, value).apply()

    var monitoring: Boolean
        get() = prefs.getBoolean(KEY_MONITORING, false)
        set(value) = prefs.edit().putBoolean(KEY_MONITORING, value).apply()

    companion object {
        const val DEFAULT_SPEED_LIMIT = 110f
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_SPEED_LIMIT = "speed_limit"
        private const val KEY_MONITORING = "monitoring"
    }
}
