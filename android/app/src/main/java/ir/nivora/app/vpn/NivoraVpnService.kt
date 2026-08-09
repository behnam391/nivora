package ir.nivora.app.vpn

import android.app.*
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import ir.nivora.app.MainActivity
import libXray.DialerController
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class NivoraVpnService:VpnService(),DialerController{
 companion object{const val EXTRA_URL="subscription_url";const val ACTION_STOP="ir.nivora.app.STOP";fun isCoreRunning()=runCatching{JSONObject(LibXray.invoke(JSONObject().put("apiVersion",1).put("method","getXrayState").put("payload",JSONObject()).toString())).optJSONObject("data")?.optBoolean("running")==true}.getOrDefault(false)}
 private var tun:ParcelFileDescriptor?=null
 override fun protectFd(fd:Long)=protect(fd.toInt())
 override fun onStartCommand(intent:Intent?,flags:Int,startId:Int):Int{
  if(intent?.action==ACTION_STOP){stopTunnel();return START_NOT_STICKY}
  notifyState("در حال اتصال…",true);val url=intent?.getStringExtra(EXTRA_URL)?:return START_NOT_STICKY
  thread(name="nivora-xray"){try{startTunnel(url)}catch(e:Throwable){Log.e("NivoraVpnService","Tunnel failed",e);state("error",e.message);stopTunnel(false)}}
  return START_STICKY
 }
 private fun startTunnel(url:String){stopCore();val raw=(URL(url).openConnection() as HttpURLConnection).apply{connectTimeout=15000;readTimeout=20000}.inputStream.bufferedReader().use{it.readText()}
  val convert=JSONObject().put("apiVersion",1).put("method","convertShareLinksToXrayJson").put("payload",JSONObject().put("text",raw))
  val converted=JSONObject(LibXray.invoke(convert.toString()));if(!converted.optBoolean("success"))throw IllegalStateException(converted.optString("error"))
  val config=converted.getJSONObject("data");val out=config.getJSONArray("outbounds");if(out.length()==0)throw IllegalStateException("اشتراک خالی است")
  for(i in 0 until out.length()){
   val outbound=out.getJSONObject(i);outbound.remove("sendThrough")
   val reality=outbound.optJSONObject("streamSettings")?.optJSONObject("realitySettings")
   listOf("target","dest","type","xver","serverNames","privateKey","shortIds","minClientVer","maxClientVer","maxTimeDiff").forEach{reality?.remove(it)}
  }
  out.getJSONObject(0).put("tag","proxy")
  config.put("log",JSONObject().put("loglevel","warning"))
  config.put("env",JSONObject().put("xray.tun.fd","0"))
  config.put("inbounds",JSONArray().put(JSONObject().put("tag","tun-in").put("protocol","tun").put("settings",JSONObject().put("name","nivora").put("mtu",1400)).put("sniffing",JSONObject().put("enabled",true).put("destOverride",JSONArray(listOf("http","tls","quic"))))))
  config.put("routing",JSONObject().put("domainStrategy","IPIfNonMatch").put("rules",JSONArray().put(JSONObject().put("type","field").put("inboundTag",JSONArray().put("tun-in")).put("outboundTag","proxy"))))
  tun=Builder().setSession("Nivora").setMtu(1400).addAddress("172.19.0.1",30).addDnsServer("1.1.1.1").addRoute("0.0.0.0",0).setBlocking(false).establish()?:throw IllegalStateException("ساخت تونل ناموفق بود")
  config.getJSONObject("env").put("xray.tun.fd",tun!!.fd.toString())
  LibXray.registerDialerController(this);LibXray.setDNS(this,"1.1.1.1:53")
  val run=JSONObject().put("apiVersion",1).put("method","runXrayFromJson").put("payload",JSONObject().put("configJSON",config.toString()))
  val result=JSONObject(LibXray.invoke(run.toString()));if(!result.optBoolean("success"))throw IllegalStateException(result.optString("error"))
  state("connected",null);notifyState("متصل و محافظت‌شده",true)
 }
 private fun state(value:String,error:String?){getSharedPreferences("vpn",0).edit().putString("state",value).putString("error",error).apply();sendBroadcast(Intent("ir.nivora.app.VPN_STATE").setPackage(packageName))}
 private fun notifyState(text:String,ongoing:Boolean){val nm=getSystemService(NotificationManager::class.java);nm.createNotificationChannel(NotificationChannel("vpn","Nivora VPN",NotificationManager.IMPORTANCE_LOW));val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_IMMUTABLE);startForeground(71,Notification.Builder(this,"vpn").setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Nivora").setContentText(text).setContentIntent(open).setOngoing(ongoing).build())}
 private fun stopCore(){runCatching{LibXray.invoke(JSONObject().put("apiVersion",1).put("method","stopXray").put("payload",JSONObject()).toString())};runCatching{LibXray.resetDNS()}}
 private fun stopTunnel(mark:Boolean=true){stopCore();runCatching{tun?.close()};tun=null;if(mark)state("disconnected",null);stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()}
 override fun onDestroy(){stopTunnel(false);super.onDestroy()};override fun onRevoke(){stopTunnel();super.onRevoke()}
}
