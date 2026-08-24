package ir.nivora.app.data

import java.net.URI
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

    fun firstHysteriaIndex(routes: List<Pair<String?, String?>>): Int? =
        routes.indexOfFirst { (protocol, network) -> isHysteria(protocol, network) }
            .takeIf { it >= 0 }

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
