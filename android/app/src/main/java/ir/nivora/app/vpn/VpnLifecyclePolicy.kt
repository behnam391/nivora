package ir.nivora.app.vpn

/** Pure lifecycle decisions kept outside Activity callbacks so races stay testable. */
object VpnLifecyclePolicy {
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
