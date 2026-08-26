package ir.nivora.app.data

import java.net.URI
import java.net.URLDecoder
import java.net.Inet6Address
import java.net.InetAddress
import java.util.Base64

/** Identifies the owner of the currently running VPN session. */
enum class VpnConnectionMode(val wireValue: String) {
    PRIMARY("primary"),
    EMERGENCY("emergency");

    companion object {
        fun fromWire(value: String?): VpnConnectionMode? =
            values().firstOrNull { it.wireValue == value?.trim()?.lowercase() }
    }
}

data class EmergencyConvertedRoute(
    val protocol: String?,
    val network: String?,
    val security: String?,
    val host: String?,
    val port: Int?,
    val allowInsecure: Boolean
)

data class EmergencyRouteHealth(
    val success: Boolean,
    val delayMs: Long
)

object EmergencyRouteHealthPolicy {
    const val FIRST_BATCH_SIZE = 5
    const val FALLBACK_BATCH_SIZE = 3

    fun firstBatchIndexes(routeCount: Int): List<Int> =
        (0 until routeCount.coerceAtLeast(0).coerceAtMost(FIRST_BATCH_SIZE)).toList()

    fun fallbackBatchIndexes(routeCount: Int, firstBatchWorking: List<Int>): List<Int> {
        if (firstBatchWorking.isNotEmpty()) return emptyList()
        val end = routeCount.coerceAtLeast(0).coerceAtMost(FIRST_BATCH_SIZE + FALLBACK_BATCH_SIZE)
        return (FIRST_BATCH_SIZE until end).toList()
    }

    fun successfulIndexes(batchIndexes: List<Int>, results: List<EmergencyRouteHealth>): List<Int> =
        batchIndexes.zip(results)
            .filter { (_, health) -> health.success && health.delayMs >= 0L }
            .sortedBy { (_, health) -> health.delayMs }
            .map { (index, _) -> index }
}

/**
 * Defence-in-depth for the short-lived, server-curated emergency pool.
 *
 * The backend remains responsible for probing and ranking public routes. The
 * app independently caps and validates the received bundle so a compromised
 * feed cannot create hundreds of observatory workers, disable TLS validation,
 * or point the VPN core at a private address.
 */
object EmergencyConnectPolicy {
    const val ENDPOINT_PATH = "/api/customer/emergency/subscription"
    const val LEASE_PATH = "/api/customer/emergency/lease"
    const val MAX_ROUTES = 8
    const val MAX_BUNDLE_CHARS = 256_000
    const val MAX_BUNDLE_BYTES = 256_000
    private const val MAX_LINK_CHARS = 8_192

    private val supportedSchemes = setOf("vless", "trojan", "hysteria2", "hy2")
    private val unsafeKeys = setOf("allowinsecure", "insecure", "skipcertverify", "tlsinsecure")
    private val criticalKeys = unsafeKeys + setOf("security", "sni", "peer", "servername", "verify", "pbk", "type", "flow", "encryption")
    private val vlessIdentity = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
    private val realityPublicKey = Regex("^[A-Za-z0-9_-]{43}$")
    private val allowedVlessTransports = setOf("tcp", "grpc", "ws", "xhttp", "splithttp", "httpupgrade")
    private val allowedEndpointPorts = setOf(80, 443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443, 8880)

    fun endpoint(baseUrl: String): String {
        val base = URI(baseUrl.trim().trimEnd('/'))
        require(base.scheme.equals("https", ignoreCase = true) && !base.host.isNullOrBlank()) {
            "EMERGENCY_BASE_URL"
        }
        return baseUrl.trim().trimEnd('/') + ENDPOINT_PATH
    }

    fun leaseEndpoint(baseUrl: String): String {
        endpoint(baseUrl)
        return baseUrl.trim().trimEnd('/') + LEASE_PATH
    }

    /** Authorization and device headers may only be attached to this origin. */
    fun isFirstParty(baseUrl: String, candidateUrl: String): Boolean = runCatching {
        val base = URI(baseUrl.trim())
        val candidate = URI(candidateUrl.trim())
        base.scheme.equals(candidate.scheme, ignoreCase = true) &&
            base.host.equals(candidate.host, ignoreCase = true) &&
            effectivePort(base) == effectivePort(candidate)
    }.getOrDefault(false)

