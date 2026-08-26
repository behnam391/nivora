package ir.nivora.app.vpn

import ir.nivora.app.data.VpnConnectionMode
import kotlin.math.min

internal enum class EmergencyLeaseCheck {
    VALID,
    DENIED,
    TRANSIENT_FAILURE
}

internal data class EmergencyLeaseState(
    val validUntilMs: Long,
    val consecutiveFailures: Int = 0
)

internal data class EmergencyLeaseDecision(
    val state: EmergencyLeaseState,
    val stop: Boolean,
    val nextDelayMs: Long
)

/** Pure lifecycle decisions kept outside Activity callbacks so races stay testable. */
object VpnLifecyclePolicy {
    private const val EMERGENCY_LEASE_MS = 180_000L
    private const val EMERGENCY_LEASE_POLL_MS = 90_000L

    fun isCurrentRun(runId: Int, currentGeneration: Int): Boolean = runId == currentGeneration

    fun initialState(
        storedState: String,
        coreRunning: Boolean,
        connectionAttemptActive: Boolean
    ): String = when {
        storedState == "connected" && !coreRunning -> "disconnected"
        storedState == "connecting" && !coreRunning && !connectionAttemptActive -> "disconnected"
        storedState == "disconnecting" && !coreRunning && !connectionAttemptActive -> "disconnected"
        else -> storedState
    }

    fun restoredMode(storedMode: String?, vpnState: String): VpnConnectionMode? =
        if (vpnState == "disconnected") null
        else VpnConnectionMode.fromWire(storedMode) ?: VpnConnectionMode.PRIMARY

    fun restartMode(activeMode: VpnConnectionMode?): VpnConnectionMode =
        activeMode ?: VpnConnectionMode.PRIMARY

    internal fun initialEmergencyLease(nowMs: Long): EmergencyLeaseState =
        EmergencyLeaseState(validUntilMs = nowMs + EMERGENCY_LEASE_MS)

    internal fun emergencyLeaseInitialDelay(jitterMs: Long): Long =
        EMERGENCY_LEASE_POLL_MS + jitterMs.coerceIn(0L, 15_000L)

    internal fun evaluateEmergencyLease(
        current: EmergencyLeaseState,
        check: EmergencyLeaseCheck,
        nowMs: Long,
        jitterMs: Long
    ): EmergencyLeaseDecision = when (check) {
        EmergencyLeaseCheck.VALID -> EmergencyLeaseDecision(
            state = EmergencyLeaseState(validUntilMs = nowMs + EMERGENCY_LEASE_MS),
            stop = false,
            nextDelayMs = emergencyLeaseInitialDelay(jitterMs)
        )
        EmergencyLeaseCheck.DENIED -> EmergencyLeaseDecision(current, stop = true, nextDelayMs = 0L)
        EmergencyLeaseCheck.TRANSIENT_FAILURE -> {
            val failures = (current.consecutiveFailures + 1).coerceAtMost(10)
            val remaining = current.validUntilMs - nowMs
            if (remaining <= 0L) {
                EmergencyLeaseDecision(current.copy(consecutiveFailures = failures), stop = true, nextDelayMs = 0L)
            } else {
                val backoff = when (failures) {
                    1 -> 15_000L
                    2 -> 30_000L
                    else -> 60_000L
                } + jitterMs.coerceIn(0L, 10_000L)
                EmergencyLeaseDecision(
                    current.copy(consecutiveFailures = failures),
                    stop = false,
                    nextDelayMs = min(backoff, remaining)
                )
            }
        }
    }

    internal fun shouldTerminateOwnedRun(
        runId: Int,
        currentGeneration: Int,
        decision: EmergencyLeaseDecision
    ): Boolean = decision.stop && runId == currentGeneration

    fun shouldRestartAfterNetworkChange(
        previousNetwork: String?,
        currentNetwork: String,
        vpnState: String,
        manualDisconnectRequested: Boolean,
        lastRestartAtMs: Long,
        nowMs: Long
    ): Boolean = previousNetwork != null &&
        previousNetwork != currentNetwork &&
        vpnState == "connected" &&
        !manualDisconnectRequested &&
        nowMs - lastRestartAtMs > 5_000L
}
