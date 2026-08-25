package ir.nivora.app.data

/**
 * Pure per-connection routing policy.
 *
 * Keep these decisions together: splitting them across JSON construction can
 * accidentally put a short-lived Hysteria route back into the Reality
 * balancer, or black-hole the UDP transport that Hysteria itself needs.
 */
internal class VpnRoutingPolicy private constructor(
    val primaryTransport: PrimaryTransport,
    val routeMode: RouteMode,
    val rejectUdp443: Boolean
) {
    val usesExclusiveProxy: Boolean
        get() = routeMode == RouteMode.EXCLUSIVE_PROXY

    val allowsSmartBalancer: Boolean
        get() = routeMode == RouteMode.SMART_BALANCER

    internal enum class PrimaryTransport {
        HYSTERIA2,
        REALITY
    }

    internal enum class RouteMode {
        EXCLUSIVE_PROXY,
        SMART_BALANCER
    }

    companion object {
        /**
         * A successfully selected Hysteria ticket owns the whole session.
         * Reality remains a next-connection fallback, not a competing route.
         */
        fun forSession(hysteriaSelected: Boolean): VpnRoutingPolicy =
            if (hysteriaSelected) {
                VpnRoutingPolicy(
                    primaryTransport = PrimaryTransport.HYSTERIA2,
                    routeMode = RouteMode.EXCLUSIVE_PROXY,
                    rejectUdp443 = false
                )
            } else {
                VpnRoutingPolicy(
                    primaryTransport = PrimaryTransport.REALITY,
                    routeMode = RouteMode.SMART_BALANCER,
                    rejectUdp443 = true
                )
            }
    }
}
