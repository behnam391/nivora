package ir.nivora.app.vpn

import android.app.*
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import ir.nivora.app.BuildConfig
import ir.nivora.app.MainActivity
import ir.nivora.app.R
import ir.nivora.app.data.ApiClient
import ir.nivora.app.data.ConvertedRouteIdentity
import ir.nivora.app.data.CustomerConnectPolicy
import ir.nivora.app.data.EphemeralConnectTicket
import ir.nivora.app.data.NetworkTools
import ir.nivora.app.data.ServiceEndpoint
import ir.nivora.app.data.SmartRouteMemory
import ir.nivora.app.data.SubscriptionBundleStore
import ir.nivora.app.data.VpnRoutingPolicy
import libXray.DialerController
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class NivoraVpnService : VpnService(), DialerController {
    companion object {
        const val EXTRA_URL = "subscription_url"
        const val EXTRA_SUBSCRIPTION_ID = "subscription_id"
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
        private const val CONNECT_TICKET_BUDGET_MS = 5_000L

        private val coreRunning = AtomicBoolean(false)
        private val connectionAttempts = AtomicInteger()

        // Never load the 90+ MB native core on MainActivity's UI thread just
        // to render the first frame. The service owns the authoritative state.
        fun isCoreRunning(): Boolean = coreRunning.get()
        fun isConnectionAttemptActive(): Boolean = connectionAttempts.get() > 0
    }

    private val generation = AtomicInteger()
    private val tunnelLock = Any()
    private val coreLock = Any()
    private var tun: ParcelFileDescriptor? = null
    @Volatile private var terminalError = false
    @Volatile private var activeRunId: String? = null

    override fun protectFd(fd: Long) = protect(fd.toInt())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A notification action may create a fresh service instance. Enter
            // foreground immediately before tearing it down so Android 15 never
            // reports ForegroundServiceDidNotStartInTimeException.
            showNotification("در حال قطع اتصال…", "", connected = false)
            generation.incrementAndGet()
            terminalError = false
            shutdown(markDisconnected = true)
            stopSelf()
            return START_NOT_STICKY
        }
        val url = intent?.getStringExtra(EXTRA_URL)
        val subscriptionId = intent?.getStringExtra(EXTRA_SUBSCRIPTION_ID)
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
        connectionAttempts.incrementAndGet()
        state("connecting", null)
        showNotification("در حال برقراری اتصال امن…", label, connected = false)
        thread(name = "nivora-xray") {
            try {
                startTunnel(url, subscriptionId, shareLink, sessionToken, deviceId, label, runId)
            } catch (error: Throwable) {
                if (generation.get() != runId) return@thread
                Log.e("NivoraVpnService", "VPN tunnel failed: ${error.javaClass.simpleName}")
                terminalError = true
                state("error", safeError(error))
                shutdown(markDisconnected = false)
                stopSelf()
            } finally {
                connectionAttempts.decrementAndGet()
            }
        }
        return START_STICKY
    }

    private fun startTunnel(
        url: String?,
        subscriptionId: String?,
        shareLink: String?,
        sessionToken: String?,
        deviceId: String?,
        label: String,
        runId: Int
    ) {
        prepareCoreForRun(runId)
        val preferTicketRoute = shareLink.isNullOrBlank() &&
            !url.isNullOrBlank() &&
            !subscriptionId.isNullOrBlank() &&
            !sessionToken.isNullOrBlank() &&
            !deviceId.isNullOrBlank() &&
            labPrefersHysteria()
        val pendingTicket = if (preferTicketRoute) {
            requestConnectTicket(subscriptionId!!, sessionToken!!, deviceId!!)
        } else null
        val bundleStore = SubscriptionBundleStore(this)
        val cached = if (url.isNullOrBlank()) null else bundleStore.read(url)
        val baseRaw = try {
            shareLink?.takeIf { it.isNotBlank() }
                ?: cached
                ?: fetchBundle(url!!, sessionToken, deviceId).also { bundleStore.save(url, it) }
        } catch (error: Throwable) {
            pendingTicket?.cancel()
            throw error
        }
        if (cached != null && !url.isNullOrBlank()) thread(name = "nivora-bundle-refresh") {
            runCatching { fetchBundle(url, sessionToken, deviceId) }
                .onSuccess { bundleStore.save(url, it) }
        }
        ensureCurrent(runId)
        if (baseRaw.isBlank()) {
            pendingTicket?.cancel()
            throw IllegalStateException("SUBSCRIPTION_EMPTY")
        }
        val ticket = pendingTicket?.await()
        val ephemeral = CustomerConnectPolicy.attachTicket(baseRaw, ticket, System.currentTimeMillis())
        var converted = convertShareLinks(ephemeral.raw)
        var ticketAttached = ephemeral.ticketAttached
        var forceRealityFallback = false
        // A rejected/unsupported ticket must never take down the customer's
        // established Reality bundle. Retry locally without another network hop.
        if (!converted.optBoolean("success") && ticketAttached) {
            converted = convertShareLinks(baseRaw)
            ticketAttached = false
            forceRealityFallback = true
        }
        if (!converted.optBoolean("success")) throw IllegalStateException("SUBSCRIPTION_INVALID")
        ensureCurrent(runId)

        var config = converted.getJSONObject("data")
        var outbounds = config.getJSONArray("outbounds")
        if (outbounds.length() == 0) throw IllegalStateException("SUBSCRIPTION_EMPTY")
        sanitizeOutbounds(outbounds)
        var preferredHysteriaIndex = if (ticketAttached) {
            CustomerConnectPolicy.matchingTicketRouteIndex(ticket, routeIdentities(outbounds))
        } else null
        // libXray may return a successful conversion while silently omitting an
        // unsupported URI. Never infer success from the ticket alone: if its
        // exact endpoint and fresh credential are absent, rebuild the
        // established Reality bundle.
        if (ticketAttached && preferredHysteriaIndex == null) {
            Log.w("NivoraVpnService", "Issued Hysteria ticket was not present after conversion; using Reality")
            converted = convertShareLinks(baseRaw)
            if (!converted.optBoolean("success")) throw IllegalStateException("SUBSCRIPTION_INVALID")
            ticketAttached = false
            config = converted.getJSONObject("data")
            outbounds = config.getJSONArray("outbounds")
            if (outbounds.length() == 0) throw IllegalStateException("SUBSCRIPTION_EMPTY")
            sanitizeOutbounds(outbounds)
            preferredHysteriaIndex = null
            forceRealityFallback = true
        }
        val smartRoute = configureSmartRouting(
            config,
            outbounds,
            remember = shareLink.isNullOrBlank() && !ticketAttached,
            preferredHysteriaIndex = preferredHysteriaIndex,
            forceReality = forceRealityFallback
        )
        // Bootstrap DNS is used only by libXray before the tunnel is ready.
        // Application DNS must never be sent to the Iranian access provider:
        // filtered resolvers commonly return private sinkhole addresses for
        // Instagram/YouTube even when the proxy itself is perfectly healthy.
        val bootstrapDns = resolveUnderlyingDns()
        val tunnelDnsTag = "dns-tunnel"
        val usesTunneledDoh = smartRoute.policy.primaryTransport == VpnRoutingPolicy.PrimaryTransport.HYSTERIA2
        val dnsConfig = if (usesTunneledDoh) {
            JSONObject()
                // Remote DoH is tagged into the selected proxy. Unlike plain
                // DNS-over-TCP, Xray reuses its HTTP/2 connection instead of
                // paying a new handshake for every query. Parallel resolvers
                // remove a single-provider cold-start penalty.
                .put("tag", tunnelDnsTag)
                .put(
                    "servers",
                    JSONArray()
                        .put(
                            JSONObject()
                                .put("address", "https://1.1.1.1/dns-query")
                                .put("queryStrategy", "UseIPv4")
                                .put("timeoutMs", 1_500)
                        )
                        .put(
                            JSONObject()
                                .put("address", "https://8.8.8.8/dns-query")
                                .put("queryStrategy", "UseIPv4")
                                .put("timeoutMs", 1_500)
                        )
                )
                .put("queryStrategy", "UseIPv4")
                .put("disableCache", false)
                .put("serveStale", true)
                .put("serveExpiredTTL", 300)
                .put("enableParallelQuery", true)
                .put("disableFallback", false)
                .put("disableFallbackIfMatch", false)
                .put("useSystemHosts", false)
        } else {
            // TCP DNS remains the conservative fallback for Reality routes.
            // It is slower per cold query, but avoids nesting two TLS sessions
            // inside unstable TCP paths and has proved more reliable there.
            JSONObject()
                .put("servers", JSONArray().put("tcp://1.1.1.1"))
                .put("queryStrategy", "UseIPv4")
        }
        config.put("dns", dnsConfig)
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
        // Reality-over-TCP benefits from an immediate QUIC rejection so apps
        // fall back to HTTPS instead of waiting on an unusable UDP path.
        // Hysteria2 is itself a reliable UDP transport; blocking UDP/443 there
        // delays or breaks Instagram, YouTube and Telegram media/calls.
        if (smartRoute.policy.rejectUdp443) {
            outbounds.put(
                JSONObject()
                    .put("tag", "quic-reject")
                    .put("protocol", "blackhole")
                    .put("settings", JSONObject())
            )
        }
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
        val quicRule = if (smartRoute.policy.rejectUdp443) JSONObject()
            .put("type", "field")
            .put("inboundTag", JSONArray().put("tun-in"))
            .put("network", "udp")
            .put("port", "443")
            .put("outboundTag", "quic-reject") else null
        // DNS module traffic must follow the same selected route as customer
        // traffic. Literal resolver IPs avoid bootstrap recursion.
        val tunneledDnsRule = JSONObject().put("type", "field")
            .apply {
                if (usesTunneledDoh) {
                    put("inboundTag", JSONArray().put(tunnelDnsTag))
                } else {
                    put("ip", JSONArray().put("1.1.1.1"))
                    put("network", "tcp")
                    put("port", "53")
                }
            }
            .apply {
                if (smartRoute.balancers != null) put("balancerTag", "smart-route")
                else put("outboundTag", "proxy")
            }
        val routeRules = JSONArray().put(dnsRule)
        quicRule?.let(routeRules::put)
        routeRules.put(tunneledDnsRule).put(smartRoute.rule)
        val routing = JSONObject().put("domainStrategy", "AsIs")
            .put("rules", routeRules)
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
        val establishedTun = builder.establish() ?: throw IllegalStateException("TUN_CREATE_FAILED")
        val replacedTun = synchronized(tunnelLock) {
            if (generation.get() != runId) {
                runCatching { establishedTun.close() }
                throw InterruptedException("VPN_STOPPED")
            }
            tun.also { tun = establishedTun }
        }
        runCatching { replacedTun?.close() }
        config.getJSONObject("env").put("xray.tun.fd", establishedTun.fd.toString())
        ensureCurrent(runId)

        LibXray.registerDialerController(this)
        LibXray.setDNS(this, "$bootstrapDns:53")
        val run = JSONObject()
            .put("apiVersion", 1)
            .put("method", "runXrayFromJson")
            .put("payload", JSONObject().put("configJSON", config.toString()))
        synchronized(coreLock) {
            ensureCurrent(runId)
            val result = JSONObject(LibXray.invoke(run.toString()))
            ensureCurrent(runId)
            if (!result.optBoolean("success")) throw IllegalStateException("XRAY_START_FAILED")
            coreRunning.set(true)
        }
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
        // Keep route details internal. Customers only need the human location label.
        showNotification("متصل و محافظت‌شده", label, connected = true)
    }

    private class PendingConnectTicket(
        private val executor: ExecutorService,
        private val future: Future<EphemeralConnectTicket?>,
        private val deadlineElapsedMs: Long
    ) {
        fun await(): EphemeralConnectTicket? = try {
            val remainingMs = deadlineElapsedMs - SystemClock.elapsedRealtime()
            when {
                future.isDone -> runCatching { future.get() }.getOrNull()
                remainingMs > 0L -> runCatching { future.get(remainingMs, TimeUnit.MILLISECONDS) }.getOrNull()
                else -> null
            }
        } finally {
            cancel()
        }

        fun cancel() {
            future.cancel(true)
            executor.shutdownNow()
        }
    }

    private fun requestConnectTicket(
        subscriptionId: String,
        sessionToken: String,
        deviceId: String
    ): PendingConnectTicket {
        val executor = Executors.newSingleThreadExecutor { work ->
            Thread(work, "nivora-connect-ticket").apply { isDaemon = true }
        }
        val deadline = SystemClock.elapsedRealtime() + CONNECT_TICKET_BUDGET_MS
        val future = executor.submit<EphemeralConnectTicket?> {
            runCatching {
                ApiClient(BuildConfig.API_BASE_URL, deviceId).connectTicket(sessionToken, subscriptionId)
            }.getOrNull()
        }
        return PendingConnectTicket(executor, future, deadline)
    }

    private fun convertShareLinks(raw: String): JSONObject {
        val request = JSONObject()
            .put("apiVersion", 1)
            .put("method", "convertShareLinksToXrayJson")
            .put("payload", JSONObject().put("text", raw))
        return JSONObject(LibXray.invoke(request.toString()))
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

    private data class SmartRoute(
        val rule: JSONObject,
        val balancers: JSONArray? = null,
        val label: String? = null,
        val policy: VpnRoutingPolicy
    )

    private fun configureSmartRouting(
        config: JSONObject,
        outbounds: JSONArray,
        remember: Boolean,
        preferredHysteriaIndex: Int? = null,
        forceReality: Boolean = false
    ): SmartRoute {
        val identities = routeIdentities(outbounds)
        val eligibleIndexes = CustomerConnectPolicy.eligibleRouteIndexes(identities, forceReality)
        if (forceReality) {
            // Make excluded legacy Hysteria routes ineligible even if an old
            // subscription label happens to start with the balancer selector.
            identities.indices
                .filterNot(eligibleIndexes::contains)
                .forEach { index -> outbounds.getJSONObject(index).put("tag", "standby-hysteria-$index") }
        }
        val candidates: List<Pair<Int, ServiceEndpoint?>> = buildList {
            for (index in 0 until outbounds.length()) {
                val outbound = outbounds.getJSONObject(index)
                val protocol = outbound.optString("protocol").lowercase()
                if (protocol !in setOf("freedom", "dns", "blackhole") && index in eligibleIndexes) {
                    add(index to endpointFromOutbound(outbound))
                }
            }
        }
        if (candidates.isEmpty()) throw IllegalStateException("SUBSCRIPTION_INVALID")
        val networkKey = currentNetworkKey()
        val memory = SmartRouteMemory(this)
        val remembered = if (remember) memory.read(networkKey) else null
        val signatures = candidates.associate { (index, _) -> index to SmartRouteMemory.signature(outbounds.getJSONObject(index)) }
        val preferredIndex = preferredHysteriaIndex?.takeIf { candidate ->
            candidates.any { (index, _) -> index == candidate }
        }
        val rememberedIndex = remembered?.winner?.let { signature -> signatures.entries.firstOrNull { it.value == signature }?.key }
        // Reuse the winner learned for this exact network immediately. Xray's
        // observatory keeps checking alternatives after startup, so a full
        // pre-flight race on every connection only makes the customer wait.
        val fastest = if (preferredIndex == null && rememberedIndex == null) {
            NetworkTools.fastest(candidates.mapNotNull { it.second }, timeoutMs = 1_200)
        } else null
        val selectedIndex = preferredIndex
            ?: rememberedIndex
            ?: fastest?.let { result -> candidates.firstOrNull { it.second == result.endpoint }?.first }
            ?: candidates.firstOrNull()?.first ?: 0
        val selectedLabel = candidates.firstOrNull { it.first == selectedIndex }
            ?.let { SmartRouteMemory.label(outbounds.getJSONObject(it.first)) }
        val selectedIsHysteria = outboundIsHysteria(outbounds.getJSONObject(selectedIndex))
        val policy = VpnRoutingPolicy.forSession(selectedIsHysteria)
        if (remember) {
            val selectedSignature = signatures[selectedIndex]
            if (selectedSignature != null) {
                val backup = signatures.entries.firstOrNull { it.key != selectedIndex }?.value
                memory.save(networkKey, selectedSignature, remembered?.backup ?: backup)
            }
        }
        // A signed, short-lived ticket is only attached when the network lab
        // has already proved Hysteria2 on this carrier. Keep that transport
        // exclusive for the current session: mixing it into a least-ping
        // balancer can move traffic back to a deceptively low-latency Reality
        // route and also makes UDP/QUIC behaviour unpredictable.
        if (policy.usesExclusiveProxy) {
            candidates.forEach { (index, _) ->
                outbounds.getJSONObject(index).put("tag", if (index == selectedIndex) "proxy" else "standby-route-$index")
            }
            return SmartRoute(
                JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("outboundTag", "proxy"),
                label = selectedLabel,
                policy = policy
            )
        }
        if (candidates.size < 2) {
            outbounds.getJSONObject(selectedIndex).put("tag", "proxy")
            return SmartRoute(
                JSONObject().put("type", "field").put("inboundTag", JSONArray().put("tun-in")).put("outboundTag", "proxy"),
                label = selectedLabel,
                policy = policy
            )
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
            selectedLabel,
            policy
        )
    }

    private fun routeIdentities(outbounds: JSONArray): List<ConvertedRouteIdentity> =
        (0 until outbounds.length()).map { index ->
            val outbound = outbounds.getJSONObject(index)
            val endpoint = endpointFromOutbound(outbound)
            ConvertedRouteIdentity(
                protocol = outbound.optString("protocol"),
                network = outbound.optJSONObject("streamSettings")?.optString("network"),
                host = endpoint?.host,
                port = endpoint?.port,
                security = outbound.optJSONObject("streamSettings")?.optString("security"),
                credentialFingerprint = hysteriaCredentialFingerprint(outbound)
            )
        }

    private fun hysteriaCredentialFingerprint(outbound: JSONObject) =
        if (outboundIsHysteria(outbound)) {
            val streamAuth = outbound.optJSONObject("streamSettings")
                ?.optJSONObject("hysteriaSettings")
                ?.optString("auth")
                .orEmpty()
            // Keep compatibility with early libXray Hysteria JSON while never
            // retaining the raw value in the route identity.
            val legacyAuth = outbound.optJSONObject("hysteriaSettings")
                ?.optString("auth")
                .orEmpty()
            CustomerConnectPolicy.credentialFingerprint(streamAuth.ifEmpty { legacyAuth })
        } else null

    private fun outboundIsHysteria(outbound: JSONObject): Boolean =
        CustomerConnectPolicy.isHysteria(
            outbound.optString("protocol"),
            outbound.optJSONObject("streamSettings")?.optString("network")
        )

    private fun labPrefersHysteria(): Boolean {
        val preferences = getSharedPreferences("neuralmesh_lab", MODE_PRIVATE)
        val operator = preferences.getString("operator", "مخابرات") ?: "مخابرات"
        val capabilities = currentUnderlyingCapabilities()
        val networkType = when {
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi-Fi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Cellular"
            else -> "Other"
        }
        val storageKey = CustomerConnectPolicy.labStorageKey(operator, networkType)
        return CustomerConnectPolicy.prefersHysteria(
            autoSelect = preferences.getBoolean("auto_select", true),
            winnerProfileId = preferences.getString("winner_$storageKey", null)
        )
    }

    private fun currentUnderlyingCapabilities(): NetworkCapabilities? {
        val manager = getSystemService(ConnectivityManager::class.java)
        val network = manager.allNetworks.firstOrNull { candidate ->
            val capabilities = manager.getNetworkCapabilities(candidate) ?: return@firstOrNull false
            !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } ?: manager.activeNetwork
        return network?.let(manager::getNetworkCapabilities)
    }

    private fun currentNetworkKey(): String {
        val capabilities = currentUnderlyingCapabilities()
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
        if (!VpnLifecyclePolicy.isCurrentRun(runId, generation.get())) throw InterruptedException("VPN_STOPPED")
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

    // The partner flavor removes this service from its merged manifest. Lint
    // still analyzes the shared source against that manifest and otherwise
    // reports a false missing foreground-service type for the excluded class.
    @android.annotation.SuppressLint("ForegroundServiceType")
    private fun showNotification(text: String, label: String, connected: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "اتصال امن Nivora", NotificationManager.IMPORTANCE_LOW).apply {
                description = "نمایش وضعیت اتصال VPN"
                setShowBadge(false)
                lightColor = Color.rgb(56, 217, 255)
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
            .setColor(Color.rgb(37, 99, 235))
            .apply { if (connected) addAction(Notification.Action.Builder(null, "قطع اتصال", stop).build()) }
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun stopCore() {
        synchronized(coreLock) {
            stopCoreLocked()
        }
    }

    /**
     * A delayed thread from an older start command must never stop the core
     * owned by a newer generation. The generation decision and native stop are
     * serialized with core startup under the same lock.
     */
    private fun prepareCoreForRun(runId: Int) {
        synchronized(coreLock) {
            ensureCurrent(runId)
            stopCoreLocked()
            ensureCurrent(runId)
        }
    }

    private fun stopCoreLocked() {
        runCatching {
            LibXray.invoke(JSONObject().put("apiVersion", 1).put("method", "stopXray").put("payload", JSONObject()).toString())
        }
        runCatching { LibXray.resetDNS() }
        coreRunning.set(false)
    }

    private fun shutdown(markDisconnected: Boolean) {
        // Closing the TUN first makes a user-requested disconnect immediate,
        // even if the native core takes time to finish its own shutdown.
        val activeTun = synchronized(tunnelLock) {
            tun.also { tun = null }
        }
        runCatching { activeTun?.close() }
        if (markDisconnected) state("disconnected", null)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopCore()
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
