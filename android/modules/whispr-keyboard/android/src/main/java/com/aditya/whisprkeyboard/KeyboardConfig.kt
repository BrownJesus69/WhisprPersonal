package com.aditya.whisprkeyboard

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class KeyboardConfig(context: Context) {
    private val prefs = context.getSharedPreferences("whispr_keyboard", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("whispr_keyboard", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("whispr_keyboard", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(values: Map<String, Any?>) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal((values["serverKey"] as? String ?: "").toByteArray(Charsets.UTF_8))
        val edit = prefs.edit().clear()
        edit.putString("key", Base64.encodeToString(encrypted, Base64.NO_WRAP))
        edit.putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
        for (name in listOf("serverUrl", "languageMode", "speakEventId")) edit.putString(name, values[name] as? String ?: "")
        edit.putBoolean("reviewBeforeInsert", values["reviewBeforeInsert"] == true)
        edit.putBoolean("haptics", values["haptics"] != false)
        check(edit.commit()) { "Keyboard configuration could not be saved" }
    }
    fun secret(): String = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)))
        }
        String(cipher.doFinal(Base64.decode(prefs.getString("key", ""), Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (_: Exception) { "" }
    fun string(name: String, default: String = "") = prefs.getString(name, default) ?: default
    fun bool(name: String, default: Boolean = false) = prefs.getBoolean(name, default)
    fun clear() { check(prefs.edit().clear().commit()) { "Keyboard configuration could not be cleared" } }
}
