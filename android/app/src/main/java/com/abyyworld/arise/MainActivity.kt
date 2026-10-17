package com.abyyworld.arise

import android.os.Bundle
import com.abyyworld.arise.life.LifePlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Arise's own plugin (Settings, Your life, Android): registered before Capacitor starts.
        registerPlugin(LifePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
