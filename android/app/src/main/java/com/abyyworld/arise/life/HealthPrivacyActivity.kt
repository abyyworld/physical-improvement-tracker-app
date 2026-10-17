package com.abyyworld.arise.life

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

// Health Connect opens this when the Player asks why Arise wants their health data: it shows
// Arise's privacy policy in the browser.
class HealthPrivacyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL)))
        } catch (_: Exception) {
            // No browser: nothing to show.
        }
        finish()
    }

    companion object {
        const val PRIVACY_URL = "https://abyyworld.github.io/physical-improvement-tracker-app/privacy.html"
    }
}
