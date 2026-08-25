package ir.nivora.app.data

import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

/**
 * A short-lived route credential returned for one customer connection.
 *
 * The URI deliberately has no persistence helper: callers may keep it in the
 * connection stack only and must continue caching the ordinary subscription
 * bundle without it.
 */
internal data class EphemeralConnectTicket(
    val routeId: String,
    val uri: String,
    val expiresAtEpochMs: Long
)

internal data class EphemeralSubscriptionBundle(
    val raw: String,
    val ticketAttached: Boolean
)

internal data class ConvertedRouteIdentity(
    val protocol: String?,
    val network: String?,
    val host: String?,
    val port: Int?,
    val security: String? = null,
    val credentialFingerprint: RouteCredentialFingerprint? = null
)

/**
 * One-way, in-memory representation of a route credential. Its string form is
 * deliberately redacted so an identity can never reveal an auth token through
 * incidental diagnostics or exception formatting.
 */
internal class RouteCredentialFingerprint private constructor(private val digest: ByteArray) {
    fun matches(other: RouteCredentialFingerprint?): Boolean =
        other != null && MessageDigest.isEqual(digest, other.digest)

    override fun toString(): String = "RouteCredentialFingerprint([REDACTED])"

    companion object {
        fun fromSecret(secret: String?): RouteCredentialFingerprint? {
            if (secret.isNullOrEmpty()) return null
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(secret.toByteArray(Charsets.UTF_8))
            return RouteCredentialFingerprint(digest)
        }
    }
}

internal object CustomerConnectPolicy {
    const val CONNECT_ROUTE_ID = "auto"
    const val LAB_HYSTERIA_PROFILE_ID = "hysteria2-turbo-7443"

    private const val MAX_TICKET_URI_CHARS = 8_192
    private const val MIN_TICKET_LIFETIME_MS = 2_000L

    fun labStorageKey(operator: String, networkType: String): String = "${operator}_${networkType}"

    fun prefersHysteria(autoSelect: Boolean, winnerProfileId: String?): Boolean =
        autoSelect && winnerProfileId == LAB_HYSTERIA_PROFILE_ID

    fun expiryEpochMs(value: Any?): Long? = when (value) {
        is Number -> value.toLong().takeIf { it > 0L }
        is String -> runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    }

    fun isUsable(ticket: EphemeralConnectTicket, nowMs: Long): Boolean {
        if (!Regex("^[A-Za-z0-9_.-]{2,80}$").matches(ticket.routeId)) return false
        if (ticket.expiresAtEpochMs <= nowMs + MIN_TICKET_LIFETIME_MS) return false
        if (ticket.uri.length !in 1..MAX_TICKET_URI_CHARS || '\n' in ticket.uri || '\r' in ticket.uri) return false
        return runCatching {
            val parsed = URI(ticket.uri)
            parsed.scheme?.lowercase() in setOf("hysteria2", "hy2") &&
                !parsed.rawUserInfo.isNullOrBlank() &&
                !parsed.host.isNullOrBlank() &&
                parsed.port in 1..65_535
        }.getOrDefault(false)
    }

    /**
     * Prepends a usable HY2 ticket so libXray preserves it as the first
     * outbound. If the stored subscription is base64, decode it only in memory
     * before composing the per-connection bundle.
     */
    fun attachTicket(
        baseBundle: String,
        ticket: EphemeralConnectTicket?,
        nowMs: Long
    ): EphemeralSubscriptionBundle {
        if (ticket == null || !isUsable(ticket, nowMs)) {
            return EphemeralSubscriptionBundle(baseBundle, ticketAttached = false)
        }
        val normalizedBase = decodedSubscriptionOrOriginal(baseBundle)
        return EphemeralSubscriptionBundle(
            raw = "${ticket.uri}\n$normalizedBase",
            ticketAttached = true
        )
    }

    fun isHysteria(protocol: String?, network: String?): Boolean =
        protocol.orEmpty().lowercase() in setOf("hysteria", "hysteria2", "hy2") ||
            network.orEmpty().lowercase() in setOf("hysteria", "hysteria2", "hy2")

    fun isReality(route: ConvertedRouteIdentity): Boolean =
        route.security.orEmpty().equals("reality", ignoreCase = true)

    fun firstHysteriaIndex(routes: List<Pair<String?, String?>>): Int? =
        routes.indexOfFirst { (protocol, network) -> isHysteria(protocol, network) }
            .takeIf { it >= 0 }

    fun credentialFingerprint(secret: String?): RouteCredentialFingerprint? =
        RouteCredentialFingerprint.fromSecret(secret)

    /**
     * A failed fresh-ticket conversion is a verified Reality-only fallback.
     * Filtering happens before remembered/latency selection so neither an old
     * Hysteria route nor another legacy transport can silently win the session.
     */
    fun eligibleRouteIndexes(
        routes: List<ConvertedRouteIdentity>,
        forceReality: Boolean
    ): Set<Int> = routes.indices.filterTo(linkedSetOf<Int>()) { index ->
        !forceReality || isReality(routes[index])
    }

    /**
     * Match the freshly issued ticket to its converted outbound. Selecting the
     * first Hysteria route is unsafe once a subscription contains an older HY2
     * entry for another node.
     */
    fun matchingTicketRouteIndex(
        ticket: EphemeralConnectTicket?,
        routes: List<ConvertedRouteIdentity>
    ): Int? {
        if (ticket == null) return null
        val uri = runCatching { URI(ticket.uri) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() !in setOf("hysteria2", "hy2")) return null
        val expectedHost = uri.host?.lowercase() ?: return null
        val expectedPort = uri.port.takeIf { it in 1..65_535 } ?: return null
        // URI.userInfo is percent-decoded, matching the auth string emitted in
        // Xray's converted streamSettings.hysteriaSettings object.
        val expectedCredential = credentialFingerprint(uri.userInfo) ?: return null
        return routes.indexOfFirst { route ->
            isHysteria(route.protocol, route.network) &&
                route.host?.lowercase() == expectedHost &&
                route.port == expectedPort &&
                expectedCredential.matches(route.credentialFingerprint)
        }.takeIf { it >= 0 }
    }

    private fun decodedSubscriptionOrOriginal(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.contains("://")) return trimmed
        val compact = trimmed.replace(Regex("\\s+"), "")
        if (compact.isEmpty()) return raw
        val decoded = sequenceOf(Base64.getDecoder(), Base64.getUrlDecoder())
            .mapNotNull { decoder ->
                runCatching { String(decoder.decode(compact), Charsets.UTF_8) }.getOrNull()
            }
            .firstOrNull { it.contains("://") }
        return decoded?.trim() ?: raw
    }
}
