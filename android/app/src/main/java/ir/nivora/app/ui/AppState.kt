package ir.nivora.app.ui

import ir.nivora.app.data.Account
import ir.nivora.app.data.DiscountResult
import ir.nivora.app.data.PaymentCard
import ir.nivora.app.data.Plan
import ir.nivora.app.data.ResellerAccount
import ir.nivora.app.data.ResellerCustomer
import ir.nivora.app.data.ResellerOrder
import ir.nivora.app.data.Subscription
import ir.nivora.app.data.SupportTicket
import ir.nivora.app.data.TicketConversation

enum class AppDestination { HOME, PLANS, WALLET, SUPPORT }
enum class LoginRole { CUSTOMER, RESELLER }
enum class ResellerDestination { OVERVIEW, CUSTOMERS, PLANS, WALLET }

data class UiNotice(val id: Long, val text: String, val error: Boolean = false)

data class NivoraUiState(
    val signedIn: Boolean = false,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val actionBusy: Boolean = false,
    val role: String = "customer",
    val account: Account? = null,
    val reseller: ResellerAccount? = null,
    val resellerPlans: List<Plan> = emptyList(),
    val plans: List<Plan> = emptyList(),
    val tickets: List<SupportTicket> = emptyList(),
    val ticketConversation: TicketConversation? = null,
    val ticketLoading: Boolean = false,
    val paymentCards: List<PaymentCard> = emptyList(),
    val loadError: String? = null,
    val vpnState: String = "disconnected",
    val vpnError: String? = null,
    val selectedSubscriptionId: String? = null,
    val pingMs: Long? = null,
    val pingBusy: Boolean = false,
    val showVpnDisclosure: Boolean = false,
    val discount: DiscountResult? = null,
    val notice: UiNotice? = null
) {
    val activeSubscriptions: List<Subscription>
        get() = account?.subscriptions.orEmpty().filter { it.status == "active" && it.url != null }

    val selectedSubscription: Subscription?
        get() = activeSubscriptions.firstOrNull { it.id == selectedSubscriptionId } ?: activeSubscriptions.firstOrNull()
}

interface NivoraActions {
    fun login(phone: String, password: String, role: LoginRole)
    fun register(name: String, phone: String, password: String)
    fun requestPasswordReset(phone: String, onChallenge:(String,String?)->Unit)
    fun openTelegramRecovery()
    fun confirmPasswordReset(phone:String, resetId:String, code:String, newPassword:String)
    fun refresh()
    fun selectSubscription(subscription: Subscription)
    fun toggleVpn()
    fun acceptVpnDisclosure()
    fun dismissVpnDisclosure()
    fun measurePing()
    fun purchase(plan: Plan, discountCode: String)
    fun validateDiscount(code: String)
    fun clearDiscount()
    fun renew(subscription: Subscription)
    fun loadPaymentCards()
    fun submitTopup(amountToman: Int, reference: String, receiptUri: String)
    fun createTicket(subject: String, body: String)
    fun openTicket(ticket: SupportTicket)
    fun replyTicket(body: String)
    fun closeTicketConversation()
    fun markNotificationsRead()
    fun createResellerCustomer(name: String, phone: String, password:String, note: String)
    fun resetResellerCustomerPassword(customer:ResellerCustomer,password:String)
    fun resellerPurchase(plan: Plan, customer: ResellerCustomer, salePriceToman: Int)
    fun resellerRenew(order: ResellerOrder, salePriceToman: Int)
    fun controlResellerSubscription(order:ResellerOrder,action:String,reason:String)
    fun copyText(value: String, message: String)
    fun logout()
    fun consumeNotice()
}
