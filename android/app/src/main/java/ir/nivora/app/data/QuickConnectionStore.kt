package ir.nivora.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class QuickConnection(val url:String,val subscriptionId:String,val label:String)

class QuickConnectionStore(context:Context) {
    private val preferences=context.getSharedPreferences("quick_connection",Context.MODE_PRIVATE)
    private val alias="nivora_quick_connection_v1"
    fun save(value:QuickConnection){val raw=JSONObject().put("url",value.url).put("subscriptionId",value.subscriptionId).put("label",value.label).toString();val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,key())};preferences.edit().putString("value",Base64.encodeToString(cipher.iv+cipher.doFinal(raw.toByteArray()),Base64.NO_WRAP)).apply()}
    fun read():QuickConnection?=runCatching{val payload=Base64.decode(preferences.getString("value",null)?:return null,Base64.NO_WRAP);val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,payload.copyOfRange(0,12)))};val json=JSONObject(String(cipher.doFinal(payload.copyOfRange(12,payload.size))));QuickConnection(json.getString("url"),json.getString("subscriptionId"),json.optString("label","Nivora"))}.getOrNull()
    fun clear()=preferences.edit().clear().apply()
    private fun key():SecretKey{val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};(store.getKey(alias,null) as? SecretKey)?.let{return it};return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").run{init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generateKey()}}
}