    fun isEmergencyEndpoint(baseUrl: String, candidateUrl: String): Boolean = runCatching {
        val candidate = URI(candidateUrl.trim())
        candidate.scheme.equals("https", ignoreCase = true) &&
            isFirstParty(baseUrl, candidateUrl) && candidate.rawPath == ENDPOINT_PATH &&
            candidate.rawQuery == null && candidate.rawFragment == null && candidate.rawUserInfo == null
    }.getOrDefault(false)

    fun shouldStopAfterDashboard(
        mode: VpnConnectionMode?,
        vpnState: String,
        availability: EmergencyAvailability
    ): Boolean = mode == VpnConnectionMode.EMERGENCY &&
        vpnState in setOf("connecting", "connected") && !availability.available

    fun sanitizeBundle(raw: String): String {
        require(raw.isNotBlank() && raw.length <= MAX_BUNDLE_CHARS) { "EMERGENCY_BUNDLE_INVALID" }
        val decoded = decodedSubscriptionOrOriginal(raw)
        val routes = decoded.lineSequence()
            .map(String::trim)
            .filter { it.isNotBlank() && !it.startsWith('#') }
            .filter { it.length <= MAX_LINK_CHARS }
            .filter(::isAllowedShareLink)
            .distinct()
            .take(MAX_ROUTES)
            .toList()
        require(routes.isNotEmpty()) { "EMERGENCY_NO_SAFE_ROUTE" }
        return routes.joinToString("\n")
    }

    fun isAllowedConvertedRoute(route: EmergencyConvertedRoute): Boolean {
        if (route.allowInsecure || route.port !in allowedEndpointPorts || !isPublicLiteral(route.host)) return false
        val protocol = route.protocol.orEmpty().lowercase()
        val network = route.network.orEmpty().lowercase()
        val security = route.security.orEmpty().lowercase()
        // libXray 26.x can expose a Hysteria2 URI through the legacy
        // "hysteria" outbound/network name after conversion. Raw input never
        // accepts that legacy URI scheme; this alias is conversion-only.
        val hysteria = protocol in setOf("hysteria", "hysteria2", "hy2") ||
            network in setOf("hysteria", "hysteria2", "hy2")
        return when {
            hysteria -> true
            protocol == "vless" -> security in setOf("tls", "reality")
            protocol == "trojan" -> security == "tls"
            else -> false
        }
    }

    private fun isAllowedShareLink(link: String): Boolean = runCatching {
        val scheme = link.substringBefore("://", "").lowercase()
        if (scheme !in supportedSchemes) return false
        val uri = URI(link)
        if (!isPublicLiteral(uri.host) || uri.port !in allowedEndpointPorts) return false
        val query = query(uri)
        if (query.hasDuplicateCriticalKey || query.hasUnsafeSetting) return false
        val sni = query.values["sni"].orEmpty()
        when (scheme) {
            "vless" -> {
                val identity = runCatching {
                    URLDecoder.decode(uri.rawUserInfo.orEmpty(), Charsets.UTF_8.name())
                }.getOrNull() ?: return false
                val security = query.values["security"].orEmpty().lowercase()
                val encryption = query.values["encryption"].orEmpty().ifBlank { "none" }.lowercase()
                val flow = query.values["flow"].orEmpty().lowercase()
                val transport = query.values["type"].orEmpty().ifBlank { "tcp" }.lowercase()
                vlessIdentity.matches(identity) && encryption == "none" &&
                    security in setOf("tls", "reality") &&
                    (sni.isBlank() || isSafeServerName(sni)) &&
                    (security != "reality" ||
                        (isSafeServerName(sni) && realityPublicKey.matches(query.values["pbk"].orEmpty()))) &&
                    (flow.isBlank() || flow == "xtls-rprx-vision") &&
                    transport in allowedVlessTransports
            }
            "trojan" -> query.values["security"].orEmpty().lowercase() == "tls" && isSafeServerName(sni)
            else -> isSafeServerName(sni)
        }
    }.getOrDefault(false)

