package ir.nivora.app.data

import android.content.Context
import java.security.MessageDigest
import java.util.UUID

internal class PurchaseRequestStore(context: Context?) {
    private val prefs = context?.applicationContext?.getSharedPreferences("purchase_requests", Context.MODE_PRIVATE)
    companion object { private val pending = mutableMapOf<String,String>() }
    fun identity(path: String, method: String, token: String?, body: String): String? {
        if (method != "POST" || !(Regex("^/api/(customer|reseller)/((?:wallet/)?purchase|orders/[^/]+/renew)$").matches(path))) return null
        return MessageDigest.getInstance("SHA-256").digest("$token\n$path\n$body".toByteArray()).joinToString("") { "%02x".format(it) }
    }
    fun key(identity: String): String = synchronized(pending) {
        pending[identity] ?: prefs?.getString(identity,null) ?: UUID.randomUUID().toString().also {
            // Commit before sending money-changing requests, including process death.
            if(prefs != null && !prefs.edit().putString(identity,it).commit()) throw IllegalStateException("PURCHASE_STORAGE_UNAVAILABLE")
            pending[identity]=it
        }
    }
    fun complete(identity: String) = synchronized(pending) {
        pending.remove(identity);prefs?.edit()?.remove(identity)?.commit();Unit
    }
}
