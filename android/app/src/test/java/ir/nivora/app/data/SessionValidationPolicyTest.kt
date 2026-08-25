package ir.nivora.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletionException

class SessionValidationPolicyTest {
    @Test
    fun `only the captured active token may update the dashboard`() {
        assertTrue(SessionValidationPolicy.isCurrent("token-a", "token-a"))
        assertFalse(SessionValidationPolicy.isCurrent("token-a", "token-b"))
        assertFalse(SessionValidationPolicy.isCurrent("token-a", null))
    }

    @Test
    fun `cached dashboard alone never authorizes vpn startup`() {
        assertFalse(SessionValidationPolicy.canStartVpn(signedIn = true, liveSessionValidated = false))
        assertFalse(SessionValidationPolicy.canStartVpn(signedIn = false, liveSessionValidated = true))
        assertTrue(SessionValidationPolicy.canStartVpn(signedIn = true, liveSessionValidated = true))
    }

    @Test
    fun `unauthorized remains detectable through async wrapper exceptions`() {
        val wrapped = CompletionException(ApiException("UNAUTHORIZED", 401))
        assertTrue(SessionValidationPolicy.isUnauthorized(wrapped))
        assertFalse(SessionValidationPolicy.isUnauthorized(CompletionException(ApiException("RATE_LIMITED", 429))))
    }
}
