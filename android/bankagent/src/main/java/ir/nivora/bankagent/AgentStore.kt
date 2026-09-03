package ir.nivora.bankagent

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object AgentStore {
    private const val ALIAS="nivora-bank-agent-key"
    private fun prefs(c:Context)=c.getSharedPreferences("agent",Context.MODE_PRIVATE)
    fun endpoint(c:Context)=prefs(c).getString("url","")!!
    fun agentId(c:Context)=prefs(c).getString("id","")!!
    fun senders(c:Context)=prefs(c).getString("senders","")!!.lines().map{it.trim().lowercase()}.filter{it.isNotEmpty()}.toSet()
    private fun normalized(v:String)=v.lowercase().replace(Regex("[^a-z0-9\\u0600-\\u06ff]"),"")
    fun senderAllowed(c:Context,sender:String):Boolean {val actual=normalized(sender);return senders(c).any{val allowed=normalized(it);allowed.isNotBlank()&&(actual==allowed||actual.contains(allowed)||allowed.contains(actual))}}
    fun enabled(c:Context)=prefs(c).getBoolean("enabled",false)
    fun pending(c:Context)=prefs(c).getString("pending_events","[]")!!
    fun savePending(c:Context,value:String)=prefs(c).edit().putString("pending_events",value).commit()
    fun save(c:Context,url:String,id:String,secret:String,senders:String,enabled:Boolean){val e=prefs(c).edit().putString("url",url.trim().trimEnd('/')).putString("id",id.trim()).putString("senders",senders).putBoolean("enabled",enabled);if(secret.isNotBlank())e.putString("secret",encrypt(secret));e.apply()}
    fun secret(c:Context):String=runCatching{decrypt(prefs(c).getString("secret","")!!)}.getOrDefault("")
    private fun key():SecretKey {val ks=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};return (ks.getKey(ALIAS,null) as? SecretKey)?:KeyGenerator.getInstance("AES","AndroidKeyStore").run{init(android.security.keystore.KeyGenParameterSpec.Builder(ALIAS,android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build());generateKey()}}
    private fun encrypt(value:String):String {val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());return Base64.encodeToString(cipher.iv+cipher.doFinal(value.toByteArray()),Base64.NO_WRAP)}
    private fun decrypt(value:String):String {if(value.isBlank())return "";val all=Base64.decode(value,Base64.NO_WRAP);val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,all.copyOfRange(0,12)));return String(cipher.doFinal(all.copyOfRange(12,all.size)))}
}
