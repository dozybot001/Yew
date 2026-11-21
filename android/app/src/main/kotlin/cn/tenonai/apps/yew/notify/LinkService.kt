package cn.tenonai.apps.yew.notify

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.compose.runtime.snapshotFlow
import cn.tenonai.apps.yew.YewApp
import cn.tenonai.apps.yew.MainActivity
import cn.tenonai.apps.yew.R
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the app's connection to the relay while the app is not on screen, so the computer can tell
 * this phone when something needs the person (no push service is used).
 * Android requires a standing notification for it, which says whether the computer is reached.
 *
 * By default the connection lives only while Yew is open: closing Yew (swiping it away) ends it and
 * nothing starts it again but opening Yew. With "keep receiving after Yew is closed" on in Settings
 * it stays, and comes back after the phone starts, after an update, and after the system stopped it.
 */
class LinkService : Service() {
    private val scope = MainScope()

    /** False once the service is ending: nothing posts the standing notification after that. */
    private var alive = true

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val model = (application as YewApp).model
        val first = status(model.listening, model.desktopName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(Notifier.SERVICE, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(Notifier.SERVICE, first)
        }
        if (!model.wantsNotes) {
            end()
            stopSelf()
            return
        }
        model.listen(true)
        scope.launch {
            snapshotFlow { model.listening to model.desktopName }.collect { (listening, name) ->
                // Posted with notify(), this is an ordinary ongoing notification: once the service has
                // stopped being a foreground service nothing takes it down again. It stayed in the
                // shade saying it keeps trying after the app was closed (1.1.0). So not after end().
                if (alive) {
                    getSystemService(NotificationManager::class.java).notify(Notifier.SERVICE, status(listening, name))
                }
            }
        }
    }

    /** Stops updating the standing notification and takes it down. */
    private fun end() {
        alive = false
        scope.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(Notifier.SERVICE)
    }

    // Restarted by the system after it was stopped for memory only when the person chose to keep it.
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        if ((application as YewApp).model.notifier.keepAfterClose) START_STICKY else START_NOT_STICKY

    // Yew was closed (swiped away from recent apps).
    override fun onTaskRemoved(rootIntent: Intent?) {
        val model = (application as YewApp).model
        if (!model.notifier.keepAfterClose) {
            end()
            stopSelf()
            model.closed()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        end()
        (application as YewApp).model.listen(false)
        super.onDestroy()
    }

    private fun status(listening: Boolean, computer: String?): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, Notifier.LINK)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.service_title))
            .setContentText(getString(if (listening) R.string.service_online else R.string.service_waiting, computer.orEmpty()))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }
}

/**
 * After the phone starts, or the app is updated, the connection is kept again without opening the
 * app, when the person chose to keep it after Yew is closed. Otherwise nothing happens here.
 */
class StartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val model = (context.applicationContext as YewApp).model
            if (model.notifier.keepAfterClose) model.syncService()
        }
    }
}
