package ir.nivora.app.data

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkToolsTest {
    @Test
    fun readsPlainVlessEndpoint() {
        val raw = "vless://client-id@65.109.184.177:443?security=reality&type=tcp#Nivora"
        assertEquals(ServiceEndpoint("65.109.184.177", 443), NetworkTools.endpointFromSubscription(raw))
    }

    @Test
    fun readsBase64SubscriptionEndpoint() {
        val links = "vless://id@edge.example.com:8443?security=reality#Finland\n"
        val encoded = Base64.getEncoder().encodeToString(links.toByteArray())
        assertEquals(ServiceEndpoint("edge.example.com", 8443), NetworkTools.endpointFromSubscription(encoded))
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
            listOf(ServiceEndpoint("edge1.nivorali.com", 443), ServiceEndpoint("edge2.nivorali.com", 8443)),
            NetworkTools.endpointsFromSubscription(raw)
        )
    }
}
