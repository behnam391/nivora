package ir.nivora.app.data

object BiometricGatePolicy {
    fun shouldGate(audience: String, hasSession: Boolean, enabled: Boolean): Boolean =
        audience == "customer" && hasSession && enabled

    fun shouldRelock(
        audience: String,
        hasSession: Boolean,
        enabled: Boolean,
        promptActive: Boolean,
        changingConfigurations: Boolean
    ): Boolean = shouldGate(audience, hasSession, enabled) && !promptActive && !changingConfigurations
}
