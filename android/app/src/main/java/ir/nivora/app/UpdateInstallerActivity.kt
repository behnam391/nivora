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
    private lateinit var status: android.widget.TextView
    private lateinit var progress: android.widget.ProgressBar
    private lateinit var retry: android.widget.Button
    @Volatile private var cancelled=false
    @Volatile private var connection:HttpURLConnection?=null
    private var readyApk:File?=null
    private var awaitingPermission=false
    private var updateUrl=""

    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        updateUrl=intent.getStringExtra("url")?:getSharedPreferences("updates",MODE_PRIVATE).getString("url","").orEmpty()
        val layout=android.widget.LinearLayout(this).apply{orientation=1;setPadding(40,70,40,40);setBackgroundColor(0xff10182c.toInt())}
        status=android.widget.TextView(this).apply{textSize=18f;setTextColor(android.graphics.Color.WHITE);text="دریافت نسخه جدید Nivora"}
        progress=android.widget.ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal).apply{max=100;isIndeterminate=true}
        retry=android.widget.Button(this).apply{text="تلاش دوباره";visibility=android.view.View.GONE;setOnClickListener{download()}}
        val cancel=android.widget.Button(this).apply{text="انصراف";setOnClickListener{cancelled=true;connection?.disconnect();finish()}}
        layout.addView(status);layout.addView(progress);layout.addView(retry);layout.addView(cancel);setContentView(layout)
        if(updateUrl.startsWith("https://"))download()else{status.text="آدرس بروزرسانی معتبر نیست"}
    }
    override fun onResume(){super.onResume();if(awaitingPermission){awaitingPermission=false;readyApk?.let{if(Build.VERSION.SDK_INT<26||packageManager.canRequestPackageInstalls())install(it)else{status.text="اجازه نصب داده نشد؛ برای تلاش دوباره لمس کنید";retry.visibility=android.view.View.VISIBLE}}}}
    override fun onDestroy(){cancelled=true;connection?.disconnect();super.onDestroy()}
    private fun download(){
        cancelled=false;readyApk=null;retry.visibility=android.view.View.GONE;progress.isIndeterminate=true;status.text="در حال دریافت بروزرسانی…"
        thread(name="nivora-update"){
            val part=File.createTempFile("update-",".part",File(cacheDir,"app-updates").apply{mkdirs()})
            runCatching{
                var url=URL(updateUrl)
                var active:HttpURLConnection?=null
                for(hop in 0..5){
                    check(url.protocol=="https")
                    val c=(url.openConnection() as HttpURLConnection).apply{instanceFollowRedirects=false;connectTimeout=15000;readTimeout=20000;setRequestProperty("Accept-Encoding","identity")}
                    connection=c
                    if(c.responseCode in listOf(301,302,303,307,308)){
                        val next=c.getHeaderField("Location")?:error("REDIRECT_INVALID");c.disconnect();check(hop<5);url=URL(url,next)
                    }else{check(c.responseCode==200);active=c;break}
                }
                val c=active?:error("DOWNLOAD_FAILED")
                val total=c.contentLengthLong;val limit=250L*1024*1024;check(total<=limit)
                var received=0L;var lastUi=0L
                try{c.inputStream.use{input->part.outputStream().use{output->
                    val bytes=ByteArray(32768)
                    while(true){check(!cancelled);val count=input.read(bytes);if(count<0)break;received+=count;check(received<=limit);output.write(bytes,0,count)
                        val clock=android.os.SystemClock.elapsedRealtime()
                        if(clock-lastUi>200){lastUi=clock;val done=received;runOnUiThread{if(!isDestroyed){progress.isIndeterminate=total<=0;progress.progress=if(total>0)(done*100/total).toInt()else 0;status.text=if(total>0)"دانلود ${done*100/total}٪" else "دریافت ${done/1024} کیلوبایت"}}}
                    }
                }}}finally{c.disconnect();connection=null}
                check(received>0&&(total<0||received==total));check(!cancelled)
                // Reject wrong packages, downgrades and a different signing identity.
                @Suppress("DEPRECATION")
                val archive=packageManager.getPackageArchiveInfo(part.path,android.content.pm.PackageManager.GET_SIGNATURES)?:error("INVALID_APK")
                @Suppress("DEPRECATION")
                val current=packageManager.getPackageInfo(packageName,android.content.pm.PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION")
                val signatureMatches=archive.signatures?.map{it.toCharsString()}?.toSet()==current.signatures?.map{it.toCharsString()}?.toSet() && !archive.signatures.isNullOrEmpty()
                @Suppress("DEPRECATION")
                check(archive.packageName==packageName && archive.versionCode>BuildConfig.VERSION_CODE && signatureMatches)
                val apk=File(part.parentFile,part.nameWithoutExtension+".apk");check(part.renameTo(apk))
                runOnUiThread{if(!isDestroyed&&!cancelled){readyApk=apk;progress.isIndeterminate=false;progress.progress=100;status.text="دانلود کامل شد؛ آماده نصب";install(apk)}}
            }.onFailure{part.delete();runOnUiThread{if(!isDestroyed&&!cancelled){status.text="دانلود یا اعتبارسنجی کامل نشد؛ دوباره تلاش کنید";retry.visibility=android.view.View.VISIBLE}}}
        }
    }
    private fun install(apk:File){
        if(Build.VERSION.SDK_INT>=26&&!packageManager.canRequestPackageInstalls()){awaitingPermission=true;startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")));return}
        val uri=FileProvider.getUriForFile(this,"$packageName.receipt-files",apk)
        startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));finish()
    }
}
