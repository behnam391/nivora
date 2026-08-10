package ir.nivora.app.vpn

import android.app.*
import android.content.Intent
import android.graphics.Color
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import ir.nivora.app.MainActivity
import ir.nivora.app.R
import ir.nivora.app.data.NetworkTools
import ir.nivora.app.data.ServiceEndpoint
import libXray.DialerController
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class NivoraVpnService : VpnService(), DialerController {
    companion object {
        const val EXTRA_URL = "subscription_url"
        const val EXTRA_LABEL = "subscription_label"
        const val ACTION_STOP = "ir.nivora.app.STOP"
        const val ACTION_STATE = "ir.nivora.app.VPN_STATE"
        private const val CHANNEL_ID = "nivora_vpn"
        private const val NOTIFICATION_ID = 71

        fun isCoreRunning(): Boolean = runCatching {
            val response = JSONObject(
                LibXray.invoke(
                    JSONObject().put("apiVersion", 1).put("method", "getXrayState").put("payload", JSONObject()).toString()
                )
            )
            response.optJSONObject("data")?.optBoolean("running") == true
        }.getOrDefault(false)
    }

    private val generation = AtomicInteger()
    private var tun: ParcelFileDescriptor? = null
    @Volatile private var terminalError = false

    override fun protectFd(fd: Long) = protect(fd.toInt())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            generation.incrementAndGet()
            terminalError = false
            shutdown(markDisconnected = true)
            stopSelf()
            return START_NOT_STICKY
        }
        val url = intent?.getStringExtra(EXTRA_URL)
        if (url.isNullOrBlank()) {
            state("error", "SUBSCRIPTION_MISSING")
            stopSelf()
            return START_NOT_STICKY
        }
        val label = intent.getStringExtra(EXTRA_LABEL).orEmpty()
        val runId = generation.incrementAndGet()
        terminalError = false
        state("connecting", null)
        showNotification("در حال برقراری اتصال امن…", label, connected = false)
        thread(name = "nivora-xray") {
            try {
                startTunnel(url, label, runId)
            } catch (error: Throwable) {
                if (generation.get() != runId) return@thread
                Log.e("NivoraVpnService", "VPN tunnel failed: ${error.javaClass.simpleName}")
                terminalError = true
                state("error", safeError(error))
                shutdown(markDisconnected = false)
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startTunnel(url: String, label: String, runId: Int) {
        stopCore()
        ensureCurrent(runId)
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            useCaches = false
            setRequestProperty("Accept", "text/plain")
        }
        val raw = try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("SUBSCRIPTION_UNAVAILABLE")
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
        ensureCurrent(runId)
        if (raw.isBlank()) throw IllegalStateException("SUBSCRIPTION_EMPTY")

        val convert = JSONObject()
            .put("apiVersion", 1)
            .put("method", "convertShareLinksToXrayJson")
            .put("payload", JSONObject().put("text", raw))
        val converted = JSONObject(LibXray.invoke(convert.toString()))
        if (!converted.optBoolean("success")) throw IllegalStateException("SUBSCRIPTION_INVALID")
        ensureCurrent(runId)

        val config = converted.getJSONObject("data")
        val outbounds = config.getJSONArray("outbounds")
        if (outbounds.length() == 0) throw IllegalStateException("SUBSCRIPTION_EMPTY")
        sanitizeOutbounds(outbounds)
        val smartRoute = configureSmartRouting(config, outbounds)
        config.put("log", JSONObject().put("loglevel", "warning"))
        config.put("env", JSONObject().put("xray.tun.fd", "0"))
        config.put(
            "inbounds",
            JSONArray().put(
                JSONObject()
                    .put("tag", "tun-in")
                    .put("protocol", "tun")
                    .put("settings", JSONObject().put("name", "nivora").put("mtu", 1400))
                    .put("sniffing", JSONObject().put("enabled", true).put("destOverride", JSONArray(listOf("http", "tls", "quic"))))
            )
        )
        val routing = JSONObject().put("domainStrategy", "IPIfNonMatch").put("rules", JSONArray().put(smartRoute.rule))
        smartRoute.balancers?.let { routing.put("balancers", it) }
        config.put("routing", routing)

        ensureCurrent(runId)
        val builder = Builder()
            .setSession("Nivora")
            .setMtu(1400)
            .addAddress("172.19.0.1", 30)
            .addDnsServer("1.1.1.1")
            .addRoute("0.0.0.0", 0)
            .setBlocking(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) builder.setMetered(false)
        tun = builder.establish() ?: throw IllegalStateException("TUN_CREATE_FAILED")
        config.getJSONObject("env").put("xray.tun.fd", tun!!.fd.toString())
        ensureCurrent(runId)

        LibXray.registerDialerController(this)
        LibXray.setDNS(this, "1.1.1.1:53")
        val run = JSONObject()
            .put("apiVersion", 1)
            .put("method", "runXrayFromJson")
            .put("payload", JSONObject().put("configJSON", config.toString()))
        val result = JSONObject(LibXray.invoke(run.toString()))
        if (!result.optBoolean("success")) throw IllegalStateException("XRAY_START_FAILED")
        ensureCurrent(runId)
        state("connected", null)
        showNotification("متصل و محافظت‌شده", label, connected = true)
    }

    private fun sanitizeOutbounds(outbounds: JSONArray) {
        for (index in 0 until outbounds.length()) {
            val outbound = outbounds.getJSONObject(index)
            outbound.remove("sendThrough")
            val reality = outbound.optJSONObject("streamSettings")?.optJSONObject("realitySettings")
            listOf(
                "target", "dest", "type", "xver", "serverNames", "privateKey", "shortIds",
                "minClientVer", "maxClientVer", "maxTimeDiff"
            ).forEach { reality?.remove(it) }
        }
    }

    private data class SmartRoute(val rule: JSONObject, val balancers: JSONArray? = null)

    private fun configureSmartRouting(config: JSONObject, outbounds: JSONArray): SmartRoute {
        val candidates = buildList {
            for (index in 0 until outbounds.length()) {
                endpointFromOutbound(outbounds.getJSONObject(index))?.let { add(index to it) }
            }
        }
        val fastest = NetworkTools.fastest(candidates.map { it.second }, timeoutMs = 2_800)
        val selectedIndex = fastest?.let { result -> candidates.firstOrNull { it.second == result.endpoint }?.first }
            ?: candidates.firstOrNull()?.first ?: 0
        if (candidates.size < 2) {
            outbounds.getJSONObject(selectedIndex).put("tag", "proxy")
            return SmartRoute(JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("outboundTag", "proxy"))
        }
        candidates.forEach { (index, _) -> outbounds.getJSONObject(index).put("tag", "proxy-route-$index") }
        val fallbackTag = "proxy-route-$selectedIndex"
        config.put(
            "observatory",
            JSONObject()
                .put("subjectSelector", JSONArray().put("proxy-route-"))
                .put("probeUrl", "https://www.gstatic.com/generate_204")
                .put("probeInterval", "30s")
                .put("enableConcurrency", true)
        )
        val balancers = JSONArray().put(
            JSONObject()
                .put("tag", "smart-route")
                .put("selector", JSONArray().put("proxy-route-"))
                .put("fallbackTag", fallbackTag)
                .put("strategy", JSONObject().put("type", "leastPing"))
        )
        return SmartRoute(
            JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("balancerTag", "smart-route"),
            balancers
        )
    }

    private fun endpointFromOutbound(outbound: JSONObject): ServiceEndpoint? {
        val settings = outbound.optJSONObject("settings") ?: return null
        val candidates = listOf("vnext", "servers")
        for (key in candidates) {
            val array = settings.optJSONArray(key) ?: continue
            if (array.length() == 0) continue
            val server = array.optJSONObject(0) ?: continue
            val host = server.optString("address").ifBlank { server.optString("server") }
            val port = server.optInt("port")
            val stream = outbound.optJSONObject("streamSettings")
            val security = stream?.optString("security").orEmpty()
            val tls = stream?.optJSONObject("tlsSettings")
            val serverName = tls?.optString("serverName").orEmpty().ifBlank { tls?.optString("server_name").orEmpty() }.ifBlank { null }
            if (host.isNotBlank() && port in 1..65535) return ServiceEndpoint(host, port, serverName, security.equals("tls", true))
        }
        return null
    }

    private fun ensureCurrent(runId: Int) {
        if (generation.get() != runId) throw InterruptedException("VPN_STOPPED")
    }

    private fun state(value: String, error: String?) {
        getSharedPreferences("vpn", MODE_PRIVATE).edit()
            .putString("state", value)
            .apply { if (error == null) remove("error") else putString("error", error) }
            .apply()
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName))
    }

    private fun showNotification(text: String, label: String, connected: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "اتصال امن Nivora", NotificationManager.IMPORTANCE_LOW).apply {
                description = "نمایش وضعیت اتصال VPN"
                setShowBadge(false)
                lightColor = Color.rgb(34, 212, 155)
            }
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, NivoraVpnService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_nivora_notification)
            .setContentTitle("Nivora · $text")
            .setContentText(label.ifBlank { "اتصال رمزگذاری‌شده" })
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(34, 212, 155))
            .apply { if (connected) addAction(Notification.Action.Builder(null, "قطع اتصال", stop).build()) }
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopCore() {
        runCatching {
            LibXray.invoke(JSONObject().put("apiVersion", 1).put("method", "stopXray").put("payload", JSONObject()).toString())
        }
        runCatching { LibXray.resetDNS() }
    }

    private fun shutdown(markDisconnected: Boolean) {
        stopCore()
        runCatching { tun?.close() }
        tun = null
        if (markDisconnected) state("disconnected", null)
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun safeError(error: Throwable): String = when {
        error is java.net.SocketTimeoutException -> "SUBSCRIPTION_TIMEOUT"
        error is java.net.UnknownHostException -> "SUBSCRIPTION_NETWORK_ERROR"
        error.message?.startsWith("SUBSCRIPTION_") == true -> error.message!!
        error.message == "TUN_CREATE_FAILED" -> "TUN_CREATE_FAILED"
        else -> "VPN_START_FAILED"
    }

    override fun onRevoke() {
        generation.incrementAndGet()
        terminalError = false
        shutdown(markDisconnected = true)
        stopSelf()
        super.onRevoke()
    }

    override fun onDestroy() {
        generation.incrementAndGet()
        shutdown(markDisconnected = !terminalError)
        super.onDestroy()
    }
}
