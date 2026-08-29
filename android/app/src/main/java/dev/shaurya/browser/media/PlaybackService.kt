package dev.shaurya.browser.media

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import androidx.media.session.MediaButtonReceiver
import dev.shaurya.browser.MainActivity
import dev.shaurya.browser.R

/**
 * Background playback (the mobile half of the desktop `MediaService`).
 *
 * On Android this is not a nicety, it is the only way playback survives at
 * all: the moment the app leaves the foreground the system is free to stop
 * it, and a WebView with no foreground service will be silenced within
 * seconds of the screen turning off.
 *
 * A foreground service is a promise to the user — it costs a permanent
 * notification and it is the reason the process is allowed to keep running —
 * so it starts only when something is actually playing and stops the instant
 * it is not. A browser that held a foreground service the whole time it was
 * open would be a battery complaint waiting to happen, and on Android 12+
 * would be killed for it.
 *
 * The `MediaSessionCompat` is what makes the lock-screen controls, the
 * notification transport, Bluetooth headset buttons and Android Auto all work
 * from one place. Implementing the notification without the session would
 * give a notification and nothing else.
 */
class PlaybackService : Service() {

    companion object {
        const val CHANNEL_ID = "shaurya.playback"
        const val NOTIFICATION_ID = 0x4145 // 'AE'

        const val ACTION_START = "dev.shaurya.browser.PLAYBACK_START"
        const val ACTION_STOP = "dev.shaurya.browser.PLAYBACK_STOP"
        const val ACTION_UPDATE = "dev.shaurya.browser.PLAYBACK_UPDATE"

        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"

        /**
         * Callbacks the activity installs so transport controls reach the
         * WebView that is actually playing.
         *
         * Held statically because a Service and an Activity have no direct
         * reference to each other, and binding a service purely to forward
         * four button presses is more lifecycle than the problem deserves.
         */
        @Volatile var onPlay: (() -> Unit)? = null
        @Volatile var onPause: (() -> Unit)? = null
        @Volatile var onNext: (() -> Unit)? = null
        @Volatile var onPrevious: (() -> Unit)? = null

        /** Start, update or stop the service from the activity. */
        fun update(context: Context, title: String, artist: String, playing: Boolean) {
            val intent = Intent(context, PlaybackService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_ARTIST, artist)
                putExtra(EXTRA_PLAYING, playing)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, PlaybackService::class.java).apply { action = ACTION_STOP }
            )
        }
    }

    private var session: MediaSessionCompat? = null
    private var title: String = ""
    private var artist: String = ""
    private var playing: Boolean = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()

        session = MediaSessionCompat(this, "ShauryaPlayback").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { Companion.onPlay?.invoke() }
                override fun onPause() { Companion.onPause?.invoke() }
                override fun onSkipToNext() { Companion.onNext?.invoke() }
                override fun onSkipToPrevious() { Companion.onPrevious?.invoke() }
                // A headset unplug should pause, not keep playing out loud —
                // the single most-complained-about behaviour a media app has.
                override fun onStop() { Companion.onPause?.invoke() }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopPlayback()
                return START_NOT_STICKY
            }
            else -> {
                title = intent?.getStringExtra(EXTRA_TITLE) ?: title
                artist = intent?.getStringExtra(EXTRA_ARTIST) ?: artist
                playing = intent?.getBooleanExtra(EXTRA_PLAYING, playing) ?: playing

                publish()
            }
        }
        // NOT_STICKY: if the system kills us under memory pressure, playback
        // has already stopped. Restarting the service without the WebView
        // that was playing would produce a notification controlling nothing.
        return START_NOT_STICKY
    }

    private fun publish() {
        session?.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .build()
        )

        session?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_STOP
                )
                .setState(
                    if (playing) PlaybackStateCompat.STATE_PLAYING
                    else PlaybackStateCompat.STATE_PAUSED,
                    // The browser does not know the true position — the page
                    // owns it — so the state is reported without one rather
                    // than with a fabricated seek bar.
                    PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    1f
                )
                .build()
        )

        startForeground(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE
        )

        val toggle = NotificationCompat.Action(
            if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            if (playing) "Pause" else "Play",
            MediaButtonReceiver.buildMediaButtonPendingIntent(
                this,
                if (playing) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY
            )
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title.ifBlank { "Playing in Shaurya" })
            .setContentText(artist)
            .setContentIntent(open)
            .addAction(toggle)
            .setStyle(
                MediaStyle()
                    .setMediaSession(session?.sessionToken)
                    .setShowActionsInCompactView(0)
            )
            // Not dismissible while playing, dismissible when paused: a stuck
            // notification for something that is not making noise is the
            // thing users uninstall media apps over.
            .setOngoing(playing)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setSilent(true)
            .build()
    }

    private fun stopPlayback() {
        session?.isActive = false
        session?.release()
        session = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Playback",
            // LOW: this notification is a control surface, not an alert. It
            // must never make a sound or vibrate — it exists because
            // something is *already* making sound.
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Controls for audio and video playing in Shaurya"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        session?.release()
        session = null
        super.onDestroy()
    }
}
