package ir.nivora.app.data

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
    val notifications: List<CustomerNotification>
)

data class ResellerCustomer(
    val id: String,
    val name: String,
    val phone: String,
    val note: String,
    val activeSubscriptions: Int,
    val subscriptionCount: Int,
    val revenueToman: Int,
    val profitToman: Int,
    val managedAccount: Boolean
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
    val subscriptionUrl: String?,
    val locationName: String?,
    val trafficGb: Int,
    val durationDays: Int,
    val remainingDays: Int,
    val salePriceToman: Int,
    val createdAt: String
)

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
    val customers: List<ResellerCustomer>,
    val orders: List<ResellerOrder>
)

data class Session(val token: String, val name: String, val role: String)
data class PaymentCard(val number: String, val holder: String, val bank: String?)
data class PurchaseResult(val subscriptionUrl: String?, val discountToman: Int, val balanceToman: Int?)
data class DiscountResult(val code: String, val percent: Int)
data class ResetChallenge(val id: String, val debugCode: String?)

class ApiException(val code: String, val status: Int) : RuntimeException(code)
