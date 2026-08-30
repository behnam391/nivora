package ir.nivora.app.ui

import ir.nivora.app.data.Account
import ir.nivora.app.data.DiscountResult
import ir.nivora.app.data.PaymentCard
import ir.nivora.app.data.Plan
import ir.nivora.app.data.ResellerAccount
import ir.nivora.app.data.ResellerCustomer
import ir.nivora.app.data.ResellerDirectoryCustomer
import ir.nivora.app.data.ResellerOrder
import ir.nivora.app.data.ResellerSaleTarget
import ir.nivora.app.data.ResellerDebt
import ir.nivora.app.data.ResellerWalletTransfer
import ir.nivora.app.data.Subscription
import ir.nivora.app.data.SupportTicket
import ir.nivora.app.data.TicketConversation
import ir.nivora.app.data.VpnConnectionMode

enum class AppDestination { HOME, PLANS, WALLET, SUPPORT }
enum class LoginRole { CUSTOMER, RESELLER }
enum class ResellerDestination { OVERVIEW, CUSTOMERS, PLANS, WALLET, SUPPORT }

data class UiNotice(val id: Long, val text: String, val error: Boolean = false)

data class DeviceRecoveryUiState(
    val phone: String,
    val reasonCode: String,
    val requestId: String? = null,
    val status: String = "ready",
    val message: String? = null,
    val error: String? = null
)

data class NivoraUiState(
    val signedIn: Boolean = false,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val actionBusy: Boolean = false,
    val role: String = "customer",
    val account: Account? = null,
    val reseller: ResellerAccount? = null,
    val resellerPlans: List<Plan> = emptyList(),
    val resellerDirectory: List<ResellerDirectoryCustomer> = emptyList(),
    val resellerDirectoryQuery: String = "",
    val resellerDirectoryLoading: Boolean = false,
    val resellerPasswordManagedCustomerIds: Set<String> = emptySet(),
    val resellerProfileLoadingId: String? = null,
    val plans: List<Plan> = emptyList(),
    val tickets: List<SupportTicket> = emptyList(),
    val ticketConversation: TicketConversation? = null,
    val ticketLoading: Boolean = false,
    val paymentCards: List<PaymentCard> = emptyList(),
    val loadError: String? = null,
    val vpnState: String = "disconnected",
    val vpnError: String? = null,
    val vpnMode: VpnConnectionMode? = null,
    val smartRoute: String? = null,
    val selectedSubscriptionId: String? = null,
    val pingMs: Long? = null,
    val pingBusy: Boolean = false,
    val showVpnDisclosure: Boolean = false,
    val showEmergencyDisclosure: Boolean = false,
    val discount: DiscountResult? = null,
    val deviceRecovery: DeviceRecoveryUiState? = null,
    val biometricEnabled: Boolean = false,
    val biometricLocked: Boolean = false,
    val biometricMessage: String? = null,
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
    fun requestDeviceRecovery()
    fun refreshDeviceRecovery()
    fun retryDeviceRecoveryLogin()
    fun dismissDeviceRecovery()
    fun setBiometricEnabled(enabled: Boolean)
    fun requestBiometricUnlock()
    fun refresh()
    fun selectSubscription(subscription: Subscription)
    fun toggleVpn()
    fun toggleEmergencyVpn()
    fun acceptVpnDisclosure()
    fun dismissVpnDisclosure()
    fun acceptEmergencyDisclosure()
    fun dismissEmergencyDisclosure()
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
    fun changeName(name: String)
    fun changePassword(currentPassword: String, newPassword: String)
    fun clearNotifications()
    fun clearTickets()
    fun openNetworkLab()
    fun createResellerCustomer(name: String, phone: String, password:String, note: String)
    fun resetResellerCustomerPassword(customer:ResellerCustomer,password:String)
    fun loadResellerCustomerAccess(customer: ResellerCustomer)
    fun resellerPurchase(plan: Plan, customer: ResellerCustomer, salePriceToman: Int)
    fun resellerPurchaseTarget(plan: Plan, target: ResellerSaleTarget, salePriceToman: Int)
    fun resellerRenew(order: ResellerOrder, salePriceToman: Int)
    fun controlResellerSubscription(order:ResellerOrder,action:String,reason:String)
    fun searchResellerDirectory(query: String)
    fun creditResellerCustomerWallet(accountId: String, amountToman: Int, note: String)
    fun reverseResellerWalletTransfer(transfer: ResellerWalletTransfer, amountToman: Int?, reason: String)
    fun createResellerCustomerDebt(accountId: String, amountToman: Int, note: String)
    fun controlResellerCustomerDebt(debt: ResellerDebt, action: String)
    fun copyText(value: String, message: String)
    fun logout()
    fun consumeNotice()
}
