package ir.nivora.app.data

/** Pure session decisions shared by async dashboard callbacks and VPN startup. */
object SessionValidationPolicy {
    fun isCurrent(capturedToken: String, activeToken: String?): Boolean =
        activeToken != null && capturedToken == activeToken

    fun canStartVpn(signedIn: Boolean, liveSessionValidated: Boolean): Boolean =
        signedIn && liveSessionValidated

    fun rootCause(error: Throwable): Throwable {
        var current = error
        while (current.cause != null && current.cause !== current) current = current.cause!!
        return current
    }

    fun isUnauthorized(error: Throwable): Boolean =
        (rootCause(error) as? ApiException)?.code == "UNAUTHORIZED"
}
