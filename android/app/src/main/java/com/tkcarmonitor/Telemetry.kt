package com.tkcarmonitor

import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Converts a detected event into the JSON item that waits in the upload queue. */
fun DrivingEvent.toQueueItem(): JSONObject = JSONObject()
    .put("kind", "event")
    .put("uid", id)
    .put("id", id)
    .put("type", type)
    .put("ts", ts)
    .put("lat", lat ?: JSONObject.NULL)
    .put("lon", lon ?: JSONObject.NULL)
    .put("speedKmh", speedKmh ?: JSONObject.NULL)
    .put("value", value ?: JSONObject.NULL)

fun positionQueueItem(ts: Long, lat: Double, lon: Double, speedKmh: Double): JSONObject = JSONObject()
    .put("kind", "position")
    .put("uid", UUID.randomUUID().toString())
    .put("ts", ts)
    .put("lat", lat)
    .put("lon", lon)
    .put("speedKmh", speedKmh)

/**
 * Append-only JSON-lines file that survives app restarts and network outages.
 * Items are removed only after the server has accepted them.
 */
class EventQueue(private val file: File) {

    private val lock = Any()

    fun add(item: JSONObject) = synchronized(lock) {
        file.appendText(item.toString() + "\n")
    }

    fun readAll(): List<JSONObject> = synchronized(lock) {
        if (!file.exists()) {
            emptyList()
        } else {
            file.readLines()
                .filter { it.isNotBlank() }
                .mapNotNull { line -> runCatching { JSONObject(line) }.getOrNull() }
        }
    }

    fun remove(uids: Set<String>) {
        if (uids.isEmpty()) return
        synchronized(lock) {
            val rest = readAll().filter { it.optString("uid") !in uids }
            file.writeText(rest.joinToString("") { it.toString() + "\n" })
        }
    }
}
