package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class CustomerConnectPolicyTest {
    private val now = 1_800_000_000_000L
    private val ticket = EphemeralConnectTicket(
        routeId = "de-hy2",
        uri = "hysteria2://temporary-token@example.com:7443/?sni=example.com",
        expiresAtEpochMs = now + 45_000L
    )

    private fun route(
        protocol: String,
        network: String?,
        host: String,
        port: Int,
        auth: String? = null,
        security: String? = null
    ) = ConvertedRouteIdentity(
        protocol = protocol,
        network = network,
        host = host,
        port = port,
        security = security,
        credentialFingerprint = CustomerConnectPolicy.credentialFingerprint(auth)
    )

    @Test
    fun acceptsAnyServerApprovedRouteIdWithoutHardcodingLocation() {
        assertTrue(CustomerConnectPolicy.isUsable(ticket, now))
        assertFalse(CustomerConnectPolicy.isUsable(ticket.copy(routeId = "bad route"), now))
    }

    @Test
    fun ticketExistsOnlyInTheInMemoryConnectionBundle() {
        val base = "vless://customer@example.net:443?security=reality"
        val encoded = Base64.getEncoder().encodeToString(base.toByteArray())
        val result = CustomerConnectPolicy.attachTicket(encoded, ticket, now)
        assertTrue(result.ticketAttached)
        assertTrue(result.raw.startsWith(ticket.uri + "\n"))
        assertTrue(result.raw.endsWith(base))
    }

    @Test
    fun expiredTicketFallsBackToTheOriginalSubscriptionUnchanged() {
        val base = "vless://customer@example.net:443?security=reality"
        val result = CustomerConnectPolicy.attachTicket(base, ticket.copy(expiresAtEpochMs = now + 1_000L), now)
        assertFalse(result.ticketAttached)
        assertEquals(base, result.raw)
    }

    @Test
    fun freshTicketSelectsItsExactNodeInsteadOfAnOlderHysteriaRoute() {
        val routes = listOf(
            route("hysteria2", null, "old.example.com", 7443, "old-token"),
            route("vless", "tcp", "reality.example.com", 443),
            route("hysteria2", null, "example.com", 7443, "temporary-token")
        )

        assertEquals(2, CustomerConnectPolicy.matchingTicketRouteIndex(ticket, routes))
    }

    @Test
    fun missingTicketNodeDoesNotFallBackToTheFirstHysteriaRoute() {
        val routes = listOf(
            route("hysteria2", null, "old.example.com", 7443, "old-token"),
            route("vless", "tcp", "reality.example.com", 443)
        )

        assertEquals(null, CustomerConnectPolicy.matchingTicketRouteIndex(ticket, routes))
    }

    @Test
    fun sameEndpointWithStaleCredentialCannotImpersonateFreshTicketRoute() {
        val routes = listOf(
            route("hysteria2", null, "example.com", 7443, "expired-token"),
            route("hysteria2", null, "example.com", 7443, "temporary-token")
        )

        assertEquals(1, CustomerConnectPolicy.matchingTicketRouteIndex(ticket, routes))
        assertEquals(
            null,
            CustomerConnectPolicy.matchingTicketRouteIndex(ticket, routes.take(1))
        )
    }

    @Test
    fun forcedRealityFallbackExcludesEveryOldHysteriaCandidate() {
        val routes = listOf(
            route("hysteria2", null, "old-a.example.com", 7443, "old-a"),
            route("vless", "tcp", "reality-a.example.com", 443, security = "reality"),
            route("hysteria", "hysteria", "old-b.example.com", 8443, "old-b"),
            route("vmess", "ws", "legacy.example.com", 443, security = "tls"),
            route("vless", "xhttp", "reality-b.example.com", 443, security = "REALITY")
        )

        assertEquals(setOf(1, 4), CustomerConnectPolicy.eligibleRouteIndexes(routes, forceReality = true))
        assertEquals(setOf(0, 1, 2, 3, 4), CustomerConnectPolicy.eligibleRouteIndexes(routes, forceReality = false))
    }
}
