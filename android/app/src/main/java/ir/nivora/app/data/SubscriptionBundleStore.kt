package ir.nivora.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the last verified subscription bundle on the device so pressing the
 * connect button never depends on a live panel/subscription round-trip.
 * Upstream expiry and traffic limits are still enforced by Xray servers.
 */
class SubscriptionBundleStore(context: Context) {
    private val preferences = context.getSharedPreferences("subscription_bundles_v2", Context.MODE_PRIVATE)
    private val alias = "nivora_subscription_bundle_key_v2"

    fun read(url: String): String? {
        val encoded = preferences.getString(keyFor(url), null) ?: return null
        return runCatching {
            val payload = Base64.decode(encoded, Base64.NO_WRAP)
            require(payload.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.copyOfRange(0, 12)))
            SubscriptionBundleFormat.normalize(String(cipher.doFinal(payload.copyOfRange(12, payload.size)), Charsets.UTF_8))
        }.getOrNull()
    }

    fun save(url: String, raw: String) {
        val normalized=SubscriptionBundleFormat.normalize(raw)?:return
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(normalized.toByteArray(Charsets.UTF_8))
        preferences.edit()
            .putString(keyFor(url), Base64.encodeToString(payload, Base64.NO_WRAP))
            .putLong("${keyFor(url)}_updated", System.currentTimeMillis())
            .apply()
    }

    fun clear() = preferences.edit().clear().apply()

    private fun keyFor(url: String): String = MessageDigest.getInstance("SHA-256")
        .digest(url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            generateKey()
        }
    }

    private companion object { const val MAX_BUNDLE_CHARS = 2_000_000 }
}
