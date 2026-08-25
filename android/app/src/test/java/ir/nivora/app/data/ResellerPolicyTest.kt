package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResellerPolicyTest {
    @Test
    fun customerSearchMatchesNameAndPhone() {
        assertTrue(ResellerPolicy.matchesCustomer("بهنام شفیعی", "09123456789", "شفیعی"))
        assertTrue(ResellerPolicy.matchesCustomer("بهنام شفیعی", "09123456789", "3456"))
        assertFalse(ResellerPolicy.matchesCustomer("بهنام شفیعی", "09123456789", "علی"))
    }

    @Test
    fun suspendedOrderCannotRenewButCanBeControlled() {
        val order = order(controlStatus = "suspended")
        assertEquals("suspended", order.effectiveStatus)
        assertFalse(ResellerPolicy.canRenew(order))
        assertTrue(ResellerPolicy.canControl(order))
    }

    @Test
    fun activePurchaseCanRenew() {
        assertTrue(ResellerPolicy.canRenew(order()))
        assertFalse(ResellerPolicy.canRenew(order(orderKind = "renewal")))
    }

    @Test
    fun transferAndDebtValidationRespectBusinessLimits() {
        assertTrue(ResellerPolicy.validTransfer(75_000, 100_000))
        assertFalse(ResellerPolicy.validTransfer(125_000, 100_000))
        assertFalse(ResellerPolicy.validTransfer(0, 100_000))
        assertTrue(ResellerPolicy.validDebt(50_000, "تمدید نسیه"))
        assertFalse(ResellerPolicy.validDebt(50_000, "ن"))
    }

    private fun order(
        orderKind: String = "purchase",
        status: String = "active",
        controlStatus: String = "active"
    ) = ResellerOrder(
        id = "order-1",
        planId = "plan-1",
        customerId = "customer-1",
        customerName = "مشتری",
        phone = "09123456789",
        planName = "پلن ماهانه",
        orderKind = orderKind,
        status = status,
        controlStatus = controlStatus,
        subscriptionUrl = null,
        locationName = "آلمان",
        trafficGb = 50,
        durationDays = 30,
        remainingDays = 20,
        salePriceToman = 200_000,
        createdAt = "2026-08-25T10:00:00Z"
    )
}
