package ir.nivora.app.vpn
import org.junit.Assert.*
import org.junit.Test
class TunnelHealthPolicyTest {
    @Test fun transientFailureDoesNotSwitch(){assertFalse(TunnelHealthPolicy.shouldSwitch(1,120_000));assertFalse(TunnelHealthPolicy.shouldSwitch(2,120_000))}
    @Test fun repeatedFailureRespectsCooldown(){assertFalse(TunnelHealthPolicy.shouldSwitch(3,10_000));assertTrue(TunnelHealthPolicy.shouldSwitch(3,60_000))}
}
