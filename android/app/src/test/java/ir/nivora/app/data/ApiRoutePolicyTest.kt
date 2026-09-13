package ir.nivora.app.data

import org.junit.Assert.*
import org.junit.Test

class ApiRoutePolicyTest {
    @Test fun `only trusted production hosts get a backup`() {
        assertEquals(2, ApiRoutePolicy.origins("https://api.nivorali.com/").size)
        assertEquals(listOf("https://example.com"), ApiRoutePolicy.origins("https://example.com"))
        assertEquals(1, ApiRoutePolicy.origins("http://api.nivorali.com").size)
    }
    @Test fun `payments and mutations are never replayed`() {
        assertFalse(ApiRoutePolicy.canRetry("/api/customer/wallet/purchase", "POST"))
        assertFalse(ApiRoutePolicy.canRetry("/api/customer/profile", "PATCH"))
        assertTrue(ApiRoutePolicy.canRetry("/api/customer/connection-ready", "POST"))
        assertTrue(ApiRoutePolicy.canRetry("/api/customer/device/bind", "POST"))
        assertTrue(ApiRoutePolicy.canRetry("/api/customer/account", "GET"))
    }
}
