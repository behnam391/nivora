package ir.nivora.app.vpn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnLifecyclePolicyTest {
    @Test
    fun `stale connection generation cannot mutate the active core`() {
        assertFalse(VpnLifecyclePolicy.isCurrentRun(runId = 7, currentGeneration = 8))
        assertTrue(VpnLifecyclePolicy.isCurrentRun(runId = 8, currentGeneration = 8))
    }

    @Test
    fun `manual disconnect never triggers an automatic restart`() {
        assertFalse(
            VpnLifecyclePolicy.shouldRestartAfterNetworkChange(
                previousNetwork = "wifi",
                currentNetwork = "cellular",
                vpnState = "connected",
                manualDisconnectRequested = true,
                lastRestartAtMs = 0L,
                nowMs = 10_000L
            )
        )
    }

    @Test
    fun `real network handoff restarts a connected tunnel after debounce`() {
        assertTrue(
            VpnLifecyclePolicy.shouldRestartAfterNetworkChange(
                previousNetwork = "wifi",
                currentNetwork = "cellular",
                vpnState = "connected",
                manualDisconnectRequested = false,
                lastRestartAtMs = 0L,
                nowMs = 10_000L
            )
        )
    }

    @Test
    fun `stale persisted connection state is corrected without loading the native core`() {
        assertEquals(
            "disconnected",
            VpnLifecyclePolicy.initialState("connected", coreRunning = false, connectionAttemptActive = false)
        )
        assertEquals(
            "connected",
            VpnLifecyclePolicy.initialState("connected", coreRunning = true, connectionAttemptActive = false)
        )
    }

    @Test
    fun `activity recreation preserves a live connecting attempt`() {
        assertEquals(
            "connecting",
            VpnLifecyclePolicy.initialState("connecting", coreRunning = false, connectionAttemptActive = true)
        )
        assertEquals(
            "disconnected",
            VpnLifecyclePolicy.initialState("connecting", coreRunning = false, connectionAttemptActive = false)
        )
    }
}
