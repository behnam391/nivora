package ir.nivora.bankagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class BankEvent(val eventId:String,val sender:String,val message:String,val receivedAt:String)

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action!=Telephony.Sms.Intents.SMS_RECEIVED_ACTION||!AgentStore.enabled(context))return
        val messages=Telephony.Sms.Intents.getMessagesFromIntent(intent);if(messages.isEmpty())return
        val sender=messages.first().originatingAddress.orEmpty()
        if(!AgentStore.senderAllowed(context,sender)){Log.i(TAG,"Ignored SMS sender=${sender.take(32)}");return}
        val event=BankEvent(UUID.randomUUID().toString(),sender,messages.joinToString(""){it.messageBody.orEmpty()},Instant.ofEpochMilli(messages.first().timestampMillis).toString())
        AgentSender.enqueue(context,event)
        val pending=goAsync()
        Thread({try{AgentSender.flush(context)}finally{pending.finish()}},"nivora-bank-send").start()
    }
    companion object { const val TAG="NivoraBankAgent" }
}

object AgentSender {
    fun enqueue(c:Context,e:BankEvent){val a=queue(c);a.put(JSONObject().put("eventId",e.eventId).put("sender",e.sender).put("message",e.message).put("receivedAt",e.receivedAt));save(c,a)}
    fun test(c:Context):Boolean=send(c,BankEvent("test-${UUID.randomUUID()}","Day Bank","NIVORA BANK AGENT TEST",Instant.now().toString()))
    fun flush(c:Context):Boolean {val a=queue(c);val remain=org.json.JSONArray();var all=true;for(i in 0 until a.length()){val o=a.optJSONObject(i)?:continue;val ok=send(c,BankEvent(o.optString("eventId"),o.optString("sender"),o.optString("message"),o.optString("receivedAt")));if(!ok){remain.put(o);all=false}};save(c,remain);return all}
    private fun queue(c:Context)=runCatching{org.json.JSONArray(AgentStore.pending(c))}.getOrElse{org.json.JSONArray()}
    private fun save(c:Context,a:org.json.JSONArray)=AgentStore.savePending(c,a.toString())
    private fun send(c:Context,e:BankEvent):Boolean {
      return try{
        val url=AgentStore.endpoint(c);val id=AgentStore.agentId(c);val secret=AgentStore.secret(c);if(url.isBlank()||id.isBlank()||secret.isBlank())return false
        val timestamp=System.currentTimeMillis().toString();val nonce=UUID.randomUUID().toString().replace("-","");val digest=MessageDigest.getInstance("SHA-256").digest(e.message.toByteArray()).joinToString(""){"%02x".format(it)};val signing=listOf(id,timestamp,nonce,e.eventId,e.sender,e.receivedAt,digest).joinToString("\n");val mac=Mac.getInstance("HmacSHA256").apply{init(SecretKeySpec(secret.toByteArray(),"HmacSHA256"))}.doFinal(signing.toByteArray()).joinToString(""){"%02x".format(it)}
        val body=JSONObject().put("eventId",e.eventId).put("sender",e.sender).put("message",e.message).put("receivedAt",e.receivedAt).toString()
        val urls=linkedSetOf(url.replace("https://b.nivorali.com","https://api.nivorali.com"),url,url.replace("https://b.nivorali.com","https://nivorali.com"),url.replace("https://b.nivorali.com","https://www.nivorali.com"))
        for(candidate in urls){try{val conn=(URL(candidate).openConnection() as HttpURLConnection).apply{requestMethod="POST";connectTimeout=5_000;readTimeout=5_000;doOutput=true;setRequestProperty("Content-Type","application/json");setRequestProperty("X-Nivora-Agent-Id",id);setRequestProperty("X-Nivora-Timestamp",timestamp);setRequestProperty("X-Nivora-Nonce",nonce);setRequestProperty("X-Nivora-Signature",mac)};conn.outputStream.use{it.write(body.toByteArray())};val code=conn.responseCode;conn.disconnect();Log.i(SmsReceiver.TAG,"Delivery ${URL(candidate).host} HTTP $code");if(code in 200..299)return true}catch(ex:Exception){Log.w(SmsReceiver.TAG,"Route failed ${URL(candidate).host}: ${ex.javaClass.simpleName}")}}
        false
      }catch(e:Exception){Log.e(SmsReceiver.TAG,"Delivery failed",e);false}
    }
}
