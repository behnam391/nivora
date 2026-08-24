package ir.nivora.app.data

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkToolsTest {
    @Test
    fun readsPlainVlessEndpoint() {
        val raw = "vless://client-id@65.109.184.177:443?security=reality&type=tcp#Nivora"
        assertEquals(ServiceEndpoint("65.109.184.177", 443, transport = "tcp"), NetworkTools.endpointFromSubscription(raw))
    }

    @Test
    fun readsBase64SubscriptionEndpoint() {
        val links = "vless://id@edge.example.com:8443?security=reality#Finland\n"
        val encoded = Base64.getEncoder().encodeToString(links.toByteArray())
        assertEquals(ServiceEndpoint("edge.example.com", 8443, transport = "tcp"), NetworkTools.endpointFromSubscription(encoded))
    }

    @Test
    fun ignoresInvalidSubscription() {
        assertEquals(null, NetworkTools.endpointFromSubscription("not-a-subscription"))
    }

    @Test
    fun readsAllUniqueRoutesFromMultiEndpointSubscription() {
        val raw = """
            vless://id@edge1.nivorali.com:443?security=reality#Route-1
            vless://id@edge2.nivorali.com:8443?security=reality#Route-2
            vless://id@edge1.nivorali.com:443?security=reality#Duplicate
        """.trimIndent()
        assertEquals(
            listOf(ServiceEndpoint("edge1.nivorali.com", 443, transport = "tcp"), ServiceEndpoint("edge2.nivorali.com", 8443, transport = "tcp")),
            NetworkTools.endpointsFromSubscription(raw)
        )
    }

    @Test
    fun readsCloudflareCleanIpWithTlsSni() {
        val raw = "vless://id@104.16.0.1:443?security=tls&type=ws&sni=edge.nivorali.com&host=edge.nivorali.com#Cloudflare"
        assertEquals(
            ServiceEndpoint("104.16.0.1", 443, "edge.nivorali.com", true, "ws"),
            NetworkTools.endpointFromSubscription(raw)
        )
    }

    @Test
    fun keepsUdpRoutesWithoutTreatingThemAsTcp() {
        val raw = "hysteria2://secret@node1.nivorali.com:443?sni=node1.nivorali.com#UDP"
        assertEquals(
            ServiceEndpoint("node1.nivorali.com", 443, "node1.nivorali.com", false, "hysteria2"),
            NetworkTools.endpointFromSubscription(raw)
        )
    }

    @Test
    fun neuralMeshAllowsOnlyExplicitTunnelSchemes() {
        assertEquals(true, isSupportedNeuralMeshProfileUri("hysteria2://secret@node.nivorali.com:7443/?sni=b.nivorali.com"))
        assertEquals(true, isSupportedNeuralMeshProfileUri("vless://id@node.nivorali.com:443?security=reality"))
        assertEquals(false, isSupportedNeuralMeshProfileUri("https://node.nivorali.com:443/profile"))
        assertEquals(false, isSupportedNeuralMeshProfileUri("hysteria2://missing-port.nivorali.com"))
    }
}
