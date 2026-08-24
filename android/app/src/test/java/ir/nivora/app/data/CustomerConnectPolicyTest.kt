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
}
