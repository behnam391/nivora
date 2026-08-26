package ir.nivora.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BiometricGatePolicyTest {
    @Test
    fun `gate requires an opted-in customer session`() {
        assertTrue(BiometricGatePolicy.shouldGate("customer", hasSession = true, enabled = true))
        assertFalse(BiometricGatePolicy.shouldGate("customer", hasSession = false, enabled = true))
        assertFalse(BiometricGatePolicy.shouldGate("customer", hasSession = true, enabled = false))
        assertFalse(BiometricGatePolicy.shouldGate("partner", hasSession = true, enabled = true))
    }

    @Test
    fun `system prompt and configuration changes do not relock the app`() {
        assertFalse(BiometricGatePolicy.shouldRelock("customer", true, true, promptActive = true, changingConfigurations = false))
        assertFalse(BiometricGatePolicy.shouldRelock("customer", true, true, promptActive = false, changingConfigurations = true))
        assertTrue(BiometricGatePolicy.shouldRelock("customer", true, true, promptActive = false, changingConfigurations = false))
    }
}