    private fun decodedSubscriptionOrOriginal(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.lineSequence().any { "://" in it }) return trimmed
        val compact = trimmed.replace(Regex("\\s+"), "")
        val decoded = decodeBase64(compact)?.let { String(it, Charsets.UTF_8) }
        return decoded?.takeIf { it.contains("://") }?.trim() ?: trimmed
    }

    private fun decodeBase64(value: String): ByteArray? {
        val padded = value + "=".repeat((4 - value.length % 4) % 4)
        return sequenceOf(Base64.getDecoder(), Base64.getUrlDecoder())
            .mapNotNull { decoder -> runCatching { decoder.decode(padded) }.getOrNull() }
            .firstOrNull()
    }

    private data class ParsedQuery(
        val values: Map<String, String>,
        val hasDuplicateCriticalKey: Boolean,
        val hasUnsafeSetting: Boolean
    )

    private fun query(uri: URI): ParsedQuery {
        val pairs = uri.rawQuery.orEmpty().split('&').filter(String::isNotBlank).map { part ->
            val pair = part.split('=', limit = 2)
            normalizedKey(URLDecoder.decode(pair.first(), Charsets.UTF_8.name())) to
                URLDecoder.decode(pair.getOrElse(1) { "" }, Charsets.UTF_8.name())
        }
        val grouped = pairs.groupBy { it.first }
        val duplicate = grouped.any { (key, values) -> key in criticalKeys && values.size > 1 }
        val unsafe = pairs.any { (key, value) ->
            key.isBlank() || key.length > 80 || value.length > 2_048 ||
                value.any { it.code <= 31 || it.code == 127 } ||
            (key in unsafeKeys && value.trim().lowercase() in setOf("1", "true", "yes", "on")) ||
                (key == "verify" && value.trim().lowercase() in setOf("0", "false", "no", "off"))
        }
        return ParsedQuery(pairs.associate { it }, duplicate, unsafe)
    }

    private fun normalizedKey(value: String): String = value.trim().lowercase().replace("-", "").replace("_", "")

    private fun isSafeServerName(value: String): Boolean {
        val host = value.trim().lowercase()
        if (host.isBlank() || host.length > 253 || host.any { it.code <= 31 || it.code == 127 }) return false
        if (host.endsWith('.')) return false
        if (isPublicLiteral(host)) return true
        if (!host.contains('.') || host == "localhost" || host.endsWith(".localhost") ||
            host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") ||
            host.endsWith(".home.arpa") || host.contains("..")
        ) return false
        return host.matches(Regex("^[a-z0-9.-]+$"))
    }

    private fun effectivePort(uri: URI): Int = when {
        uri.port > 0 -> uri.port
        uri.scheme.equals("https", true) -> 443
        uri.scheme.equals("http", true) -> 80
        else -> -1
    }

    private fun isPublicLiteral(value: String?): Boolean {
        val host = value?.trim()?.trim('[', ']')?.lowercase().orEmpty()
        if (host.isBlank() || host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
            host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")
        ) return false
        val ipv4Parts = host.split('.')
        if (ipv4Parts.size == 4) {
            val ipv4 = ipv4Parts.map { it.toIntOrNull() ?: return false }
            if (!ipv4.all { it in 0..255 }) return false
            val (a, b) = ipv4
            return !(a == 0 || a == 10 || a == 127 || a >= 224 ||
                (a == 100 && b in 64..127) || (a == 169 && b == 254) ||
                (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
                (a == 192 && b == 0) || (a == 192 && b == 2) ||
                (a == 192 && b == 88 && ipv4[2] == 99) ||
                (a == 198 && b in 18..19) || (a == 198 && b == 51 && ipv4[2] == 100) ||
                (a == 203 && b == 0 && ipv4[2] == 113))
        }
        if (':' in host) {
            if (host.startsWith("::ffff:")) return false
            if (!host.matches(Regex("^[0-9a-f:.]+$"))) return false
            val address = runCatching { InetAddress.getByName(host) }.getOrNull() as? Inet6Address ?: return false
            val bytes = address.address
            val uniqueLocal = (bytes[0].toInt() and 0xfe) == 0xfc
            val documentation = (bytes[0].toInt() and 0xff) == 0x20 &&
                (bytes[1].toInt() and 0xff) == 0x01 && (bytes[2].toInt() and 0xff) == 0x0d &&
                (bytes[3].toInt() and 0xff) == 0xb8
            return !(address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
                address.isSiteLocalAddress || address.isMulticastAddress || uniqueLocal || documentation)
        }
        return false
    }
}
