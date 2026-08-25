package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnRoutingPolicyTest {
    @Test
    fun hysteriaSessionIsExclusiveAndKeepsUdp443Available() {
        val policy = VpnRoutingPolicy.forSession(hysteriaSelected = true)

        assertEquals(VpnRoutingPolicy.PrimaryTransport.HYSTERIA2, policy.primaryTransport)
        assertTrue(policy.usesExclusiveProxy)
        assertFalse(policy.allowsSmartBalancer)
        assertFalse(policy.rejectUdp443)
    }

    @Test
    fun realityOnlySessionRejectsQuicAndAllowsSmartBalancing() {
        val policy = VpnRoutingPolicy.forSession(hysteriaSelected = false)

        assertEquals(VpnRoutingPolicy.PrimaryTransport.REALITY, policy.primaryTransport)
        assertFalse(policy.usesExclusiveProxy)
        assertTrue(policy.allowsSmartBalancer)
        assertTrue(policy.rejectUdp443)
    }
}
