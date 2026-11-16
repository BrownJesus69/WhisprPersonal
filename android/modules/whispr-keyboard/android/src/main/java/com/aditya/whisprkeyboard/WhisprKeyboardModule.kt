package com.aditya.whisprkeyboard

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WhisprKeyboardModule : Module() {
    private fun context() = requireNotNull(appContext.reactContext)
    private fun service() = ComponentName(context(), WhisprKeyboardService::class.java)
    private fun matches(value: String) = ComponentName.unflattenFromString(value) == service()
    override fun definition() = ModuleDefinition {
        Name("WhisprKeyboard")
        AsyncFunction("setConfig") { config: Map<String, Any?> -> KeyboardConfig(context()).save(config) }
        AsyncFunction("clearConfig") { KeyboardConfig(context()).clear() }
        AsyncFunction("isEnabled") {
            (Settings.Secure.getString(context().contentResolver, Settings.Secure.ENABLED_INPUT_METHODS) ?: "")
                .split(':').any { matches(it) }
        }
        AsyncFunction("isSelected") {
            matches(Settings.Secure.getString(context().contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) ?: "")
        }
        AsyncFunction("openInputMethodSettings") {
            context().startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        AsyncFunction("showPicker") {
            (context().getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
        }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    }
}
