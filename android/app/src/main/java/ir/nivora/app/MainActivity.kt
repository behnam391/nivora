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
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit
import java.util.concurrent.CompletableFuture
import java.util.UUID

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
                if (previous != null && previous != key && state.vpnState == "connected" &&
                    System.currentTimeMillis() - networkRestartAt > 5_000) {
                    networkRestartAt = System.currentTimeMillis()
                    showNotice("شبکه تغییر کرد؛ مسیر هوشمند دوباره انتخاب می‌شود")
                    startSelectedVpn()
                }
            }
        }
    }
    private val notificationPoll=object:Runnable{override fun run(){if(session.token()!=null)loadDashboard(false);handler.postDelayed(this,60_000)}}

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
            state = state.copy(vpnState = vpnState, vpnError = friendlyVpnError(error), smartRoute = smartRoute)
            if (vpnState == "connected") handler.postDelayed({ refresh() }, 3_500)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        session = SecureSessionStore(this)
        registerVpnReceiver()
        registerNetworkObserver()
        val storedState = vpnPreferences.getString("state", "disconnected") ?: "disconnected"
        val correctedState = if (storedState in setOf("connected", "connecting") && !NivoraVpnService.isCoreRunning()) "disconnected" else storedState
        if (correctedState != storedState) vpnPreferences.edit().putString("state", correctedState).remove("error").apply()
        val expectedRole = if (BuildConfig.APP_AUDIENCE == "partner") "reseller" else "customer"
        val signedIn = session.token() != null && session.role() == expectedRole
        if (!signedIn && session.token() != null) session.clear()
        state = state.copy(signedIn = signedIn, loading = signedIn, role = session.role(), vpnState = correctedState, vpnError = friendlyVpnError(vpnPreferences.getString("error", null)), smartRoute = vpnPreferences.getString("smart_route", null))
        setContent {
            NivoraTheme {
                Surface { NivoraApp(state, this@MainActivity) }
            }
        }
        if (signedIn) loadDashboard(initial = true)
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
            scheduleNotificationWorker()
            state = state.copy(signedIn = true, loading = true, role = it.role, account = null, reseller = null, loadError = null)
            loadDashboard(initial = true)
        }
    )

    override fun register(name: String, phone: String, password: String) = runAction(
        work = { api.register(name, phone, password) },
        success = {
            session.save(it.token, "customer")
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
        if (state.vpnState == "connected" || state.vpnState == "connecting") {
            startService(Intent(this, NivoraVpnService::class.java).setAction(NivoraVpnService.ACTION_STOP))
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
        val account = state.account ?: return@withToken
        if (account.notifications.none { it.readAt == null }) return@withToken
        state = state.copy(account = account.copy(notifications = account.notifications.map { it.copy(readAt = it.readAt ?: "read") }))
        background(
            work = { api.markNotificationsRead(token, state.role) },
            success = { },
            failure = { if ((it as? ApiException)?.code == "UNAUTHORIZED") logout() }
        )
    }

    override fun openNetworkLab() {
        if (BuildConfig.NETWORK_LAB_ENABLED) startActivity(Intent(this, NetworkLabActivity::class.java))
    }

    override fun createResellerCustomer(name: String, phone: String, password:String, note: String) = withToken { token ->
        runAction(
            work = { api.createResellerCustomer(token, name, phone, password, note) },
            success = { showNotice("مشتری به دفترچه اضافه شد"); loadDashboard(initial = false) }
        )
    }

    override fun resetResellerCustomerPassword(customer:ResellerCustomer,password:String)=withToken{token->runAction(work={api.resetResellerCustomerPassword(token,customer.id,password)},success={showNotice("رمز مشتری تغییر کرد");loadDashboard(false)})}

    override fun resellerPurchase(plan: Plan, customer: ResellerCustomer, salePriceToman: Int) = withToken { token ->
        runAction(
            work = { api.resellerPurchase(token, plan.id, customer.id, salePriceToman) },
            success = { result ->
                result.subscriptionUrl?.let { copyText(it, "اشتراک ساخته شد و لینک آن کپی شد") } ?: showNotice("اشتراک با موفقیت ساخته شد")
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

    override fun copyText(value: String, message: String) {
        if (value.isBlank()) return
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Nivora", value))
        showNotice(message)
    }

    override fun logout() {
        startService(Intent(this, NivoraVpnService::class.java).setAction(NivoraVpnService.ACTION_STOP))
        session.clear()
        WorkManager.getInstance(this).cancelUniqueWork("nivora-notification-poll")
        selection.edit().clear().apply()
        state = NivoraUiState(vpnState = "disconnected")
    }

    override fun consumeNotice() {
        state = state.copy(notice = null)
    }

    private fun startSelectedVpn() {
        val url = state.selectedSubscription?.url
        if (url.isNullOrBlank()) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        state = state.copy(vpnState = "connecting", vpnError = null)
        startForegroundService(
            Intent(this, NivoraVpnService::class.java)
                .putExtra(NivoraVpnService.EXTRA_URL, url)
                .putExtra(NivoraVpnService.EXTRA_SESSION_TOKEN, session.token())
                .putExtra(NivoraVpnService.EXTRA_DEVICE_ID, deviceId)
                .putExtra(NivoraVpnService.EXTRA_LABEL, state.selectedSubscription?.locationName ?: state.selectedSubscription?.planName)
        )
    }

    private fun loadDashboard(initial: Boolean) {
        val token = session.token() ?: run { logout(); return }
        if (state.refreshing || (initial && state.loading && (state.account != null || state.reseller != null))) return
        state = state.copy(
            loading = initial && state.account == null && state.reseller == null,
            refreshing = !initial,
            loadError = null
        )
        background(
            work = {
                if (state.role == "reseller") {
                    val reseller = CompletableFuture.supplyAsync { api.resellerAccount(token) }
                    val resellerPlans = CompletableFuture.supplyAsync { api.resellerPlans(token) }
                    val tickets = CompletableFuture.supplyAsync { api.tickets(token,"reseller") }
                    DashboardPayload(reseller = reseller.join(), resellerPlans = resellerPlans.join(), tickets = tickets.join())
                } else {
                    api.bindDevice(token)
                    val account = CompletableFuture.supplyAsync { api.account(token) }
                    val plans = CompletableFuture.supplyAsync { api.plans() }
                    val tickets = CompletableFuture.supplyAsync { api.tickets(token) }
                    DashboardPayload(account = account.join(), plans = plans.join(), tickets = tickets.join())
                }
            },
            success = { payload ->
                if (payload.reseller != null) {
                    showNewNotifications(payload.reseller.notifications)
                    state = state.copy(signedIn = true, loading = false, refreshing = false, reseller = payload.reseller, resellerPlans = payload.resellerPlans, tickets = payload.tickets, account = null, loadError = null)
                    return@background
                }
                val account = payload.account ?: return@background
                showNewNotifications(account.notifications)
                val plans = payload.plans
                val tickets = payload.tickets
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
            },
            failure = { error ->
                if ((error as? ApiException)?.code == "UNAUTHORIZED") {
                    state = state.copy(loading = false, refreshing = false, loadError = friendly(error))
                } else {
                    state = state.copy(loading = false, refreshing = false, loadError = friendly(error))
                    if (state.account != null || state.reseller != null) showNotice(friendly(error), true)
                }
            }
        )
    }

    private fun <T> runAction(work: () -> T, success: (T) -> Unit) {
        if (state.actionBusy) return
        state = state.copy(actionBusy = true)
        background(
            work,
            success = { state = state.copy(actionBusy = false); success(it) },
            failure = { state = state.copy(actionBusy = false); showNotice(friendly(it), true) }
        )
    }

    private fun withToken(action: (String) -> Unit) {
        val token = session.token()
        if (token == null) logout() else action(token)
    }

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
        val code = (error as? ApiException)?.code ?: error.message.orEmpty()
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
            "INVALID_SERVER_RESPONSE" -> "پاسخ سرور قابل خواندن نبود"
            else -> when (error) {
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
