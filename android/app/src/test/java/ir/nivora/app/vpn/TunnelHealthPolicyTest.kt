package ir.nivora.app.vpn
import org.junit.Assert.*
import org.junit.Test
class TunnelHealthPolicyTest {
    @Test fun transientFailureDoesNotSwitch(){assertFalse(TunnelHealthPolicy.shouldSwitch(1,120_000));assertFalse(TunnelHealthPolicy.shouldSwitch(2,120_000))}
    @Test fun repeatedFailureRespectsCooldown(){assertFalse(TunnelHealthPolicy.shouldSwitch(5,10_000));assertFalse(TunnelHealthPolicy.shouldSwitch(3,180_000));assertTrue(TunnelHealthPolicy.shouldSwitch(5,150_000))}
    @Test fun retriesBackOffAndStayBounded(){assertEquals(5000L,TunnelHealthPolicy.retryDelayMs(0));assertEquals(20000L,TunnelHealthPolicy.retryDelayMs(2));assertEquals(60000L,TunnelHealthPolicy.retryDelayMs(1000))}
    @Test fun transientFailuresRecover(){assertTrue(TunnelHealthPolicy.canRecover(IllegalStateException("TUNNEL_UNHEALTHY")));assertTrue(TunnelHealthPolicy.canRecover(java.net.SocketTimeoutException()));assertTrue(TunnelHealthPolicy.canRecover(java.net.UnknownHostException()))}
    @Test fun securityAndConfigurationFailuresStayTerminal(){for(code in listOf("UNAUTHORIZED","SUBSCRIPTION_UNAVAILABLE","SUBSCRIPTION_INVALID","EMERGENCY_LEASE_EXPIRED","TUN_CREATE_FAILED"))assertFalse(code,TunnelHealthPolicy.canRecover(IllegalStateException(code)));assertFalse(TunnelHealthPolicy.canRecover(InterruptedException()));assertFalse(TunnelHealthPolicy.canRecover(javax.net.ssl.SSLHandshakeException("invalid certificate")))}
}
