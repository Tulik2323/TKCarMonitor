package com.tkcarmonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Restarts monitoring after the phone reboots, if the user left it on.
 * Android 12+ can refuse to start a location foreground service from the background;
 * in that case the service simply does not start, and the app must be opened once.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Config(context).monitoring) return
        try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, MonitorService::class.java).setAction(MonitorService.ACTION_START),
            )
        } catch (e: RuntimeException) {
            Log.w("TKCarBoot", "Could not start monitoring after boot: ${e.message}")
        }
    }
}
