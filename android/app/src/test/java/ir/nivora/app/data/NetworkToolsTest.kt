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
}
