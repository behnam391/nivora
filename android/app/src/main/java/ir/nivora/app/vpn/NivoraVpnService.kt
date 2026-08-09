package ir.nivora.app.vpn
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import ir.nivora.app.MainActivity
import ir.nivora.app.R
class NivoraVpnService:VpnService(){
    override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{val nm=getSystemService(NotificationManager::class.java);nm.createNotificationChannel(NotificationChannel("vpn","Nivora VPN",NotificationManager.IMPORTANCE_LOW));val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_IMMUTABLE);val notification=android.app.Notification.Builder(this,"vpn").setSmallIcon(android.R.drawable.stat_sys_warning).setContentTitle("Nivora").setContentText(getString(R.string.vpn_notification)).setContentIntent(open).setOngoing(true).build();startForeground(71,notification);return START_STICKY}
    override fun onRevoke(){stopSelf();super.onRevoke()}
}
