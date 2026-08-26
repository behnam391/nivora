package ir.nivora.app.vpn

import ir.nivora.app.data.VpnConnectionMode
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

    @Test
    fun `activity recreation preserves emergency ownership while connected`() {
        assertEquals(
            VpnConnectionMode.EMERGENCY,
            VpnLifecyclePolicy.restoredMode("emergency", "connected")
        )
        assertEquals(null, VpnLifecyclePolicy.restoredMode("emergency", "disconnected"))
    }

    @Test
    fun `network handoff restarts the same mode and legacy sessions stay primary`() {
        assertEquals(
            VpnConnectionMode.EMERGENCY,
            VpnLifecyclePolicy.restartMode(VpnConnectionMode.EMERGENCY)
        )
        assertEquals(VpnConnectionMode.PRIMARY, VpnLifecyclePolicy.restartMode(null))
    }

    @Test
    fun `one timeout is retried with backoff while the emergency lease is valid`() {
        val initial = VpnLifecyclePolicy.initialEmergencyLease(nowMs = 1_000L)
        val decision = VpnLifecyclePolicy.evaluateEmergencyLease(
            current = initial,
            check = EmergencyLeaseCheck.TRANSIENT_FAILURE,
            nowMs = 91_000L,
            jitterMs = 2_000L
        )

        assertFalse(decision.stop)
        assertEquals(17_000L, decision.nextDelayMs)
        assertEquals(1, decision.state.consecutiveFailures)
        assertEquals(initial.validUntilMs, decision.state.validUntilMs)
    }

    @Test
    fun `temporary failures fail closed only after the three minute grace`() {
        val initial = VpnLifecyclePolicy.initialEmergencyLease(nowMs = 0L)
        val decision = VpnLifecyclePolicy.evaluateEmergencyLease(
            current = initial.copy(consecutiveFailures = 3),
            check = EmergencyLeaseCheck.TRANSIENT_FAILURE,
            nowMs = 180_001L,
            jitterMs = 10_000L
        )

        assertTrue(decision.stop)
        assertEquals(0L, decision.nextDelayMs)
    }

    @Test
    fun `successful lease renews grace and resets transient backoff`() {
        val current = EmergencyLeaseState(validUntilMs = 180_000L, consecutiveFailures = 3)
        val decision = VpnLifecyclePolicy.evaluateEmergencyLease(
            current = current,
            check = EmergencyLeaseCheck.VALID,
            nowMs = 150_000L,
            jitterMs = 5_000L
        )

        assertFalse(decision.stop)
        assertEquals(330_000L, decision.state.validUntilMs)
        assertEquals(0, decision.state.consecutiveFailures)
        assertEquals(95_000L, decision.nextDelayMs)
    }

    @Test
    fun `explicit server denial stops immediately but a stale watchdog cannot stop a newer run`() {
        val decision = VpnLifecyclePolicy.evaluateEmergencyLease(
            current = VpnLifecyclePolicy.initialEmergencyLease(0L),
            check = EmergencyLeaseCheck.DENIED,
            nowMs = 30_000L,
            jitterMs = 0L
        )

        assertTrue(decision.stop)
        assertTrue(VpnLifecyclePolicy.shouldTerminateOwnedRun(runId = 7, currentGeneration = 7, decision))
        assertFalse(VpnLifecyclePolicy.shouldTerminateOwnedRun(runId = 7, currentGeneration = 8, decision))
    }
}
