package ir.nivora.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSessionStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("secure_session", Context.MODE_PRIVATE)
    private val alias = "nivora_session_key_v1"

    fun token(): String? {
        migrateLegacyToken()
        val encoded = preferences.getString("token", null) ?: return null
        return runCatching {
            val payload = Base64.decode(encoded, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.copyOfRange(0, 12)))
            String(cipher.doFinal(payload.copyOfRange(12, payload.size)), Charsets.UTF_8)
        }.getOrElse {
            clear()
            null
        }
    }

    fun save(token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val payload = cipher.iv + encrypted
        preferences.edit().putString("token", Base64.encodeToString(payload, Base64.NO_WRAP)).apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
        context.getSharedPreferences("session", Context.MODE_PRIVATE).edit().clear().apply()
    }

    private fun migrateLegacyToken() {
        if (preferences.contains("token")) return
        val legacy = context.getSharedPreferences("session", Context.MODE_PRIVATE)
        val token = legacy.getString("token", null) ?: return
        save(token)
        legacy.edit().clear().apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
