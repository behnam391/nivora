package ir.nivora.app.vpn

internal object TunnelHealthPolicy {
    const val MAX_ROUTES=3
    const val CHECK_INTERVAL_MS=30_000L
    const val SWITCH_COOLDOWN_MS=60_000L
    const val FAILURE_THRESHOLD=3
    fun shouldSwitch(failures:Int,elapsedSinceSwitch:Long)=failures>=FAILURE_THRESHOLD && elapsedSinceSwitch>=SWITCH_COOLDOWN_MS
}
