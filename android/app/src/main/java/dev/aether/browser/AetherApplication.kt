package dev.aether.browser

import android.app.Application
import android.os.Build
import android.webkit.WebView

/**
 * Application entry point.
 *
 * The one thing that must happen before any WebView exists: giving each
 * process its own WebView data directory. Without it, a second process
 * touching WebView throws and takes the app down.
 */
class AetherApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val process = getProcessName()
            if (process != packageName) {
                WebView.setDataDirectorySuffix(process.substringAfterLast(':'))
            }
        }
    }
}
