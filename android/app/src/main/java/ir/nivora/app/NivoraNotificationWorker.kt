package ir.nivora.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.os.Build
import android.provider.Settings
import androidx.work.Worker
import androidx.work.WorkerParameters
import ir.nivora.app.data.ApiClient
import ir.nivora.app.data.CustomerNotification
import ir.nivora.app.data.SecureSessionStore

class NivoraNotificationWorker(context:Context,params:WorkerParameters):Worker(context,params){
    override fun doWork():Result{
        val session=SecureSessionStore(applicationContext);val token=session.token()?:return Result.success()
        return runCatching{
            val api=ApiClient(BuildConfig.API_BASE_URL)
            val items=if(session.role()=="reseller")api.resellerAccount(token).notifications else api.account(token).notifications
            publish(items);Result.success()
        }.getOrElse{Result.retry()}
    }
    private fun publish(items:List<CustomerNotification>){
        val prefs=applicationContext.getSharedPreferences("alerts",Context.MODE_PRIVATE)
        val seen=prefs.getStringSet("seen_ids",emptySet())?.toMutableSet()?:mutableSetOf()
        val initialized=prefs.getBoolean("initialized",false)
        val fresh=items.filter{it.readAt==null && !seen.contains(it.id)}
        items.forEach{seen.add(it.id)};prefs.edit().putStringSet("seen_ids",seen.toList().takeLast(150).toSet()).putBoolean("initialized",true).apply();if(!initialized||fresh.isEmpty())return
        val manager=applicationContext.getSystemService(NotificationManager::class.java);val channel="nivora_alerts_v3";val sound=Settings.System.DEFAULT_NOTIFICATION_URI
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(channel,"اعلان‌های نیورا",NotificationManager.IMPORTANCE_HIGH).apply{enableVibration(true);vibrationPattern=longArrayOf(0,220,120,220);setSound(sound,AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())})
        val open=PendingIntent.getActivity(applicationContext,0,Intent(applicationContext,MainActivity::class.java),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fresh.take(3).forEach{n->manager.notify(n.id.hashCode(),Notification.Builder(applicationContext,channel).setSmallIcon(R.drawable.ic_nivora_notification).setContentTitle(n.title).setContentText(n.body).setContentIntent(open).setAutoCancel(true).build())}
    }
}
