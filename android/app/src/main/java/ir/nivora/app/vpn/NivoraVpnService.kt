package ir.nivora.app.vpn

import android.app.*
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import ir.nivora.app.MainActivity
import ir.nivora.app.R
import ir.nivora.app.data.NetworkTools
import ir.nivora.app.data.ServiceEndpoint
import ir.nivora.app.data.SmartRouteMemory
import ir.nivora.app.data.SubscriptionBundleStore
import libXray.DialerController
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class NivoraVpnService : VpnService(), DialerController {
    companion object {
        const val EXTRA_URL = "subscription_url"
        const val EXTRA_SESSION_TOKEN = "session_token"
        const val EXTRA_DEVICE_ID = "device_id"
        const val EXTRA_SHARE_LINK = "share_link"
        const val EXTRA_RUN_ID = "network_lab_run_id"
        const val EXTRA_STATE = "vpn_state"
        const val EXTRA_ERROR = "vpn_error"
        const val EXTRA_LABEL = "subscription_label"
        const val EXTRA_SMART_ROUTE = "smart_route"
        const val ACTION_STOP = "ir.nivora.app.STOP"
        const val ACTION_STATE = "ir.nivora.app.VPN_STATE"
        private const val CHANNEL_ID = "nivora_vpn"
        private const val NOTIFICATION_ID = 71

        private val coreRunning = AtomicBoolean(false)

        // Never load the 90+ MB native core on MainActivity's UI thread just
        // to render the first frame. The service owns the authoritative state.
        fun isCoreRunning(): Boolean = coreRunning.get()
    }

    private val generation = AtomicInteger()
    private var tun: ParcelFileDescriptor? = null
    @Volatile private var terminalError = false
    @Volatile private var activeRunId: String? = null

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
        val sessionToken = intent?.getStringExtra(EXTRA_SESSION_TOKEN)
        val deviceId = intent?.getStringExtra(EXTRA_DEVICE_ID)
        val shareLink = intent?.getStringExtra(EXTRA_SHARE_LINK)
        activeRunId = intent?.getStringExtra(EXTRA_RUN_ID)
        if (url.isNullOrBlank() && shareLink.isNullOrBlank()) {
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
                startTunnel(url, shareLink, sessionToken, deviceId, label, runId)
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

    private fun startTunnel(url: String?, shareLink: String?, sessionToken: String?, deviceId: String?, label: String, runId: Int) {
        stopCore()
        ensureCurrent(runId)
        val bundleStore = SubscriptionBundleStore(this)
        val cached = if (url.isNullOrBlank()) null else bundleStore.read(url)
        val raw = shareLink?.takeIf { it.isNotBlank() }
            ?: cached
            ?: fetchBundle(url!!, sessionToken, deviceId).also { bundleStore.save(url, it) }
        if (cached != null && !url.isNullOrBlank()) thread(name = "nivora-bundle-refresh") {
            runCatching { fetchBundle(url, sessionToken, deviceId) }
                .onSuccess { bundleStore.save(url, it) }
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
        val smartRoute = configureSmartRouting(config, outbounds, shareLink.isNullOrBlank())
        // Bootstrap DNS is used only by libXray before the tunnel is ready.
        // Application DNS must never be sent to the Iranian access provider:
        // filtered resolvers commonly return private sinkhole addresses for
        // Instagram/YouTube even when the proxy itself is perfectly healthy.
        val bootstrapDns = resolveUnderlyingDns()
        // Cloudflare's resolver has proved more consistently reachable from
        // both current Nivora locations than Google port 53 on Iranian mobile
        // networks. It is still carried inside the selected proxy route.
        val tunnelDns = "1.1.1.1"
        config.put(
            "dns",
            JSONObject()
                // The TCP DNS session itself travels inside Reality. This
                // avoids fragile nested HTTPS/DoH handshakes on weak Iranian
                // networks while still preventing ISP-side DNS leakage.
                .put("servers", JSONArray().put("tcp://$tunnelDns"))
                .put("queryStrategy", "UseIPv4")
        )
        outbounds.put(
            JSONObject()
                .put("tag", "dns-out")
                .put("protocol", "dns")
                .put(
                    "settings",
                    JSONObject()
                        // With no direct catch-all rule, A/AAAA requests are
                        // handed to the encrypted built-in resolver above.
                        // This is intentional: `direct` would leak port 53 to
                        // the mobile provider outside the proxy tunnel.
                        .put("rules", JSONArray())
                )
        )
        outbounds.put(
            JSONObject()
                .put("tag", "quic-reject")
                .put("protocol", "blackhole")
                .put("settings", JSONObject())
        )
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
        val dnsRule = JSONObject()
            .put("type", "field")
            .put("inboundTag", JSONArray().put("tun-in"))
            .put("network", "tcp,udp")
            .put("port", "53")
            .put("outboundTag", "dns-out")
        val quicRule = JSONObject()
            .put("type", "field")
            .put("inboundTag", JSONArray().put("tun-in"))
            .put("network", "udp")
            .put("port", "443")
            .put("outboundTag", "quic-reject")
        // Xray's built-in DNS requests do not carry the TUN inbound tag. If
        // left to the default dispatcher they always use the first converted
        // VLESS outbound, even after the smart balancer has selected a healthy
        // backup. Route tunnel DNS through the same selected path so one
        // degraded Reality inbound cannot stall DNS for the whole device.
        val encryptedDnsRule = JSONObject()
            .put("type", "field")
            .put("ip", JSONArray().put(tunnelDns))
            .put("network", "tcp")
            .put("port", "53")
            .apply {
                if (smartRoute.balancers != null) put("balancerTag", "smart-route")
                else put("outboundTag", "proxy")
            }
        val routing = JSONObject().put("domainStrategy", "IPIfNonMatch")
            .put("rules", JSONArray().put(dnsRule).put(quicRule).put(encryptedDnsRule).put(smartRoute.rule))
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
        LibXray.setDNS(this, "$bootstrapDns:53")
        val run = JSONObject()
            .put("apiVersion", 1)
            .put("method", "runXrayFromJson")
            .put("payload", JSONObject().put("configJSON", config.toString()))
        val result = JSONObject(LibXray.invoke(run.toString()))
        if (!result.optBoolean("success")) throw IllegalStateException("XRAY_START_FAILED")
        coreRunning.set(true)
        ensureCurrent(runId)
        // Network Lab performs its own end-to-end probes and scoring. Report
        // the core as ready immediately so its shorter connection deadline is
        // not spent waiting for the customer's separate health gate below.
        if (activeRunId != null) {
            state("connected", null, smartRoute.label)
            showNotification("مسیر آزمایشی آماده است", label, connected = true)
            return
        }
        // Mark the tunnel ready as soon as Xray accepts its configuration.
        // The VPN application's own sockets are excluded from its tunnel by
        // Android, therefore blocking this state on in-process web probes can
        // report a false failure on filtered networks.
        getSharedPreferences("vpn", MODE_PRIVATE).edit().apply {
            remove("real_latency_ms")
            remove("real_mbps")
        }.apply()
        state("connected", null, smartRoute.label)
        showNotification("متصل و محافظت‌شده", smartRoute.label?.let { "$label · $it" } ?: label, connected = true)
    }

    private fun fetchBundle(url: String, sessionToken: String?, deviceId: String?): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 6_000
            readTimeout = 8_000
            useCaches = false
            setRequestProperty("Accept", "text/plain")
            if (!sessionToken.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $sessionToken")
            if (!deviceId.isNullOrBlank()) setRequestProperty("X-Nivora-Device", deviceId)
        }
        return try {
            if (connection.responseCode !in 200..299) throw IllegalStateException("SUBSCRIPTION_UNAVAILABLE")
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally { connection.disconnect() }
    }

    /**
     * Capture an IPv4 resolver from the validated underlying network before
     * establishing the TUN. This is bootstrap-only: libXray may need it to
     * resolve the proxy endpoint. User traffic uses the protected tunnel DNS
     * configured above, so filtered provider answers never reach applications.
     */
    @Suppress("DEPRECATION")
    private fun resolveUnderlyingDns(): String {
        val manager = getSystemService(ConnectivityManager::class.java)
        val candidates = manager.allNetworks.mapNotNull { network ->
            val capabilities = manager.getNetworkCapabilities(network) ?: return@mapNotNull null
            if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            ) return@mapNotNull null
            val addresses = manager.getLinkProperties(network)?.dnsServers.orEmpty()
                .filterIsInstance<Inet4Address>()
                .filterNot { it.isAnyLocalAddress || it.isLoopbackAddress }
            if (addresses.isEmpty()) return@mapNotNull null
            val address = addresses.first().hostAddress ?: return@mapNotNull null
            Triple(
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                network == manager.activeNetwork,
                address
            )
        }.sortedWith(
            compareByDescending<Triple<Boolean, Boolean, String>> { it.first }
                .thenByDescending { it.second }
        )
        return candidates.firstOrNull()?.third?.also {
            Log.i("NivoraVpnService", "Using validated network-provided DNS")
        } ?: "1.1.1.1".also {
            Log.w("NivoraVpnService", "Network DNS unavailable; using safe fallback")
        }
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

    private data class SmartRoute(val rule: JSONObject, val balancers: JSONArray? = null, val label: String? = null)

    private fun configureSmartRouting(config: JSONObject, outbounds: JSONArray, remember: Boolean): SmartRoute {
        val candidates: List<Pair<Int, ServiceEndpoint?>> = buildList {
            for (index in 0 until outbounds.length()) {
                val outbound = outbounds.getJSONObject(index)
                val protocol = outbound.optString("protocol").lowercase()
                if (protocol !in setOf("freedom", "dns", "blackhole")) add(index to endpointFromOutbound(outbound))
            }
        }
        val networkKey = currentNetworkKey()
        val memory = SmartRouteMemory(this)
        val remembered = if (remember) memory.read(networkKey) else null
        val signatures = candidates.associate { (index, _) -> index to SmartRouteMemory.signature(outbounds.getJSONObject(index)) }
        val rememberedIndex = remembered?.winner?.let { signature -> signatures.entries.firstOrNull { it.value == signature }?.key }
        // Reuse the winner learned for this exact network immediately. Xray's
        // observatory keeps checking alternatives after startup, so a full
        // pre-flight race on every connection only makes the customer wait.
        val fastest = if (rememberedIndex == null) {
            NetworkTools.fastest(candidates.mapNotNull { it.second }, timeoutMs = 1_200)
        } else null
        val selectedIndex = rememberedIndex
            ?: fastest?.let { result -> candidates.firstOrNull { it.second == result.endpoint }?.first }
            ?: candidates.firstOrNull()?.first ?: 0
        val selectedLabel = candidates.firstOrNull { it.first == selectedIndex }
            ?.let { SmartRouteMemory.label(outbounds.getJSONObject(it.first)) }
        if (remember) {
            val selectedSignature = signatures[selectedIndex]
            if (selectedSignature != null) {
                val backup = signatures.entries.firstOrNull { it.key != selectedIndex }?.value
                memory.save(networkKey, selectedSignature, remembered?.backup ?: backup)
            }
        }
        if (candidates.size < 2) {
            outbounds.getJSONObject(selectedIndex).put("tag", "proxy")
            return SmartRoute(JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("outboundTag", "proxy"), label = selectedLabel)
        }
        candidates.forEach { (index, _) -> outbounds.getJSONObject(index).put("tag", "proxy-route-$index") }
        val fallbackTag = "proxy-route-$selectedIndex"
        config.put(
            "observatory",
            JSONObject()
                .put("subjectSelector", JSONArray().put("proxy-route-"))
                .put("probeUrl", "https://www.youtube.com/generate_204")
                .put("probeInterval", "15s")
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
            balancers,
            selectedLabel
        )
    }

    private fun currentNetworkKey(): String {
        val manager = getSystemService(ConnectivityManager::class.java)
        val network = manager.allNetworks.firstOrNull { candidate ->
            val capabilities = manager.getNetworkCapabilities(candidate) ?: return@firstOrNull false
            !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } ?: manager.activeNetwork
        val capabilities = network?.let(manager::getNetworkCapabilities)
        val type = when {
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
            else -> "other"
        }
        // The user-selected operator is intentionally coarse: no SSID, BSSID or
        // location is retained. It separates Telecom Wi-Fi from mobile carriers.
        val operator = getSharedPreferences("neuralmesh_lab", MODE_PRIVATE)
            .getString("operator", "auto").orEmpty().lowercase().replace(Regex("[^a-z0-9_-]"), "_")
        return "${type}_${operator.ifBlank { "auto" }}"
    }

    private fun endpointFromOutbound(outbound: JSONObject): ServiceEndpoint? {
        val settings = outbound.optJSONObject("settings") ?: return null
        // libXray 26.x emits VLESS in a flattened schema (address/port/id/flow),
        // while older cores used vnext[0].users. Support both formats.
        val directHost = settings.optString("address").ifBlank { settings.optString("server") }
        val directPort = settings.optInt("port")
        if (directHost.isNotBlank() && directPort in 1..65535) {
            val stream = outbound.optJSONObject("streamSettings")
            val security = stream?.optString("security").orEmpty()
            val tls = stream?.optJSONObject("tlsSettings")
            val reality = stream?.optJSONObject("realitySettings")
            val serverName = tls?.optString("serverName").orEmpty()
                .ifBlank { tls?.optString("server_name").orEmpty() }
                .ifBlank { reality?.optString("serverName").orEmpty() }
                .ifBlank { null }
            val transport = stream?.optString("network").orEmpty()
                .ifBlank { stream?.optString("method").orEmpty() }
                .ifBlank { "tcp" }
            return ServiceEndpoint(directHost, directPort, serverName, security.equals("tls", true), transport)
        }
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
            val reality = stream?.optJSONObject("realitySettings")
            val serverName = tls?.optString("serverName").orEmpty()
                .ifBlank { tls?.optString("server_name").orEmpty() }
                .ifBlank { reality?.optString("serverName").orEmpty() }
                .ifBlank { null }
            val transport = stream?.optString("network").orEmpty()
                .ifBlank { stream?.optString("method").orEmpty() }
                .ifBlank { "tcp" }
            if (host.isNotBlank() && port in 1..65535) {
                return ServiceEndpoint(host, port, serverName, security.equals("tls", true), transport)
            }
        }
        return null
    }

    private fun ensureCurrent(runId: Int) {
        if (generation.get() != runId) throw InterruptedException("VPN_STOPPED")
    }

    private fun state(value: String, error: String?, smartRoute: String? = null) {
        getSharedPreferences("vpn", MODE_PRIVATE).edit()
            .putString("state", value)
            .apply { if (error == null) remove("error") else putString("error", error) }
            .apply { if (smartRoute == null) { if (value != "connected") remove("smart_route") } else putString("smart_route", smartRoute) }
            .apply()
        sendBroadcast(Intent(ACTION_STATE).setPackage(packageName)
            .putExtra(EXTRA_RUN_ID, activeRunId)
            .putExtra(EXTRA_STATE, value)
            .putExtra(EXTRA_ERROR, error)
            .putExtra(EXTRA_SMART_ROUTE, smartRoute))
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
        coreRunning.set(false)
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
        error.message == "TUNNEL_UNHEALTHY" -> "TUNNEL_UNHEALTHY"
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
