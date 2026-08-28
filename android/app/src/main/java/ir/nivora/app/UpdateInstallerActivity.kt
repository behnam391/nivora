package ir.nivora.app

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import ir.nivora.app.data.ApiClient
import ir.nivora.app.data.AppRelease
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

object AppUpdateNotifier {
    private const val CHANNEL = "nivora_updates_v1"
    fun check(context:Context,onFound:(AppRelease)->Unit={})=thread{
        runCatching { ApiClient(BuildConfig.API_BASE_URL).appRelease(BuildConfig.APP_AUDIENCE) }.getOrNull()?.takeIf { it.versionCode>BuildConfig.VERSION_CODE&&it.downloadUrl.startsWith("https://") }?.let { release ->
            context.getSharedPreferences("updates",Context.MODE_PRIVATE).edit().putString("url",release.downloadUrl).apply()
            val manager=context.getSystemService(NotificationManager::class.java)
            if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(CHANNEL,"بروزرسانی‌های Nivora",NotificationManager.IMPORTANCE_HIGH).apply{enableVibration(true);setShowBadge(true);setSound(Settings.System.DEFAULT_NOTIFICATION_URI,AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())})
            val intent=Intent(context,UpdateInstallerActivity::class.java).putExtra("url",release.downloadUrl)
            val pending=PendingIntent.getActivity(context,71,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.notify(7101,NotificationCompat.Builder(context,CHANNEL).setSmallIcon(R.drawable.ic_nivora_notification).setContentTitle("نسخه ${release.versionName} آماده نصب است").setContentText(release.releaseNotes.ifBlank{"برای دریافت بروزرسانی لمس کنید"}).setStyle(NotificationCompat.BigTextStyle().bigText(release.releaseNotes)).setContentIntent(pending).setAutoCancel(!release.forceUpdate).setOngoing(release.forceUpdate).setPriority(NotificationCompat.PRIORITY_HIGH).setNumber(1).build())
            (context as? Activity)?.runOnUiThread{onFound(release)}
        }
    }
}

class UpdateInstallerActivity:Activity(){
    private var updateUrl:String=""
    override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);updateUrl=intent.getStringExtra("url")?:getSharedPreferences("updates",MODE_PRIVATE).getString("url","").orEmpty();if(updateUrl.startsWith("https://"))download()else finish()}
    override fun onResume(){super.onResume();val apk=File(cacheDir,"app-updates/nivora-update.apk");if(apk.exists()&&Build.VERSION.SDK_INT>=26&&packageManager.canRequestPackageInstalls())install(apk)}
    private fun download()=thread{
        runCatching{
            val dir=File(cacheDir,"app-updates").apply{mkdirs()};val apk=File(dir,"nivora-update.apk")
            val connection=(URL(updateUrl).openConnection() as HttpURLConnection).apply{instanceFollowRedirects=true;connectTimeout=15000;readTimeout=60000;setRequestProperty("User-Agent","Nivora/${BuildConfig.VERSION_NAME}")}
            connection.inputStream.use{input->apk.outputStream().use{output->input.copyTo(output)}};connection.disconnect();runOnUiThread{install(apk)}
        }.onFailure{runOnUiThread{startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(updateUrl)));finish()}}
    }
    private fun install(apk:File){
        if(Build.VERSION.SDK_INT>=26&&!packageManager.canRequestPackageInstalls()){startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")));return}
        val uri=FileProvider.getUriForFile(this,"$packageName.receipt-files",apk)
        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));finish()
    }
}
