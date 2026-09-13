package ir.nivora.app.vpn

internal object TunnelHealthPolicy {
    const val MAX_ROUTES=3
    const val CHECK_INTERVAL_MS=30_000L
    const val SWITCH_COOLDOWN_MS=120_000L
    const val FAILURE_THRESHOLD=5
    const val PROBE_BUDGET_MS=6_000L
    fun retryDelayMs(attempt:Int):Long = when { attempt<=0->5_000L;attempt==1->10_000L;attempt==2->20_000L;attempt==3->30_000L;else->60_000L }
    fun canRecover(error:Throwable):Boolean = error.message in setOf("TUNNEL_UNHEALTHY","SUBSCRIPTION_TIMEOUT","SUBSCRIPTION_NETWORK_ERROR") ||
        error is java.net.SocketTimeoutException || error is java.net.UnknownHostException || error is java.net.ConnectException || error is java.net.NoRouteToHostException
    fun shouldSwitch(failures:Int,elapsedSinceSwitch:Long)=failures>=FAILURE_THRESHOLD && elapsedSinceSwitch>=SWITCH_COOLDOWN_MS
}
