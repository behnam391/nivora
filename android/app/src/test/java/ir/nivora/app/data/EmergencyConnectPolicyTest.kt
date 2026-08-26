package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

class EmergencyConnectPolicyTest {
    private val publicKey = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
    private val vless = "vless://11111111-1111-4111-8111-111111111111@1.1.1.1:443?encryption=none&security=reality&sni=www.cloudflare.com&pbk=$publicKey&flow=xtls-rprx-vision&type=tcp#safe"
    private val hy2 = "hysteria2://token@[2606:4700:4700::1111]:443?sni=www.cloudflare.com#safe-hy2"

    @Test
    fun emergencyEndpointIsFirstPartyOnly() {
        val endpoint = EmergencyConnectPolicy.endpoint("https://b.nivorali.com/")
        assertEquals("https://b.nivorali.com/api/customer/emergency/subscription", endpoint)
        assertEquals("https://b.nivorali.com/api/customer/emergency/lease", EmergencyConnectPolicy.leaseEndpoint("https://b.nivorali.com/"))
        assertTrue(EmergencyConnectPolicy.isFirstParty("https://b.nivorali.com", endpoint))
        assertTrue(EmergencyConnectPolicy.isEmergencyEndpoint("https://b.nivorali.com", endpoint))
        assertFalse(EmergencyConnectPolicy.isFirstParty("https://b.nivorali.com", "https://raw.githubusercontent.com/list"))
        assertFalse(EmergencyConnectPolicy.isFirstParty("https://b.nivorali.com", "https://evil.b.nivorali.com/list"))
        assertFalse(EmergencyConnectPolicy.isFirstParty("https://b.nivorali.com", "http://b.nivorali.com/list"))
        assertFalse(EmergencyConnectPolicy.isEmergencyEndpoint("https://b.nivorali.com", "$endpoint?next=feed"))
        assertFalse(EmergencyConnectPolicy.isEmergencyEndpoint("https://b.nivorali.com", "https://b.nivorali.com/api/customer/emergency/other"))
        assertFalse(EmergencyConnectPolicy.isEmergencyEndpoint("https://b.nivorali.com", "https://user@b.nivorali.com/api/customer/emergency/subscription"))
        try {
            EmergencyConnectPolicy.endpoint("http://b.nivorali.com")
            fail("HTTP emergency endpoint accepted")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }

    @Test
    fun acceptsOnlyPinnedPublicIpRoutesAndSupportedSchemes() {
        val result = EmergencyConnectPolicy.sanitizeBundle(
            listOf(
                vless,
                hy2,
                "trojan://secret@8.8.8.8:443?security=tls&sni=www.google.com",
                "vless://11111111-1111-4111-8111-111111111111@example.com:443?encryption=none&security=reality&sni=example.com&pbk=$publicKey",
                "vless://11111111-1111-4111-8111-111111111111@192.168.1.2:443?encryption=none&security=reality&sni=example.com&pbk=$publicKey",
                "ss://cipher@9.9.9.9:443",
                "vmess://ignored"
            ).joinToString("\n")
        )
        assertTrue(vless in result)
        assertTrue(hy2 in result)
        assertTrue("trojan://" in result)
        assertFalse("example.com:443" in result)
        assertFalse("192.168.1.2" in result)
        assertFalse(result.lines().any { it.startsWith("ss://") })
        assertFalse(result.lines().any { it.startsWith("vmess://") })
    }

    @Test
    fun rejectsEveryCertificateBypassAliasAndDuplicateCriticalParameter() {
        val unsafe = listOf(
            "${hy2.substringBefore('#')}&insecure=1",
            "${hy2.substringBefore('#')}&allow-insecure=true",
            "${hy2.substringBefore('#')}&skip-cert-verify=yes",
            "${hy2.substringBefore('#')}&verify=false",
            "${vless.substringBefore('#')}&security=tls",
            "${vless.substringBefore('#')}&encryption=none"
        )
        unsafe.forEach { link ->
            try {
                EmergencyConnectPolicy.sanitizeBundle(link)
                fail("unsafe route accepted: $link")
            } catch (_: IllegalArgumentException) {
                // Expected: no route survives the policy.
            }
        }
    }

    @Test
    fun rejectsNonPublicAndReservedLiteralEndpoints() {
        val blocked = listOf(
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "[2001:db8::1]",
            "[2001:0db8::1]",
            "[::ffff:127.0.0.1]",
            "[fec0::1]",
            "1.2.evil.3.4"
        )
        blocked.forEach { host -> reject("hysteria2://token@$host:443?sni=www.cloudflare.com") }
        assertTrue(hy2 in EmergencyConnectPolicy.sanitizeBundle(hy2))
    }

    @Test
    fun validatesTrojanTlsAndVlessRealityIdentity() {
        reject("trojan://secret@8.8.8.8:443?sni=www.google.com")
        reject("trojan://secret@8.8.8.8:443?security=reality&sni=www.google.com")
        reject("vless://not-a-uuid@1.1.1.1:443?encryption=none&security=reality&sni=www.cloudflare.com&pbk=$publicKey")
        reject("vless://11111111-1111-4111-8111-111111111111@1.1.1.1:443?encryption=none&security=reality&sni=www.cloudflare.com&pbk=short")
        reject("vless://11111111-1111-4111-8111-111111111111@1.1.1.1:443?encryption=none&security=reality&sni=www.cloudflare.com&pbk=$publicKey&flow=invalid")
    }

    @Test
    fun decodesBase64DeduplicatesAndCapsThePool() {
        val routes = (1..14).map { index ->
            "vless://11111111-1111-4111-8111-${index.toString().padStart(12, '0')}@8.8.8.${(index % 200) + 1}:443?encryption=none&security=reality&sni=www.google.com&pbk=$publicKey&flow=xtls-rprx-vision"
        }
        val encoded = Base64.getEncoder().encodeToString((routes + routes.first()).joinToString("\n").toByteArray())
        val result = EmergencyConnectPolicy.sanitizeBundle(encoded).lines()
        assertEquals(EmergencyConnectPolicy.MAX_ROUTES, result.size)
        assertEquals(result.size, result.distinct().size)
    }

    @Test
    fun rejectsOversizedBundleBeforeParsing() {
        reject(vless + "x".repeat(EmergencyConnectPolicy.MAX_BUNDLE_CHARS))
    }

    @Test
    fun convertedOutboundsRequirePublicIpSecureTransportAndNoBypass() {
        assertTrue(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("vless", "tcp", "reality", "1.1.1.1", 443, false)
            )
        )
        assertTrue(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("hysteria2", "hysteria2", "tls", "2606:4700:4700::1111", 443, false)
            )
        )
        assertFalse(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("vless", "tcp", "none", "1.1.1.1", 443, false)
            )
        )
        assertFalse(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("trojan", "tcp", "tls", "10.0.0.2", 443, false)
            )
        )
        assertFalse(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("hysteria2", "hysteria2", "tls", "1.1.1.1", 443, true)
            )
        )
        assertFalse(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("freedom", null, null, null, null, false)
            )
        )
        assertFalse(
            EmergencyConnectPolicy.isAllowedConvertedRoute(
                EmergencyConvertedRoute("vless", "tcp", "reality", "2001:db8::1", 443, false)
            )
        )
    }

    @Test
    fun connectionModeRoundTripsWithoutFallingBackToEmergency() {
        assertEquals(VpnConnectionMode.PRIMARY, VpnConnectionMode.fromWire("primary"))
        assertEquals(VpnConnectionMode.EMERGENCY, VpnConnectionMode.fromWire("emergency"))
        assertEquals(null, VpnConnectionMode.fromWire("unknown"))
    }

    @Test
    fun dashboardKillSwitchStopsOnlyAnActiveEmergencySession() {
        val ready = EmergencyAvailability(enabled = true, ready = true, nodeCount = 1)
        val disabled = EmergencyAvailability(enabled = false, ready = false, nodeCount = 0)
        assertTrue(EmergencyConnectPolicy.shouldStopAfterDashboard(VpnConnectionMode.EMERGENCY, "connected", disabled))
        assertTrue(EmergencyConnectPolicy.shouldStopAfterDashboard(VpnConnectionMode.EMERGENCY, "connecting", disabled))
        assertFalse(EmergencyConnectPolicy.shouldStopAfterDashboard(VpnConnectionMode.EMERGENCY, "connected", ready))
        assertFalse(EmergencyConnectPolicy.shouldStopAfterDashboard(VpnConnectionMode.PRIMARY, "connected", disabled))
        assertFalse(EmergencyConnectPolicy.shouldStopAfterDashboard(VpnConnectionMode.EMERGENCY, "disconnected", disabled))
    }

    @Test
    fun emergencyHealthGateUsesFiveThenAtMostThreeRoutes() {
        assertEquals(listOf(0, 1, 2, 3, 4), EmergencyRouteHealthPolicy.firstBatchIndexes(8))
        assertEquals(
            listOf(5, 6, 7),
            EmergencyRouteHealthPolicy.fallbackBatchIndexes(routeCount = 12, firstBatchWorking = emptyList())
        )
        assertTrue(
            EmergencyRouteHealthPolicy.fallbackBatchIndexes(routeCount = 8, firstBatchWorking = listOf(2)).isEmpty()
        )
    }

    @Test
    fun emergencyHealthGateKeepsOnlySuccessfulRoutesOrderedByRealDelay() {
        val selected = EmergencyRouteHealthPolicy.successfulIndexes(
            batchIndexes = listOf(0, 1, 2, 3),
            results = listOf(
                EmergencyRouteHealth(success = false, delayMs = 10_000L),
                EmergencyRouteHealth(success = true, delayMs = 310L),
                EmergencyRouteHealth(success = true, delayMs = 95L),
                EmergencyRouteHealth(success = true, delayMs = -1L)
            )
        )

        assertEquals(listOf(2, 1), selected)
        assertTrue(
            EmergencyRouteHealthPolicy.successfulIndexes(
                batchIndexes = listOf(5, 6),
                results = listOf(EmergencyRouteHealth(success = false, delayMs = 11_000L))
            ).isEmpty()
        )
    }

    private fun reject(value: String) {
        try {
            EmergencyConnectPolicy.sanitizeBundle(value)
            fail("unsafe emergency bundle accepted")
        } catch (_: IllegalArgumentException) {
            // Expected: no route survives the policy.
        }
    }
}
