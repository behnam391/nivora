package ir.nivora.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat

object NetworkSettingsAdvisor {
    private const val CHANNEL="nivora_network_health_v1"
    fun inspect(context:Context){
        val resolver=context.contentResolver
        val privateMode=runCatching{Settings.Global.getString(resolver,"private_dns_mode")}.getOrNull().orEmpty()
        val privateHost=runCatching{Settings.Global.getString(resolver,"private_dns_specifier")}.getOrNull().orEmpty()
        val telephony=context.getSystemService(TelephonyManager::class.java)
        val carrier=runCatching{telephony.networkOperatorName}.getOrNull().orEmpty().ifBlank{runCatching{telephony.simOperatorName}.getOrNull().orEmpty()}
        val suggestedApn=when{
            carrier.contains("MCI",true)||carrier.contains("همراه",true)->"mcinet"
            carrier.contains("MTN",true)||carrier.contains("Irancell",true)||carrier.contains("ایرانسل",true)->"mtnirancell"
            carrier.contains("Rightel",true)||carrier.contains("رایتل",true)->"rightel"
            carrier.contains("Shatel",true)||carrier.contains("شاتل",true)->"shatelmobile"
            else->null
        }
        val wrongDns=privateMode.equals("hostname",true)&&privateHost.isNotBlank()
        if(!wrongDns&&suggestedApn==null)return
        val fingerprint="$privateMode|$privateHost|$carrier|$suggestedApn"
        val prefs=context.getSharedPreferences("network_advisor",Context.MODE_PRIVATE)
        if(prefs.getString("last","")==fingerprint)return
        prefs.edit().putString("last",fingerprint).apply()
        val settingsIntent=if(wrongDns&&Build.VERSION.SDK_INT>=28)Intent("android.settings.PRIVATE_DNS_SETTINGS")else Intent(Settings.ACTION_APN_SETTINGS)
        val pending=PendingIntent.getActivity(context,82,settingsIntent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title=if(wrongDns)"DNS خصوصی گوشی نیاز به بررسی دارد" else "تنظیم اینترنت ${carrier.ifBlank{"سیم‌کارت"}}"
        val text=if(wrongDns)"DNS خصوصی $privateHost فعال است؛ برای بازگشت به حالت خودکار لمس کنید." else "APN پیشنهادی اپراتور: $suggestedApn — برای بررسی تنظیمات لمس کنید."
        val manager=context.getSystemService(NotificationManager::class.java)
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(CHANNEL,"سلامت شبکه",NotificationManager.IMPORTANCE_DEFAULT).apply{setShowBadge(true)})
        manager.notify(8201,NotificationCompat.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_nivora_notification).setContentTitle(title).setContentText(text).setStyle(NotificationCompat.BigTextStyle().bigText(text)).setContentIntent(pending).setAutoCancel(true).build())
    }
}
