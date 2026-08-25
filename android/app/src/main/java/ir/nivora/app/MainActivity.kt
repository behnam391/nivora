package ir.nivora.app

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.media.AudioAttributes
import android.content.*
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.activity.compose.setContent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import ir.nivora.app.data.*
import ir.nivora.app.ui.*
import ir.nivora.app.vpn.NivoraVpnService
import ir.nivora.app.vpn.VpnLifecyclePolicy
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit
import java.util.concurrent.CompletableFuture
import java.util.UUID
import kotlin.concurrent.thread

class MainActivity : ComponentActivity(), NivoraActions {
    private val deviceId by lazy {
        getSharedPreferences("nivora_device", MODE_PRIVATE).getString("id", null)
            ?: UUID.randomUUID().toString().replace("-", "").also { getSharedPreferences("nivora_device", MODE_PRIVATE).edit().putString("id", it).apply() }
    }
    private val api by lazy { ApiClient(BuildConfig.API_BASE_URL, deviceId) }
    private val handler = Handler(Looper.getMainLooper())
    private val noticeIds = AtomicLong()
    private lateinit var session: SecureSessionStore
    private val selection by lazy { getSharedPreferences("selection", MODE_PRIVATE) }
    private val vpnPreferences by lazy { getSharedPreferences("vpn", MODE_PRIVATE) }
    private val alertPreferences by lazy { getSharedPreferences("alerts", MODE_PRIVATE) }
    private var state by mutableStateOf(NivoraUiState())
    private var receiverRegistered = false
    private var networkCallbackRegistered = false
    private var lastUnderlyingNetwork: String? = null
    private var networkRestartAt = 0L
    @Volatile private var manualDisconnectRequested = false
    @Volatile private var activeSessionToken: String? = null
    @Volatile private var liveSessionValidated = false
    @Volatile private var dashboardValidationInFlight = false
    private val networkCallback = object : android.net.ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: android.net.Network, capabilities: android.net.NetworkCapabilities) {
            if (capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN) ||
                !capabilities.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return
            val key = when {
                capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
            handler.post {
                val previous = lastUnderlyingNetwork
                lastUnderlyingNetwork = key
                val now = System.currentTimeMillis()
                if (VpnLifecyclePolicy.shouldRestartAfterNetworkChange(
                        previous, key, state.vpnState, manualDisconnectRequested, networkRestartAt, now
                    )) {
                    networkRestartAt = now
                    showNotice("شبکه تغییر کرد؛ مسیر هوشمند دوباره انتخاب می‌شود")
                    startSelectedVpn()
                }
            }
        }
    }
    private val notificationPoll=object:Runnable{override fun run(){if(activeSessionToken!=null)loadDashboard(false);handler.postDelayed(this,60_000)}}

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) startSelectedVpn()
        else showNotice("برای اتصال باید اجازه VPN را تأیید کنید", true)
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val vpnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val vpnState = vpnPreferences.getString("state", "disconnected") ?: "disconnected"
            val error = vpnPreferences.getString("error", null)
            val smartRoute = intent?.getStringExtra(NivoraVpnService.EXTRA_SMART_ROUTE)
                ?: vpnPreferences.getString("smart_route", null)
            if (vpnState == "disconnected" || vpnState == "error") manualDisconnectRequested = false
            state = state.copy(vpnState = vpnState, vpnError = friendlyVpnError(error), smartRoute = smartRoute)
            if (vpnState == "connected") handler.postDelayed({ refresh() }, 3_500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        )
        session = SecureSessionStore(this)
        val customerAudience = BuildConfig.APP_AUDIENCE == "customer"
        if (customerAudience) {
            registerVpnReceiver()
            registerNetworkObserver()
        }
        val storedState = vpnPreferences.getString("state", "disconnected") ?: "disconnected"
        val correctedState = if (customerAudience) {
            VpnLifecyclePolicy.initialState(
                storedState,
                NivoraVpnService.isCoreRunning(),
                NivoraVpnService.isConnectionAttemptActive()
            )
        } else "disconnected"
        if (correctedState != storedState) vpnPreferences.edit().putString("state", correctedState).remove("error").apply()
        val expectedRole = if (BuildConfig.APP_AUDIENCE == "partner") "reseller" else "customer"
        val storedToken = session.token()
        val storedRole = session.role()
        val signedIn = storedToken != null && storedRole == expectedRole
        if (!signedIn && storedToken != null) session.clear()
        activeSessionToken = storedToken.takeIf { signedIn }
        liveSessionValidated = false
        state = state.copy(
            signedIn = signedIn,
            loading = signedIn,
            role = storedRole,
            vpnState = correctedState,
            vpnError = friendlyVpnError(vpnPreferences.getString("error", null)),
            smartRoute = vpnPreferences.getString("smart_route", null)
        )
        setContent {
            NivoraTheme(darkTheme = true) {
                Surface { NivoraApp(state, this@MainActivity) }
            }
        }
        activeSessionToken?.let { token ->
            if (expectedRole == "customer") loadCachedCustomerDashboard(token)
            loadDashboard(initial = true)
        }
        if(signedIn)scheduleNotificationWorker()
        if(signedIn&&Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        handler.postDelayed(notificationPoll,60_000)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (receiverRegistered) unregisterReceiver(vpnReceiver)
        if (networkCallbackRegistered) runCatching {
            getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        }
        super.onDestroy()
    }

    override fun login(phone: String, password: String, role: LoginRole) = runAction(
        work = { api.login(phone, password, if (role == LoginRole.RESELLER) "reseller" else "customer") },
        success = {
            session.save(it.token, it.role)
            activeSessionToken = it.token
            liveSessionValidated = false
            dashboardValidationInFlight = false
            scheduleNotificationWorker()
            state = state.copy(signedIn = true, loading = true, role = it.role, account = null, reseller = null, loadError = null)
            loadDashboard(initial = true)
        }
    )

    override fun register(name: String, phone: String, password: String) = runAction(
        work = { api.register(name, phone, password) },
        success = {
            session.save(it.token, "customer")
            activeSessionToken = it.token
            liveSessionValidated = false
            dashboardValidationInFlight = false
            scheduleNotificationWorker()
            state = state.copy(signedIn = true, loading = true, role = "customer", loadError = null)
            loadDashboard(initial = true)
        }
    )

    override fun requestPasswordReset(phone: String, onChallenge:(String,String?)->Unit) = runAction(
        work = { api.requestPasswordReset(phone) },
        success = { onChallenge(it.id,it.debugCode) }
    )
    override fun openTelegramRecovery()=background(work={api.telegramBotUsername()},success={username->if(username.isBlank())showNotice("ربات بازیابی هنوز فعال نشده است",true)else startActivity(Intent(Intent.ACTION_VIEW,android.net.Uri.parse("https://t.me/$username?start=recovery")))},failure={showNotice(friendly(it),true)})
    override fun confirmPasswordReset(phone:String,resetId:String,code:String,newPassword:String)=runAction(work={api.confirmPasswordReset(phone,resetId,code,newPassword)},success={showNotice("رمز عبور با موفقیت تغییر کرد")})

    override fun refresh() = loadDashboard(initial = false)

    override fun selectSubscription(subscription: Subscription) {
        selection.edit().putString("subscription_id", subscription.id).apply()
        state = state.copy(selectedSubscriptionId = subscription.id, pingMs = null)
    }

    override fun toggleVpn() {
        if (BuildConfig.APP_AUDIENCE != "customer") return
        if (state.vpnState == "connected" || state.vpnState == "connecting") {
            requestVpnStop()
            return
        }
        if (state.vpnState == "disconnecting") return
        if (!SessionValidationPolicy.canStartVpn(state.signedIn, liveSessionValidated)) {
            showNotice("حساب و دستگاه در حال تأیید است؛ چند لحظه دیگر دوباره بزنید", true)
            if (!state.loading && !state.refreshing && !dashboardValidationInFlight) {
                loadDashboard(initial = state.account == null && state.reseller == null)
            }
            return
        }
        val subscription = state.selectedSubscription
        if (subscription?.url.isNullOrBlank()) {
            showNotice("ابتدا یک اشتراک فعال انتخاب کنید", true)
            return
        }
        if (!selection.getBoolean("vpn_disclosure_accepted", false)) {
            state = state.copy(showVpnDisclosure = true)
            return
        }
        selectSubscription(subscription!!)
        val permissionIntent = VpnService.prepare(this)
        if (permissionIntent != null) vpnPermission.launch(permissionIntent) else startSelectedVpn()
    }

    override fun acceptVpnDisclosure() {
        selection.edit().putBoolean("vpn_disclosure_accepted", true).apply()
        state = state.copy(showVpnDisclosure = false)
        toggleVpn()
    }

    override fun dismissVpnDisclosure() {
        state = state.copy(showVpnDisclosure = false)
    }

    override fun measurePing() {
        if (state.vpnState != "connected") {
            showNotice("ابتدا اتصال امن را برقرار کنید", true)
            return
        }
        if (state.pingBusy) return
        state = state.copy(pingBusy = true)
        background(
            work = {
                val values = listOf(
                    "https://www.gstatic.com/generate_204" to true,
                    "https://www.youtube.com/generate_204" to true,
                    "https://www.instagram.com/" to false
                ).mapNotNull { (target, expected204) -> runCatching {
                    val started = android.os.SystemClock.elapsedRealtime()
                    val connection = (URL(target).openConnection() as HttpURLConnection).apply {
                        connectTimeout = 7_000; readTimeout = 7_000; useCaches = false; instanceFollowRedirects = false
                    }
                    try {
                        val code = connection.responseCode
                        if ((expected204 && code != 204) || (!expected204 && code !in 200..499)) throw java.io.IOException()
                        android.os.SystemClock.elapsedRealtime() - started
                    } finally { connection.disconnect() }
                }.getOrNull() }
                if (values.size < 2) throw ApiException("INVALID_SUBSCRIPTION", 422)
                values.sorted()[values.size / 2]
            },
            success = { ping -> state = state.copy(pingBusy = false, pingMs = ping); showNotice("تأخیر واقعی اینترنت: $ping میلی‌ثانیه") },
            failure = { state = state.copy(pingBusy = false); showNotice("اندازه‌گیری پینگ انجام نشد", true) }
        )
    }

    override fun purchase(plan: Plan, discountCode: String) = withToken { token ->
        runAction(
            work = { api.purchase(token, plan.id, discountCode) },
            success = { result ->
                val message = if (result.discountToman > 0) "اشتراک ساخته شد؛ ${result.discountToman} تومان تخفیف اعمال شد" else "اشتراک با موفقیت ساخته شد"
                showNotice(message)
                state = state.copy(discount = null)
                loadDashboard(initial = false)
            }
        )
    }

    override fun validateDiscount(code: String) = withToken { token ->
        if (code.trim().length < 3) {
            showNotice("کد تخفیف را کامل وارد کنید", true)
            return@withToken
        }
        runAction(
            work = { api.validateDiscount(token, code) },
            success = { state = state.copy(discount = it); showNotice("کد تخفیف معتبر است") }
        )
    }

    override fun clearDiscount() {
        state = state.copy(discount = null)
    }

    override fun renew(subscription: Subscription) = withToken { token ->
        runAction(
            work = { api.renew(token, subscription.id) },
            success = { showNotice("اشتراک با موفقیت تمدید شد"); loadDashboard(initial = false) }
        )
    }

    override fun loadPaymentCards() {
        if (state.paymentCards.isNotEmpty()) return
        background(
            work = api::cards,
            success = { state = state.copy(paymentCards = it) },
            failure = { showNotice(friendly(it), true) }
        )
    }

    override fun submitTopup(amountToman: Int, reference: String, receiptUri:String) = withToken { token ->
        runAction(
            work = { val uri=android.net.Uri.parse(receiptUri);val bytes=contentResolver.openInputStream(uri)?.use{it.readBytes()}?:throw ApiException("INVALID_RECEIPT",400);if(bytes.size>4*1024*1024)throw ApiException("INVALID_RECEIPT",400);val uploaded=api.uploadReceipt(token,bytes,contentResolver.getType(uri)?:"image/jpeg");api.topup(token,amountToman,reference,uploaded) },
            success = { showNotice("درخواست شارژ برای بررسی ارسال شد"); loadDashboard(initial = false) }
        )
    }

    override fun createTicket(subject: String, body: String) = withToken { token ->
        runAction(
            work = { api.createTicket(token, subject, body, state.role) },
            success = { showNotice("تیکت برای پشتیبانی ارسال شد"); loadDashboard(initial = false) }
        )
    }

    override fun openTicket(ticket: SupportTicket) = withToken { token ->
        if (state.ticketLoading) return@withToken
        state = state.copy(ticketLoading = true)
        background(
            work = { api.ticket(token, ticket.id, state.role) },
            success = { state = state.copy(ticketLoading = false, ticketConversation = it) },
            failure = { state = state.copy(ticketLoading = false); showNotice(friendly(it), true) }
        )
    }

    override fun replyTicket(body: String) = withToken { token ->
        val ticket = state.ticketConversation ?: return@withToken
        runAction(
            work = { api.replyTicket(token, ticket.id, body, state.role); api.ticket(token, ticket.id, state.role) },
            success = {
                state = state.copy(ticketConversation = it)
                showNotice("پاسخ شما ارسال شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun closeTicketConversation() {
        state = state.copy(ticketConversation = null)
    }

    override fun markNotificationsRead() = withToken { token ->
        val unread = if (state.role == "reseller") {
            state.reseller?.notifications.orEmpty().any { it.readAt == null }
        } else {
            state.account?.notifications.orEmpty().any { it.readAt == null }
        }
        if (!unread) return@withToken
        state = if (state.role == "reseller") {
            state.copy(reseller = state.reseller?.let { reseller ->
                reseller.copy(notifications = reseller.notifications.map { it.copy(readAt = it.readAt ?: "read") })
            })
        } else {
            state.copy(account = state.account?.let { account ->
                account.copy(notifications = account.notifications.map { it.copy(readAt = it.readAt ?: "read") })
            })
        }
        background(
            work = { api.markNotificationsRead(token, state.role) },
            success = { },
            failure = { if ((it as? ApiException)?.code == "UNAUTHORIZED") logout() }
        )
    }

    override fun openNetworkLab() {
        if (BuildConfig.APP_AUDIENCE == "customer" && BuildConfig.NETWORK_LAB_ENABLED) startActivity(Intent(this, NetworkLabActivity::class.java))
    }

    override fun createResellerCustomer(name: String, phone: String, password:String, note: String) = withToken { token ->
        runAction(
            work = { api.createResellerCustomer(token, name, phone, password, note) },
            success = { showNotice("مشتری به دفترچه اضافه شد"); loadDashboard(initial = false) }
        )
    }

    override fun resetResellerCustomerPassword(customer:ResellerCustomer,password:String)=withToken{token->runAction(work={api.resetResellerCustomerPassword(token,customer.id,password)},success={showNotice("رمز مشتری تغییر کرد");loadDashboard(false)})}

    override fun loadResellerCustomerAccess(customer: ResellerCustomer) = withToken { token ->
        state = state.copy(resellerProfileLoadingId = customer.id)
        background(
            work = { api.resellerCustomerAccess(token, customer.id) },
            success = { access ->
                if (!isCurrentSession(token) || state.resellerProfileLoadingId != customer.id) return@background
                val allowed = state.resellerPasswordManagedCustomerIds.toMutableSet().apply {
                    if (access.passwordManaged) add(access.customerId) else remove(access.customerId)
                }
                state = state.copy(resellerPasswordManagedCustomerIds = allowed, resellerProfileLoadingId = null)
            },
            failure = {
                if (!isCurrentSession(token) || state.resellerProfileLoadingId != customer.id) return@background
                state = state.copy(resellerProfileLoadingId = null)
                if (isUnauthorized(it)) invalidateSession(token) else showNotice(friendly(it), true)
            }
        )
    }

    override fun resellerPurchase(plan: Plan, customer: ResellerCustomer, salePriceToman: Int) = withToken { token ->
        runAction(
            work = { api.resellerPurchase(token, plan.id, customer.id, salePriceToman) },
            success = { result ->
                result.subscriptionUrl?.let { copyText(it, "اشتراک ساخته شد و لینک آن کپی شد") } ?: showNotice("اشتراک با موفقیت ساخته شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun resellerPurchaseTarget(plan: Plan, target: ResellerSaleTarget, salePriceToman: Int) = withToken { token ->
        runAction(
            work = { api.resellerPurchase(token, plan.id, target, salePriceToman) },
            success = {
                showNotice("اشتراک ${target.name} با موفقیت ساخته شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun resellerRenew(order: ResellerOrder, salePriceToman: Int) = withToken { token ->
        runAction(
            work = { api.resellerRenew(token, order.id, salePriceToman) },
            success = { showNotice("اشتراک مشتری تمدید شد"); loadDashboard(initial = false) }
        )
    }
    override fun controlResellerSubscription(order:ResellerOrder,action:String,reason:String)=withToken{token->runAction(work={api.controlResellerSubscription(token,order.id,action,reason)},success={showNotice(if(action=="suspend")"اشتراک تعلیق شد" else if(action=="resume")"اشتراک فعال شد" else "اشتراک حذف شد");loadDashboard(false)})}

    override fun searchResellerDirectory(query: String) = withToken { token ->
        val normalized = query.trim()
        if (normalized.length < 3) {
            state = state.copy(resellerDirectoryLoading = false)
            showNotice("برای جست‌وجو حداقل سه رقم یا سه حرف وارد کنید", true)
            return@withToken
        }
        state = state.copy(resellerDirectoryQuery = normalized, resellerDirectoryLoading = true)
        background(
            work = { api.resellerCustomerDirectory(token, normalized) },
            success = {
                if (!isCurrentSession(token) || state.resellerDirectoryQuery != normalized) return@background
                state = state.copy(resellerDirectory = it, resellerDirectoryLoading = false)
            },
            failure = {
                if (!isCurrentSession(token) || state.resellerDirectoryQuery != normalized) return@background
                state = state.copy(resellerDirectoryLoading = false)
                if (isUnauthorized(it)) invalidateSession(token) else showNotice(friendly(it), true)
            }
        )
    }

    override fun creditResellerCustomerWallet(accountId: String, amountToman: Int, note: String) = withToken { token ->
        runAction(
            work = { api.creditCustomerWallet(token, accountId, amountToman, note) },
            success = {
                showNotice("کیف پول مشتری شارژ شد")
                if (state.resellerDirectoryQuery.length >= 3) searchResellerDirectory(state.resellerDirectoryQuery)
                loadDashboard(initial = false)
            }
        )
    }

    override fun reverseResellerWalletTransfer(transfer: ResellerWalletTransfer, amountToman: Int?, reason: String) = withToken { token ->
        runAction(
            work = { api.reverseCustomerWalletTransfer(token, transfer.id, amountToman, reason) },
            success = {
                showNotice("اصلاح کیف پول انجام شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun createResellerCustomerDebt(accountId: String, amountToman: Int, note: String) = withToken { token ->
        runAction(
            work = { api.createCustomerDebt(token, accountId, amountToman, note) },
            success = {
                showNotice("بدهی ثبت شد و به مشتری اطلاع داده شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun controlResellerCustomerDebt(debt: ResellerDebt, action: String) = withToken { token ->
        runAction(
            work = { api.controlCustomerDebt(token, debt.id, action) },
            success = {
                showNotice(if (action == "settle") "پرداخت بدهی تأیید شد" else "بدهی لغو شد")
                loadDashboard(initial = false)
            }
        )
    }

    override fun copyText(value: String, message: String) {
        if (value.isBlank()) return
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Nivora", value))
        showNotice(message)
    }

    override fun logout() {
        activeSessionToken = null
        liveSessionValidated = false
        dashboardValidationInFlight = false
        if (BuildConfig.APP_AUDIENCE == "customer") sendVpnStopCommand()
        session.clear()
        SubscriptionBundleStore(this).clear()
        DashboardSnapshotStore(this).clear()
        WorkManager.getInstance(this).cancelUniqueWork("nivora-notification-poll")
        selection.edit().clear().apply()
        state = NivoraUiState(vpnState = "disconnected")
    }

    override fun consumeNotice() {
        state = state.copy(notice = null)
    }

    private fun startSelectedVpn() {
        if (!SessionValidationPolicy.canStartVpn(state.signedIn, liveSessionValidated)) {
            showNotice("اتصال پس از تأیید حساب و دستگاه فعال می‌شود", true)
            return
        }
        val token = activeSessionToken ?: return
        val subscription = state.selectedSubscription ?: return
        val url = subscription.url
        if (url.isNullOrBlank()) return
        manualDisconnectRequested = false
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        state = state.copy(vpnState = "connecting", vpnError = null)
        startForegroundService(
            Intent(this, NivoraVpnService::class.java)
                .putExtra(NivoraVpnService.EXTRA_URL, url)
                .putExtra(NivoraVpnService.EXTRA_SUBSCRIPTION_ID, subscription.id)
                .putExtra(NivoraVpnService.EXTRA_SESSION_TOKEN, token)
                .putExtra(NivoraVpnService.EXTRA_DEVICE_ID, deviceId)
                .putExtra(NivoraVpnService.EXTRA_LABEL, subscription.locationName ?: subscription.planName)
        )
    }

    private fun loadDashboard(initial: Boolean) {
        val token = activeSessionToken ?: run { logout(); return }
        if (dashboardValidationInFlight || state.refreshing || (initial && state.loading && (state.account != null || state.reseller != null))) return
        val role = state.role
        dashboardValidationInFlight = true
        state = state.copy(
            loading = initial && state.account == null && state.reseller == null,
            refreshing = !initial,
            loadError = null
        )
        if (initial && role != "reseller" && state.account == null) {
            loadInitialCustomerDashboard(token)
            return
        }
        background(
            work = {
                if (role == "reseller") {
                    val reseller = CompletableFuture.supplyAsync { api.resellerAccount(token) }
                    val resellerPlans = CompletableFuture.supplyAsync { api.resellerPlans(token) }
                    val tickets = CompletableFuture.supplyAsync { api.tickets(token,"reseller") }
                    DashboardPayload(
                        reseller = reseller.join(),
                        resellerPlans = resellerPlans.join(),
                        tickets = tickets.join()
                    )
                } else {
                    // Device validation used to add a complete HTTPS round trip
                    // before any dashboard request could start. Keep the gate,
                    // but run it alongside the independent account payloads so
                    // first paint costs one network latency instead of two.
                    val binding = CompletableFuture.runAsync { api.bindDevice(token) }
                    val account = CompletableFuture.supplyAsync { api.account(token) }
                    val plans = CompletableFuture.supplyAsync { api.plans() }
                    val tickets = CompletableFuture.supplyAsync { api.tickets(token) }
                    val payload = DashboardPayload(account = account.join(), plans = plans.join(), tickets = tickets.join())
                    binding.join()
                    payload
                }
            },
            success = { payload ->
                if (!isCurrentSession(token)) return@background
                dashboardValidationInFlight = false
                if (payload.reseller != null) {
                    liveSessionValidated = true
                    showNewNotifications(payload.reseller.notifications)
                    state = state.copy(
                        signedIn = true,
                        loading = false,
                        refreshing = false,
                        reseller = payload.reseller,
                        resellerPlans = payload.resellerPlans,
                        resellerDirectoryLoading = false,
                        tickets = payload.tickets,
                        account = null,
                        loadError = null
                    )
                    return@background
                }
                val account = payload.account ?: return@background
                liveSessionValidated = true
                applyCustomerAccount(token, account, payload.plans, payload.tickets)
            },
            failure = { error ->
                if (!isCurrentSession(token)) return@background
                dashboardValidationInFlight = false
                if (isUnauthorized(error)) invalidateSession(token)
                else {
                    state = state.copy(loading = false, refreshing = false, loadError = friendly(error))
                    if (state.account != null || state.reseller != null) showNotice(friendly(error), true)
                }
            }
        )
    }

    /**
     * The encrypted snapshot is deliberately decoded after setContent. It may
     * paint stale values while the live request is running, but never grants
     * permission to start a VPN connection.
     */
    private fun loadCachedCustomerDashboard(token: String) {
        background(
            work = { DashboardSnapshotStore(this).readCustomer(token) },
            success = { snapshot ->
                if (snapshot == null || !isCurrentSession(token) || liveSessionValidated || state.account != null) {
                    return@background
                }
                val active = snapshot.account.subscriptions.filter { it.status == "active" && it.url != null }
                val storedId = selection.getString("subscription_id", null)
                val selectedId = active.firstOrNull { it.id == storedId }?.id ?: active.firstOrNull()?.id
                state = state.copy(
                    loading = false,
                    refreshing = dashboardValidationInFlight,
                    account = snapshot.account,
                    plans = state.plans.ifEmpty { snapshot.plans },
                    tickets = state.tickets.ifEmpty { snapshot.tickets },
                    selectedSubscriptionId = selectedId,
                    loadError = null
                )
            },
            failure = { /* A missing/corrupt cache simply leaves the live loader visible. */ }
        )
    }

    /**
     * Account data is enough to paint the home screen. Plans and tickets are
     * independent and must not keep the user behind a second full-screen loader.
     */
    private fun loadInitialCustomerDashboard(token: String) {
        state = state.copy(loading = true, refreshing = false, loadError = null)
        background(
            work = {
                val binding = CompletableFuture.runAsync { api.bindDevice(token) }
                val account = CompletableFuture.supplyAsync { api.account(token) }
                val result = account.join()
                binding.join()
                result
            },
            success = { account ->
                if (!isCurrentSession(token)) return@background
                dashboardValidationInFlight = false
                liveSessionValidated = true
                applyCustomerAccount(token, account, state.plans, state.tickets)
            },
            failure = { error ->
                if (!isCurrentSession(token)) return@background
                dashboardValidationInFlight = false
                if (isUnauthorized(error)) invalidateSession(token)
                else state = state.copy(loading = false, refreshing = false, loadError = friendly(error))
            }
        )
        background(
            work = {
                val plans = CompletableFuture.supplyAsync { api.plans() }
                val tickets = CompletableFuture.supplyAsync { api.tickets(token) }
                plans.join() to tickets.join()
            },
            success = { (plans, tickets) ->
                if (isCurrentSession(token)) {
                    state = state.copy(plans = plans, tickets = tickets)
                    if (liveSessionValidated) state.account?.let { saveDashboardSnapshot(token, it, plans, tickets) }
                }
            },
            failure = { error ->
                if (isCurrentSession(token) && isUnauthorized(error)) invalidateSession(token)
                // Plans/tickets are secondary; other failures are retried by a normal refresh.
            }
        )
    }

    private fun applyCustomerAccount(token: String, account: Account, plans: List<Plan>, tickets: List<SupportTicket>) {
        if (!isCurrentSession(token)) return
        showNewNotifications(account.notifications)
        val active = account.subscriptions.filter { it.status == "active" && it.url != null }
        val storedId = selection.getString("subscription_id", null)
        val selectedId = active.firstOrNull { it.id == storedId }?.id ?: active.firstOrNull()?.id
        selectedId?.let { selection.edit().putString("subscription_id", it).apply() }
        state = state.copy(
            signedIn = true,
            loading = false,
            refreshing = false,
            account = account,
            plans = plans,
            tickets = tickets,
            selectedSubscriptionId = selectedId,
            loadError = null
        )
        saveDashboardSnapshot(token, account, plans, tickets)
        active.firstOrNull { it.id == selectedId }?.url?.let { subscriptionUrl ->
            thread(name = "nivora-bundle-prefetch") {
                runCatching { api.subscription(subscriptionUrl, token) }
                    .onSuccess {
                        if (isCurrentSession(token)) SubscriptionBundleStore(this@MainActivity).save(subscriptionUrl, it)
                    }
                    .onFailure { error ->
                        if (isUnauthorized(error)) handler.post { invalidateSession(token) }
                    }
            }
        }
    }

    private fun saveDashboardSnapshot(token: String, account: Account, plans: List<Plan>, tickets: List<SupportTicket>) {
        thread(name = "nivora-dashboard-cache") {
            if (!isCurrentSession(token)) return@thread
            runCatching {
                DashboardSnapshotStore(this@MainActivity).saveCustomer(
                    token,
                    CustomerDashboardSnapshot(account, plans, tickets)
                )
            }
        }
    }

    private fun requestVpnStop() {
        manualDisconnectRequested = true
        networkRestartAt = System.currentTimeMillis()
        state = state.copy(vpnState = "disconnecting", vpnError = null)
        sendVpnStopCommand()
        handler.postDelayed({
            if (state.vpnState == "disconnecting" && !NivoraVpnService.isCoreRunning()) {
                vpnPreferences.edit().putString("state", "disconnected").remove("error").remove("smart_route").apply()
                manualDisconnectRequested = false
                state = state.copy(vpnState = "disconnected", vpnError = null, smartRoute = null)
            }
        }, 1_500L)
    }

    private fun sendVpnStopCommand() {
        val stopIntent = Intent(this, NivoraVpnService::class.java).setAction(NivoraVpnService.ACTION_STOP)
        runCatching { startService(stopIntent) }
            .onFailure { stopService(Intent(this, NivoraVpnService::class.java)) }
    }

    private fun <T> runAction(work: () -> T, success: (T) -> Unit) {
        if (state.actionBusy) return
        val capturedToken = activeSessionToken
        state = state.copy(actionBusy = true)
        background(
            work,
            success = {
                if (capturedToken != null && !isCurrentSession(capturedToken)) return@background
                state = state.copy(actionBusy = false)
                success(it)
            },
            failure = { error ->
                if (capturedToken != null && !isCurrentSession(capturedToken)) return@background
                state = state.copy(actionBusy = false)
                if (capturedToken != null && isUnauthorized(error)) invalidateSession(capturedToken)
                else showNotice(friendly(error), true)
            }
        )
    }

    private fun withToken(action: (String) -> Unit) {
        val token = activeSessionToken
        if (token == null) logout() else action(token)
    }

    private fun isCurrentSession(token: String): Boolean =
        SessionValidationPolicy.isCurrent(token, activeSessionToken)

    private fun invalidateSession(token: String) {
        if (!isCurrentSession(token)) return
        logout()
    }

    private fun rootCause(error: Throwable): Throwable {
        return SessionValidationPolicy.rootCause(error)
    }

    private fun isUnauthorized(error: Throwable): Boolean =
        SessionValidationPolicy.isUnauthorized(error)

    private fun showNotice(text: String, error: Boolean = false) {
        state = state.copy(notice = UiNotice(noticeIds.incrementAndGet(), text, error))
    }

    private fun showNewNotifications(items:List<CustomerNotification>){
        val seen=alertPreferences.getStringSet("seen_ids",emptySet())?.toMutableSet()?:mutableSetOf()
        val initialized=alertPreferences.getBoolean("initialized",false)
        val fresh=items.filter{it.readAt==null&&!seen.contains(it.id)}
        items.forEach{seen.add(it.id)}
        alertPreferences.edit().putStringSet("seen_ids",seen.toList().takeLast(150).toSet()).putBoolean("initialized",true).apply()
        if(!initialized||fresh.isEmpty())return
        val manager=getSystemService(NotificationManager::class.java);val channel="nivora_alerts_v3"
        val sound=android.provider.Settings.System.DEFAULT_NOTIFICATION_URI
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(channel,"اعلان‌های نیورا",NotificationManager.IMPORTANCE_HIGH).apply{enableVibration(true);vibrationPattern=longArrayOf(0,220,120,220);setSound(sound,AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())})
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fresh.take(3).forEach{n->manager.notify(n.id.hashCode(),Notification.Builder(this,channel).setSmallIcon(R.drawable.ic_nivora_notification).setContentTitle(n.title).setContentText(n.body).setContentIntent(open).setSound(sound).setAutoCancel(true).build())}
    }

    private fun scheduleNotificationWorker(){
        val request=PeriodicWorkRequestBuilder<NivoraNotificationWorker>(15,TimeUnit.MINUTES).setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("nivora-notification-poll",ExistingPeriodicWorkPolicy.UPDATE,request)
    }

    private fun friendly(error: Throwable): String {
        val resolved = rootCause(error)
        val code = (resolved as? ApiException)?.code ?: resolved.message.orEmpty()
        return when (code) {
            "INVALID_CREDENTIALS" -> "شماره موبایل یا رمز عبور صحیح نیست"
            "PHONE_ALREADY_EXISTS" -> "این شماره موبایل قبلاً ثبت شده است"
            "INVALID_ACCOUNT", "INVALID_PHONE" -> "اطلاعات واردشده معتبر نیست"
            "WEAK_PASSWORD" -> "رمز عبور باید حداقل ۸ کاراکتر باشد"
            "INSUFFICIENT_BALANCE" -> "موجودی کیف پول کافی نیست"
            "NO_CAPACITY" -> "ظرفیت این پلن فعلاً تکمیل است"
            "DISCOUNT_NOT_AVAILABLE" -> "کد تخفیف معتبر یا قابل استفاده نیست"
            "PROVISION_FAILED" -> "ساخت اشتراک ناموفق بود؛ مبلغ خودکار به کیف پول برگشت"
            "RENEW_FAILED" -> "تمدید انجام نشد؛ مبلغ خودکار به کیف پول برگشت"
            "RATE_LIMITED" -> "درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید"
            "INVALID_TOPUP" -> "مبلغ یا شماره پیگیری واریز معتبر نیست"
            "INVALID_TICKET" -> "موضوع و متن پیام را کامل وارد کنید"
            "INVALID_CUSTOMER" -> "نام یا شماره موبایل مشتری معتبر نیست"
            "CUSTOMER_ALREADY_EXISTS" -> "این شماره قبلاً در دفترچه ثبت شده است"
            "CUSTOMER_NOT_FOUND" -> "پرونده مشتری پیدا نشد"
            "SEARCH_QUERY_TOO_SHORT" -> "برای جست‌وجو حداقل سه رقم یا سه حرف وارد کنید"
            "INVALID_AMOUNT" -> "مبلغ واردشده معتبر نیست"
            "INVALID_DEBT" -> "مبلغ و دلیل بدهی را کامل وارد کنید"
            "DEBT_NOT_FOUND" -> "این بدهی دیگر فعال نیست"
            "INVALID_REVERSAL_AMOUNT" -> "مبلغ برگشت از مانده شارژ بیشتر است"
            "WALLET_TRANSFER_NOT_FOUND" -> "این انتقال دیگر قابل اصلاح نیست"
            "SUSPENSION_REASON_REQUIRED" -> "دلیل تعلیق را کامل بنویسید"
            "SUBSCRIPTION_NOT_FOUND" -> "اشتراک قابل کنترل پیدا نشد"
            "PANEL_CONTROL_FAILED" -> "کنترل اشتراک در پنل سرور انجام نشد"
            "INVALID_SERVER_RESPONSE" -> "پاسخ سرور قابل خواندن نبود"
            else -> when (resolved) {
                is SocketTimeoutException -> "پاسخ سرور طول کشید؛ دوباره تلاش کنید"
                is UnknownHostException, is ConnectException -> "اینترنت یا دسترسی به سرور برقرار نیست"
                else -> "خطایی رخ داد؛ دوباره تلاش کنید"
            }
        }
    }

    private fun friendlyVpnError(error: String?): String? {
        if (error.isNullOrBlank()) return null
        return when {
            error.contains("subscription", true) -> "دریافت اشتراک ممکن نشد"
            error.contains("timeout", true) -> "سرور در زمان مناسب پاسخ نداد"
            error.contains("empty", true) || error.contains("خالی") -> "اشتراک کانفیگ فعالی ندارد"
            error.contains("TUNNEL_UNHEALTHY", true) -> "این مسیر اینترنت واقعی نداد؛ مسیر دیگری لازم است"
            else -> "اتصال امن برقرار نشد؛ دوباره تلاش کنید"
        }
    }

    private fun registerVpnReceiver() {
        val filter = IntentFilter(NivoraVpnService.ACTION_STATE)
        ContextCompat.registerReceiver(this, vpnReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
    }

    private fun registerNetworkObserver() {
        val request = android.net.NetworkRequest.Builder()
            .addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        getSystemService(android.net.ConnectivityManager::class.java).registerNetworkCallback(request, networkCallback)
        networkCallbackRegistered = true
    }

    private fun <T> background(work: () -> T, success: (T) -> Unit, failure: (Throwable) -> Unit) {
        Thread {
            runCatching(work)
                .onSuccess { handler.post { if (!isFinishing && !isDestroyed) success(it) } }
                .onFailure { handler.post { if (!isFinishing && !isDestroyed) failure(it) } }
        }.start()
    }

    private data class DashboardPayload(
        val account: Account? = null,
        val plans: List<Plan> = emptyList(),
        val tickets: List<SupportTicket> = emptyList(),
        val reseller: ResellerAccount? = null,
        val resellerPlans: List<Plan> = emptyList()
    )
}
