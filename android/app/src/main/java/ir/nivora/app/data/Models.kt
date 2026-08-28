package ir.nivora.app.data

data class AppRelease(val versionCode:Int,val versionName:String,val downloadUrl:String,val releaseNotes:String,val forceUpdate:Boolean)

data class Plan(
    val id: String,
    val name: String,
    val description: String,
    val priceToman: Int,
    val trafficGb: Int,
    val durationDays: Int,
    val deviceLimit: Int,
    val locations: List<String>
)

data class Subscription(
    val id: String,
    val planName: String,
    val status: String,
    val url: String?,
    val usedBytes: Long,
    val totalBytes: Long,
    val remainingBytes: Long,
    val usagePercent: Double,
    val remainingDays: Int,
    val expiryTime: Long?,
    val startsOnFirstUse: Boolean,
    val locationName: String?,
    val countryCode: String?,
    val flagEmoji: String?,
    val city: String?,
    val routeCount: Int,
    val trafficGb: Int,
    val durationDays: Int,
    val deviceLimit: Int
)

data class WalletTransaction(
    val id: String,
    val amountToman: Int,
    val balanceAfterToman: Int,
    val type: String,
    val note: String?,
    val createdAt: String
)

data class WalletTopup(
    val id: String,
    val amountToman: Int,
    val reference: String?,
    val status: String,
    val reviewNote: String?,
    val createdAt: String
)

data class CustomerNotification(
    val id: String,
    val title: String,
    val body: String,
    val readAt: String?,
    val createdAt: String
)

data class EmergencyAvailability(
    val enabled: Boolean = false,
    val ready: Boolean = false,
    val nodeCount: Int = 0,
    val updatedAt: String? = null
) {
    val available: Boolean
        get() = enabled && ready && nodeCount > 0
}

data class SupportTicket(
    val id: String,
    val subject: String,
    val status: String,
    val lastMessage: String?,
    val updatedAt: String
)

data class TicketMessage(
    val id: String,
    val senderRole: String,
    val body: String,
    val createdAt: String
)

data class TicketConversation(
    val id: String,
    val subject: String,
    val status: String,
    val messages: List<TicketMessage>
)

data class Account(
    val name: String,
    val phone: String,
    val balanceToman: Int,
    val subscriptions: List<Subscription>,
    val transactions: List<WalletTransaction>,
    val topups: List<WalletTopup>,
    val notifications: List<CustomerNotification>,
    val emergency: EmergencyAvailability = EmergencyAvailability()
)

data class ResellerCustomer(
    val id: String,
    val accountId: String?,
    val name: String,
    val phone: String,
    val note: String,
    val activeSubscriptions: Int,
    val subscriptionCount: Int,
    val revenueToman: Int,
    val profitToman: Int,
    val managedAccount: Boolean
)

/** A customer account that the backend explicitly allows a reseller to find. */
data class ResellerDirectoryCustomer(
    val accountId: String,
    val name: String,
    val phone: String,
    val balanceToman: Int
)

data class ResellerCustomerAccess(
    val customerId: String,
    val passwordManaged: Boolean
)

/**
 * A normalized sale target. Own address-book customers use [customerId], while
 * directory customers use [accountId]. The backend remains the authority that
 * decides whether the reseller may operate on the target.
 */
data class ResellerSaleTarget(
    val customerId: String?,
    val accountId: String?,
    val name: String,
    val phone: String,
    val balanceToman: Int? = null
)

data class ResellerOrder(
    val id: String,
    val planId: String,
    val customerId: String?,
    val customerName: String,
    val phone: String,
    val planName: String,
    val orderKind: String,
    val status: String,
    val controlStatus: String,
    val subscriptionUrl: String?,
    val locationName: String?,
    val trafficGb: Int,
    val durationDays: Int,
    val remainingDays: Int,
    val salePriceToman: Int,
    val createdAt: String
) {
    val effectiveStatus: String
        get() = controlStatus.takeUnless { it.isBlank() || it == "active" } ?: status
}

data class ResellerDebt(
    val id: String,
    val customerAccountId: String,
    val customerName: String,
    val customerPhone: String,
    val amountToman: Int,
    val note: String,
    val status: String,
    val createdAt: String,
    val paymentReportedAt: String?
)

data class ResellerWalletTransfer(
    val id: String,
    val customerAccountId: String,
    val customerName: String,
    val customerPhone: String,
    val amountToman: Int,
    val reversedAmountToman: Int,
    val note: String,
    val status: String,
    val createdAt: String
) {
    val remainingAmountToman: Int
        get() = (amountToman - reversedAmountToman).coerceAtLeast(0)
}

data class ResellerAccount(
    val name: String,
    val phone: String,
    val balanceToman: Int,
    val customersCount: Int,
    val salesCount: Int,
    val activeSubscriptions: Int,
    val totalRevenueToman: Int,
    val totalProfitToman: Int,
    val notifications: List<CustomerNotification>,
    val transactions: List<WalletTransaction>,
    val debts: List<ResellerDebt>,
    val walletTransfers: List<ResellerWalletTransfer>,
    val customers: List<ResellerCustomer>,
    val orders: List<ResellerOrder>
)

data class Session(val token: String, val name: String, val role: String)
data class PaymentCard(val number: String, val holder: String, val bank: String?)
data class PurchaseResult(val subscriptionUrl: String?, val discountToman: Int, val balanceToman: Int?)
data class DiscountResult(val code: String, val percent: Int)
data class ResetChallenge(val id: String, val debugCode: String?)

data class DeviceRecoveryRequest(
    val id: String?,
    val status: String,
    val message: String?
)

object DeviceRecoveryPolicy {
    private val blockedDeviceCodes = setOf("DEVICE_ALREADY_BOUND", "DEVICE_LIMIT_REACHED")

    fun canRequest(errorCode: String): Boolean = errorCode in blockedDeviceCodes

    fun normalizeStatus(value: String?): String = when (value?.trim()?.lowercase()) {
        "approved", "resolved", "accepted_reset" -> "approved"
        "rejected", "dismissed", "denied" -> "rejected"
        "expired", "cancelled", "canceled" -> "expired"
        "pending", "queued", "accepted", "under_review", "in_review" -> "pending"
        else -> "pending"
    }
}

class ApiException(val code: String, val status: Int) : RuntimeException(code)
