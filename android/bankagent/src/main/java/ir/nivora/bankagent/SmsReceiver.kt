package ir.nivora.bankagent

import android.app.job.*
import android.content.*
import android.os.PersistableBundle
import android.provider.Telephony
import org.json.JSONObject
import java.util.UUID

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action!=Telephony.Sms.Intents.SMS_RECEIVED_ACTION||!AgentStore.enabled(context))return
        val messages=Telephony.Sms.Intents.getMessagesFromIntent(intent);if(messages.isEmpty())return
        val sender=messages.first().originatingAddress.orEmpty();if(sender.lowercase() !in AgentStore.senders(context))return
        val extras=PersistableBundle().apply{putString("eventId",UUID.randomUUID().toString());putString("sender",sender);putString("message",messages.joinToString(""){it.messageBody.orEmpty()});putString("receivedAt",java.time.Instant.ofEpochMilli(messages.first().timestampMillis).toString())}
        val job=JobInfo.Builder((System.currentTimeMillis()%Int.MAX_VALUE).toInt(),ComponentName(context,SendJobService::class.java)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(15_000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).setExtras(extras).build()
        context.getSystemService(JobScheduler::class.java).schedule(job)
    }
}

class SendJobService : JobService() {
    override fun onStartJob(params:JobParameters):Boolean{Thread{jobFinished(params,!send(params.extras))}.start();return true}
    override fun onStopJob(params:JobParameters)=true
    private fun send(data:PersistableBundle):Boolean {
        return try {
            val url=AgentStore.endpoint(this);val id=AgentStore.agentId(this);val secret=AgentStore.secret(this);if(url.isBlank()||id.isBlank()||secret.isBlank())return true
            val eventId=data.getString("eventId")!!;val sender=data.getString("sender")!!;val message=data.getString("message")!!;val receivedAt=data.getString("receivedAt")!!;val timestamp=System.currentTimeMillis().toString();val nonce=UUID.randomUUID().toString().replace("-","")
            val digest=java.security.MessageDigest.getInstance("SHA-256").digest(message.toByteArray()).joinToString(""){"%02x".format(it)};val signing=listOf(id,timestamp,nonce,eventId,sender,receivedAt,digest).joinToString("\n");val mac=javax.crypto.Mac.getInstance("HmacSHA256").apply{init(javax.crypto.spec.SecretKeySpec(secret.toByteArray(),"HmacSHA256"))}.doFinal(signing.toByteArray()).joinToString(""){"%02x".format(it)}
            val body=JSONObject().put("eventId",eventId).put("sender",sender).put("message",message).put("receivedAt",receivedAt).toString();val c=(java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply{requestMethod="POST";connectTimeout=10_000;readTimeout=15_000;doOutput=true;setRequestProperty("Content-Type","application/json");setRequestProperty("X-Nivora-Agent-Id",id);setRequestProperty("X-Nivora-Timestamp",timestamp);setRequestProperty("X-Nivora-Nonce",nonce);setRequestProperty("X-Nivora-Signature",mac)}
            c.outputStream.use{it.write(body.toByteArray())};val ok=c.responseCode in 200..299;c.disconnect();ok
        } catch(_:Exception){false}
    }
}
