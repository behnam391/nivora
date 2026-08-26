package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRecoveryPolicyTest {
    @Test
    fun `only device-capacity login failures offer recovery`() {
        assertTrue(DeviceRecoveryPolicy.canRequest("DEVICE_ALREADY_BOUND"))
        assertTrue(DeviceRecoveryPolicy.canRequest("DEVICE_LIMIT_REACHED"))
        assertFalse(DeviceRecoveryPolicy.canRequest("INVALID_CREDENTIALS"))
        assertFalse(DeviceRecoveryPolicy.canRequest("UNAUTHORIZED"))
    }

    @Test
    fun `server status aliases are normalized for the login dialog`() {
        assertEquals("pending", DeviceRecoveryPolicy.normalizeStatus("under_review"))
        assertEquals("approved", DeviceRecoveryPolicy.normalizeStatus("resolved"))
        assertEquals("rejected", DeviceRecoveryPolicy.normalizeStatus("dismissed"))
        assertEquals("expired", DeviceRecoveryPolicy.normalizeStatus("cancelled"))
        assertEquals("pending", DeviceRecoveryPolicy.normalizeStatus(null))
    }
}
