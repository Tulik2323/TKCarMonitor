package com.tkcarmonitor

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Sends queued events and positions to the server in the background.
 * One request at a time, so a slow network never piles up parallel uploads.
 */
class Uploader(private val config: Config, private val queue: EventQueue) {

    private enum class Result { SENT, RETRY_LATER, DROP }

    private val executor = Executors.newSingleThreadExecutor()

    fun flushAsync(status: JSONObject) {
        executor.execute { flush(status) }
    }

    private fun flush(status: JSONObject) {
        val all = queue.readAll()
        val events = all.filter { it.optString("kind") == "event" }.take(MAX_EVENTS_PER_REQUEST)
        val positions = all.filter { it.optString("kind") == "position" }.take(MAX_POSITIONS_PER_REQUEST)
        if (events.isEmpty() && positions.isEmpty()) {
            return
        }

        val body = JSONObject()
            .put("status", status)
            .put("events", JSONArray(events.map { stripQueueFields(it) }))
            .put("positions", JSONArray(positions.map { stripQueueFields(it) }))

        val uids = (events + positions).map { it.optString("uid") }.toSet()
        when (post(body)) {
            // Server accepted the batch, or it can never be accepted (bad data), so drop it.
            Result.SENT, Result.DROP -> queue.remove(uids)
            Result.RETRY_LATER -> Unit
        }
    }

    private fun stripQueueFields(item: JSONObject): JSONObject =
        JSONObject(item.toString()).apply {
            remove("kind")
            remove("uid")
        }

    private fun post(body: JSONObject): Result {
        val url = config.serverUrl
        val token = config.deviceToken
        if (url.isBlank() || token.isBlank()) return Result.RETRY_LATER

        return try {
            val conn = URL("$url/api/telemetry").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = TIMEOUT_MS
                conn.readTimeout = TIMEOUT_MS
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                when (conn.responseCode) {
                    in 200..299 -> Result.SENT
                    400 -> {
                        Log.w(TAG, "Server rejected batch as invalid, dropping it")
                        Result.DROP
                    }
                    else -> Result.RETRY_LATER
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: IOException) {
            Log.w(TAG, "Upload failed, will retry: ${e.message}")
            Result.RETRY_LATER
        }
    }

    private companion object {
        const val TAG = "TKCarUploader"
        const val TIMEOUT_MS = 15_000
        const val MAX_EVENTS_PER_REQUEST = 200
        const val MAX_POSITIONS_PER_REQUEST = 500
    }
}
