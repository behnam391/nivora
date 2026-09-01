package ir.nivora.app

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.KeyguardManager
import android.media.AudioAttributes
import android.content.*
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.activity.compose.setContent
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
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

class MainActivity : FragmentActivity(), NivoraActions {
    private companion object {
        val BIOMETRIC_AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }

    private data class DeviceRecoveryCredentials(val phone: String, val password: String)
    private enum class BiometricPurpose { ENABLE, UNLOCK }

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
    private val biometricPreferences by lazy { getSharedPreferences("biometric_gate", MODE_PRIVATE) }
    private var state by mutableStateOf(NivoraUiState())
    private var receiverRegistered = false
    private var networkCallbackRegistered = false
    private var lastUnderlyingNetwork: String? = null
    private var networkRestartAt = 0L
    @Volatile private var manualDisconnectRequested = false
    @Volatile private var activeSessionToken: String? = null
    @Volatile private var liveSessionValidated = false
    @Volatile private var dashboardValidationInFlight = false
    private var requestedVpnMode = VpnConnectionMode.PRIMARY
    private var restartAfterDisconnect: VpnConnectionMode? = null
    private var deviceRecoveryCredentials: DeviceRecoveryCredentials? = null
    private lateinit var biometricPrompt: BiometricPrompt
    private var biometricPromptActive = false
    private var suppressBiometricCallback = false
    private var biometricPurpose = BiometricPurpose.UNLOCK
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
                    startVpn(VpnLifecyclePolicy.restartMode(state.vpnMode))
                }
            }
        }
    }
    private val notificationPoll=object:Runnable{override fun run(){if(activeSessionToken!=null&&!state.biometricLocked)loadDashboard(false);handler.postDelayed(this,60_000)}}

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) switchOrStartVpn(requestedVpnMode)
        else showNotice("برای اتصال باید اجازه VPN را تأیید کنید", true)
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val vpnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val vpnState = vpnPreferences.getString("state", "disconnected") ?: "disconnected"
            val error = vpnPreferences.getString("error", null)
            val smartRoute = intent?.getStringExtra(NivoraVpnService.EXTRA_SMART_ROUTE)
                ?: vpnPreferences.getString("smart_route", null)
            val mode = VpnConnectionMode.fromWire(
                intent?.getStringExtra(NivoraVpnService.EXTRA_CONNECTION_MODE)
                    ?: vpnPreferences.getString("connection_mode", null)
            )
            if (vpnState == "disconnected" || vpnState == "error") manualDisconnectRequested = false
            state = state.copy(
                vpnState = vpnState,
                vpnError = friendlyVpnError(error),
                vpnMode = mode.takeUnless { vpnState == "disconnected" },
                smartRoute = smartRoute
            )
            if (vpnState == "disconnected") {
                restartAfterDisconnect?.let { pending ->
                    restartAfterDisconnect = null
                    handler.postDelayed({ startVpn(pending) }, 250L)
                }
            }
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
        biometricPrompt = createBiometricPrompt()
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
        if (correctedState != storedState) vpnPreferences.edit().putString("state", correctedState).remove("error").remove("connection_mode").apply()
        val storedVpnMode = VpnLifecyclePolicy.restoredMode(
            vpnPreferences.getString("connection_mode", null),
            correctedState
        )
        val expectedRole = if (BuildConfig.APP_AUDIENCE == "partner") "reseller" else "customer"
        val storedToken = session.token()
        val storedRole = session.role()
        val signedIn = storedToken != null && storedRole == expectedRole
        if (!signedIn && storedToken != null) session.clear()
        if (!signedIn) biometricPreferences.edit().clear().apply()
        activeSessionToken = storedToken.takeIf { signedIn }
        val biometricEnabled = BiometricGatePolicy.shouldGate(
            BuildConfig.APP_AUDIENCE,
            hasSession = signedIn,
            enabled = biometricPreferences.getBoolean("enabled", false)
        )
        liveSessionValidated = false
        state = state.copy(
            signedIn = signedIn,
            loading = signedIn && !biometricEnabled,
            role = storedRole,
            vpnState = correctedState,
            vpnError = friendlyVpnError(vpnPreferences.getString("error", null)),
            vpnMode = storedVpnMode,
            smartRoute = vpnPreferences.getString("smart_route", null),
            biometricEnabled = biometricEnabled,
            biometricLocked = biometricEnabled
        )
        setContent {
            NivoraTheme(darkTheme = true) {
                Surface { NivoraApp(state, this@MainActivity) }
            }
        }
        if (!biometricEnabled) activeSessionToken?.let { token ->
            if (expectedRole == "customer") loadCachedCustomerDashboard(token)
            loadDashboard(initial = true)
        }
        if(signedIn)scheduleNotificationWorker()
        if(signedIn&&Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        AppUpdateNotifier.check(this){release->showNotice("نسخه ${release.versionName} آماده است؛ از اعلان بالای صفحه نصب کنید")}
        NetworkSettingsAdvisor.inspect(this)
        handler.postDelayed(notificationPoll,60_000)
    }

    override fun onResume() {
        super.onResume()
        if (state.biometricLocked && !biometricPromptActive) {
            handler.post { if (state.biometricLocked && !biometricPromptActive) requestBiometricUnlock() }
        }
    }

    override fun onStop() {
        if (BiometricGatePolicy.shouldRelock(
                BuildConfig.APP_AUDIENCE,
                hasSession = activeSessionToken != null,
                enabled = biometricPreferences.getBoolean("enabled", false),
                promptActive = biometricPromptActive,
                changingConfigurations = isChangingConfigurations
            )) {
            state = state.copy(biometricLocked = true, biometricMessage = null)
        }
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (receiverRegistered) unregisterReceiver(vpnReceiver)
        if (networkCallbackRegistered) runCatching {
            getSystemService(android.net.ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
        }
        super.onDestroy()
    }

    override fun login(phone: String, password: String, role: LoginRole) {
        if (state.actionBusy) return
        state = state.copy(actionBusy = true, deviceRecovery = null)
        background(
            work = { api.login(phone, password, if (role == LoginRole.RESELLER) "reseller" else "customer") },
            success = {
                deviceRecoveryCredentials = null
                session.save(it.token, it.role)
                activeSessionToken = it.token
                liveSessionValidated = false
                dashboardValidationInFlight = false
                scheduleNotificationWorker()
                state = state.copy(
                    signedIn = true,
                    loading = true,
                    actionBusy = false,
                    role = it.role,
                    account = null,
                    reseller = null,
                    loadError = null,
                    deviceRecovery = null
                )
                loadDashboard(initial = true)
            },
            failure = { error ->
                val code = (rootCause(error) as? ApiException)?.code.orEmpty()
                state = state.copy(actionBusy = false)
                if (role == LoginRole.CUSTOMER && DeviceRecoveryPolicy.canRequest(code)) {
                    deviceRecoveryCredentials = DeviceRecoveryCredentials(phone, password)
                    state = state.copy(
                        deviceRecovery = DeviceRecoveryUiState(
                            phone = phone,
                            reasonCode = code
                        )
                    )
                } else {
                    deviceRecoveryCredentials = null
                    showNotice(friendly(error), true)
                }
            }
        )
    }

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

    override fun requestDeviceRecovery() {
        val credentials = deviceRecoveryCredentials
        val current = state.deviceRecovery
        if (credentials == null || current == null || state.actionBusy) return
        state = state.copy(actionBusy = true, deviceRecovery = current.copy(error = null))
        background(
            work = { api.requestDeviceRecovery(credentials.phone, credentials.password) },
            success = { request ->
                state = state.copy(
                    actionBusy = false,
                    deviceRecovery = current.copy(
                        requestId = request.id,
                        status = request.status,
                        message = request.message,
                        error = null
                    )
                )
            },
            failure = { error ->
                val apiError = rootCause(error) as? ApiException
                if (apiError?.code == "DEVICE_SLOT_AVAILABLE") {
                    state = state.copy(
                        actionBusy = false,
                        deviceRecovery = current.copy(
                            status = "approved",
                            message = "یک جایگاه آزاد است؛ دوباره ورود را بزنید.",
                            error = null
                        )
                    )
                    return@background
                }
                state = state.copy(
                    actionBusy = false,
                    deviceRecovery = current.copy(error = deviceRecoveryError(error))
                )
            }
        )
    }

    override fun refreshDeviceRecovery() {
        val current = state.deviceRecovery ?: return
        val requestId = current.requestId
        if (requestId.isNullOrBlank() || state.actionBusy) return
        state = state.copy(actionBusy = true, deviceRecovery = current.copy(error = null))
        background(
            work = { api.deviceRecoveryStatus(requestId) },
            success = { request ->
                state = state.copy(
                    actionBusy = false,
                    deviceRecovery = current.copy(
                        requestId = request.id ?: requestId,
                        status = request.status,
                        message = request.message,
                        error = null
                    )
                )
            },
            failure = { error ->
                state = state.copy(
                    actionBusy = false,
                    deviceRecovery = current.copy(error = deviceRecoveryError(error))
                )
            }
        )
    }

    override fun retryDeviceRecoveryLogin() {
        val credentials = deviceRecoveryCredentials ?: return
        state = state.copy(deviceRecovery = null)
        login(credentials.phone, credentials.password, LoginRole.CUSTOMER)
    }

    override fun dismissDeviceRecovery() {
        deviceRecoveryCredentials = null
        state = state.copy(deviceRecovery = null)
    }

    override fun setBiometricEnabled(enabled: Boolean) {
        if (BuildConfig.APP_AUDIENCE != "customer") return
        if (!enabled) {
            biometricPreferences.edit().clear().apply()
            state = state.copy(biometricEnabled = false, biometricLocked = false, biometricMessage = null)
            showNotice("ورود بیومتریک خاموش شد")
            return
        }
        if (activeSessionToken == null || !state.signedIn) {
            showNotice("ابتدا با شماره موبایل و رمز نیورا وارد شوید", true)
            return
        }
        val unavailable = biometricUnavailableMessage()
        if (unavailable != null) {
            showNotice(unavailable, true)
            return
        }
        showBiometricPrompt(BiometricPurpose.ENABLE)
    }

    override fun requestBiometricUnlock() {
        if (BuildConfig.APP_AUDIENCE != "customer" || activeSessionToken == null || !state.biometricLocked) return
        val unavailable = biometricUnavailableMessage()
        if (unavailable != null) {
            state = state.copy(biometricMessage = unavailable)
            return
        }
        showBiometricPrompt(BiometricPurpose.UNLOCK)
    }

    override fun refresh() = loadDashboard(initial = false)

    override fun selectSubscription(subscription: Subscription) {
        selection.edit().putString("subscription_id", subscription.id).apply()
        state = state.copy(selectedSubscriptionId = subscription.id, pingMs = null)
    }

    override fun toggleVpn() {
        requestVpn(VpnConnectionMode.PRIMARY)
    }

    override fun toggleEmergencyVpn() {
        requestVpn(VpnConnectionMode.EMERGENCY)
    }

    override fun acceptVpnDisclosure() {
        selection.edit().putBoolean("vpn_disclosure_accepted", true).apply()
        state = state.copy(showVpnDisclosure = false)
        continueVpnRequest(requestedVpnMode)
    }

    override fun dismissVpnDisclosure() {
        state = state.copy(showVpnDisclosure = false)
    }

    override fun acceptEmergencyDisclosure() {
        selection.edit().putBoolean("emergency_disclosure_accepted_v1", true).apply()
        state = state.copy(showEmergencyDisclosure = false)
        continueVpnRequest(VpnConnectionMode.EMERGENCY)
    }

    override fun dismissEmergencyDisclosure() {
        state = state.copy(showEmergencyDisclosure = false)
    }

    private fun requestVpn(mode: VpnConnectionMode) {
        if (BuildConfig.APP_AUDIENCE != "customer") return
        if ((state.vpnState == "connected" || state.vpnState == "connecting") && state.vpnMode == mode) {
            restartAfterDisconnect = null
            requestVpnStop()
            return
        }
        if (state.vpnState == "disconnecting") return
        if (!SessionValidationPolicy.canStartVpn(state.signedIn, liveSessionValidated)) {
            showNotice(sessionValidationNotice(), true)
            if (!state.loading && !state.refreshing && !dashboardValidationInFlight) {
                loadDashboard(initial = state.account == null && state.reseller == null)
            }
            return
        }
        val subscription = state.selectedSubscription
        if (subscription?.url.isNullOrBlank()) {
            showNotice("برای استفاده از اتصال، ابتدا یک اشتراک فعال لازم است", true)
            return
        }
        if (mode == VpnConnectionMode.EMERGENCY && state.account?.emergency?.available != true) {
            showNotice("در حال حاضر مسیر اضطراری سالمی آماده نیست", true)
            if (!state.refreshing && !dashboardValidationInFlight) loadDashboard(initial = false)
            return
        }
        selectSubscription(subscription!!)
        requestedVpnMode = mode
        if (!selection.getBoolean("vpn_disclosure_accepted", false)) {
            state = state.copy(showVpnDisclosure = true)
            return
        }
        continueVpnRequest(mode)
    }

    private fun continueVpnRequest(mode: VpnConnectionMode) {
        requestedVpnMode = mode
        if (mode == VpnConnectionMode.EMERGENCY &&
            !selection.getBoolean("emergency_disclosure_accepted_v1", false)
        ) {
            state = state.copy(showEmergencyDisclosure = true)
            return
        }
        val permissionIntent = VpnService.prepare(this)
        if (permissionIntent != null) vpnPermission.launch(permissionIntent) else switchOrStartVpn(mode)
    }

    private fun switchOrStartVpn(mode: VpnConnectionMode) {
        if ((state.vpnState == "connected" || state.vpnState == "connecting") && state.vpnMode != mode) {
            restartAfterDisconnect = mode
            requestVpnStop()
        } else {
            startVpn(mode)
        }
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
            work = {
                val uri = android.net.Uri.parse(receiptUri)
                try {
                    val mimeType = ReceiptUploadPolicy.acceptedMimeType(contentResolver.getType(uri))
                        ?: throw ApiException("INVALID_RECEIPT", 400)
                    val bytes = try {
                        contentResolver.openInputStream(uri)?.use { ReceiptUploadPolicy.readBounded(it) }
                            ?: throw ApiException("INVALID_RECEIPT", 400)
                    } catch (_: ReceiptTooLargeException) {
                        throw ApiException("RECEIPT_TOO_LARGE", 413)
                    }
                    if (bytes.isEmpty()) throw ApiException("INVALID_RECEIPT", 400)
                    val uploaded = api.uploadReceipt(token, bytes, mimeType)
                    api.topup(token, amountToman, reference, uploaded)
                } finally {
                    cleanupOwnedReceipt(uri)
                }
            },
            success = { showNotice("درخواست شارژ برای بررسی ارسال شد"); loadDashboard(initial = false) }
        )
    }

    private fun cleanupOwnedReceipt(uri: android.net.Uri) {
        if (uri.scheme == "content" && uri.authority == "${packageName}.receipt-files") {
            runCatching { contentResolver.delete(uri, null, null) }
        }
    }

    override fun createTicket(subject: String, body: String) = withToken { token ->
        runAction(
            work = { api.createTicket(token, subject, body, state.role) },
            success = { showNotice("تیکت برای پشتیبانی ارسال شد"); loadDashboard(initial = false) }
        )
    }

    override fun askAiSupport(question: String) = withToken { token ->
        if (question.trim().length < 3) { showNotice("پرسش را کامل‌تر بنویسید", true); return@withToken }
        state = state.copy(aiSupportBusy = true)
        background(
            work = { api.askAiSupport(token, question) },
            success = { state = state.copy(aiSupportBusy = false, aiSupportAnswer = it) },
            failure = { state = state.copy(aiSupportBusy = false); showNotice(friendly(it), true) }
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

    override fun changePassword(currentPassword: String, newPassword: String) = withToken { token ->
        if (state.role != "customer") return@withToken
        runAction(
            work = { api.changePassword(token, currentPassword, newPassword) },
            success = { showNotice("رمز عبور با موفقیت تغییر کرد؛ نشست‌های دیگر بسته شدند") }
        )
    }

    override fun changeName(name: String) = withToken { token ->
        if (state.role != "customer") return@withToken
        runAction(
            work = { api.changeName(token, name) },
            success = { showNotice("نام حساب تغییر کرد"); loadDashboard(initial = false) }
        )
    }

    override fun clearNotifications() = withToken { token ->
        runAction(
            work = { api.clearNotifications(token, state.role) },
            success = {
                state = if (state.role == "reseller") {
                    state.copy(reseller = state.reseller?.copy(notifications = emptyList()))
                } else {
                    state.copy(account = state.account?.copy(notifications = emptyList()))
                }
                showNotice("اعلان‌های نمایش‌داده‌شده پاک‌سازی شدند")
                loadDashboard(initial = false)
            }
        )
    }

    override fun clearTickets() = withToken { token ->
        runAction(
            work = { api.clearTickets(token, state.role) },
            success = {
                state = state.copy(tickets = emptyList(), ticketConversation = null)
                showNotice("گفتگوهای پشتیبانی آرشیو شدند")
                loadDashboard(initial = false)
            }
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
        restartAfterDisconnect = null
        requestedVpnMode = VpnConnectionMode.PRIMARY
        suppressBiometricCallback = true
        biometricPromptActive = false
        if (::biometricPrompt.isInitialized) runCatching { biometricPrompt.cancelAuthentication() }
        biometricPreferences.edit().clear().apply()
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

    private fun startVpn(mode: VpnConnectionMode) {
        if (!SessionValidationPolicy.canStartVpn(state.signedIn, liveSessionValidated)) {
            showNotice(sessionValidationNotice(), true)
            return
        }
        val token = activeSessionToken ?: return
        val subscription = state.selectedSubscription ?: return
        val url = if (mode == VpnConnectionMode.EMERGENCY) {
            EmergencyConnectPolicy.endpoint(BuildConfig.API_BASE_URL)
        } else {
            subscription.url ?: return
        }
        if (mode == VpnConnectionMode.EMERGENCY &&
            !EmergencyConnectPolicy.isEmergencyEndpoint(BuildConfig.API_BASE_URL, url)
        ) {
            showNotice("مسیر اضطراری معتبر نیست", true)
            return
        }
        manualDisconnectRequested = false
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        state = state.copy(vpnState = "connecting", vpnError = null, vpnMode = mode)
        startForegroundService(
            Intent(this, NivoraVpnService::class.java)
                .putExtra(NivoraVpnService.EXTRA_URL, url)
                .putExtra(
                    NivoraVpnService.EXTRA_SUBSCRIPTION_ID,
                    subscription.id.takeIf { mode == VpnConnectionMode.PRIMARY }
                )
                .putExtra(NivoraVpnService.EXTRA_SESSION_TOKEN, token)
                .putExtra(NivoraVpnService.EXTRA_DEVICE_ID, deviceId)
                .putExtra(
                    NivoraVpnService.EXTRA_LABEL,
                    if (mode == VpnConnectionMode.EMERGENCY) "اتصال اضطراری"
                    else subscription.locationName ?: subscription.planName
                )
                .putExtra(NivoraVpnService.EXTRA_CONNECTION_MODE, mode.wireValue)
        )
    }

    private fun sessionValidationNotice(): String = when {
        state.account != null && !state.loadError.isNullOrBlank() ->
            "ارتباط امن با سرور برقرار نشد؛ شبکه را بررسی و دوباره تلاش کنید"
        dashboardValidationInFlight ->
            "در حال بررسی امن حساب؛ چند لحظه دیگر دوباره بزنید"
        else ->
            "تأیید آنلاین حساب انجام نشد؛ صفحه را تازه‌سازی کنید"
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
        if (EmergencyConnectPolicy.shouldStopAfterDashboard(state.vpnMode, state.vpnState, account.emergency)) {
            restartAfterDisconnect = null
            showNotice("اتصال اضطراری توسط مدیریت متوقف شد", true)
            requestVpnStop()
        }
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
                vpnPreferences.edit().putString("state", "disconnected").remove("error").remove("smart_route").remove("connection_mode").apply()
                manualDisconnectRequested = false
                state = state.copy(vpnState = "disconnected", vpnError = null, vpnMode = null, smartRoute = null)
                restartAfterDisconnect?.let { pending ->
                    restartAfterDisconnect = null
                    handler.postDelayed({ startVpn(pending) }, 250L)
                }
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

    private fun createBiometricPrompt(): BiometricPrompt = BiometricPrompt(
        this,
        ContextCompat.getMainExecutor(this),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                biometricPromptActive = false
                if (suppressBiometricCallback) return
                when (biometricPurpose) {
                    BiometricPurpose.ENABLE -> {
                        biometricPreferences.edit().putBoolean("enabled", true).apply()
                        state = state.copy(biometricEnabled = true, biometricLocked = false, biometricMessage = null)
                        showNotice("ورود بیومتریک فعال شد")
                    }
                    BiometricPurpose.UNLOCK -> {
                        state = state.copy(biometricLocked = false, biometricMessage = null)
                        val token = activeSessionToken
                        if (token != null && state.account == null) {
                            state = state.copy(loading = true)
                            loadCachedCustomerDashboard(token)
                            loadDashboard(initial = true)
                        } else if (token != null) {
                            loadDashboard(initial = false)
                        }
                    }
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                biometricPromptActive = false
                if (suppressBiometricCallback) return
                val message = biometricPromptError(errorCode)
                if (biometricPurpose == BiometricPurpose.ENABLE) {
                    showNotice(message, true)
                } else {
                    state = state.copy(biometricLocked = true, biometricMessage = message)
                }
            }

            override fun onAuthenticationFailed() {
                if (suppressBiometricCallback) return
                if (biometricPurpose == BiometricPurpose.UNLOCK) {
                    state = state.copy(biometricMessage = "اثر انگشت یا چهره شناخته نشد؛ دوباره امتحان کنید.")
                }
            }
        }
    )

    private fun showBiometricPrompt(purpose: BiometricPurpose) {
        if (biometricPromptActive) return
        suppressBiometricCallback = false
        biometricPurpose = purpose
        biometricPromptActive = true
        if (purpose == BiometricPurpose.UNLOCK) state = state.copy(biometricMessage = null)
        val builder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(if (purpose == BiometricPurpose.ENABLE) "فعال‌سازی ورود امن" else "بازکردن Nivora")
            .setSubtitle("با اثر انگشت، تشخیص چهره یا قفل امن گوشی تأیید کنید")
            .setConfirmationRequired(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(BIOMETRIC_AUTHENTICATORS)
        } else {
            @Suppress("DEPRECATION")
            builder.setDeviceCredentialAllowed(true)
        }
        runCatching { biometricPrompt.authenticate(builder.build()) }
            .onFailure { error ->
                biometricPromptActive = false
                val message = error.message?.takeIf(String::isNotBlank) ?: "قفل امن گوشی در دسترس نیست."
                if (purpose == BiometricPurpose.ENABLE) showNotice(message, true)
                else state = state.copy(biometricMessage = message)
            }
    }

    private fun biometricUnavailableMessage(): String? {
        val manager = BiometricManager.from(this)
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            manager.canAuthenticate(BIOMETRIC_AUTHENTICATORS)
        } else {
            val biometric = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK)
            val secureLock = getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
            if (biometric == BiometricManager.BIOMETRIC_SUCCESS || secureLock) BiometricManager.BIOMETRIC_SUCCESS else biometric
        }
        return when (result) {
            BiometricManager.BIOMETRIC_SUCCESS -> null
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "حسگر امنیتی گوشی موقتاً در دسترس نیست؛ کمی بعد دوباره امتحان کنید."
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "ابتدا در تنظیمات گوشی اثر انگشت، چهره، PIN، الگو یا رمز امن تنظیم کنید."
            else -> "قفل امن این دستگاه برای ورود بیومتریک آماده نیست."
        }
    }

    private fun biometricPromptError(errorCode: Int): String = when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "تأیید لغو شد؛ برای ادامه دوباره دکمه بازکردن را بزنید."
        BiometricPrompt.ERROR_LOCKOUT,
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "تلاش‌های ناموفق زیاد بود؛ با قفل امن گوشی وارد شوید یا کمی صبر کنید."
        BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "ابتدا در تنظیمات گوشی یک روش قفل امن فعال کنید."
        BiometricPrompt.ERROR_HW_UNAVAILABLE -> "حسگر امنیتی گوشی موقتاً در دسترس نیست."
        else -> "تأیید امن انجام نشد؛ دوباره امتحان کنید."
    }

    private fun showNewNotifications(items:List<CustomerNotification>){
        val seen=alertPreferences.getStringSet("seen_ids",emptySet())?.toMutableSet()?:mutableSetOf()
        val initialized=alertPreferences.getBoolean("initialized",false)
        val fresh=items.filter{it.readAt==null&&!seen.contains(it.id)}
        items.forEach{seen.add(it.id)}
        alertPreferences.edit().putStringSet("seen_ids",seen.toList().takeLast(150).toSet()).putBoolean("initialized",true).apply()
        if(!initialized||fresh.isEmpty())return
        val manager=getSystemService(NotificationManager::class.java);val channel="nivora_alerts_v4"
        val sound=android.provider.Settings.System.DEFAULT_NOTIFICATION_URI
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(NotificationChannel(channel,"اعلان‌های نیورا",NotificationManager.IMPORTANCE_HIGH).apply{enableVibration(true);setShowBadge(true);vibrationPattern=longArrayOf(0,220,120,220);setSound(sound,AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())})
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fresh.take(3).forEachIndexed{index,n->manager.notify(n.id.hashCode(),Notification.Builder(this,channel).setSmallIcon(R.drawable.ic_nivora_notification).setContentTitle(n.title).setContentText(n.body).setContentIntent(open).setSound(sound).setNumber(fresh.size-index).setAutoCancel(true).build())}
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
            "INVALID_CURRENT_PASSWORD" -> "رمز عبور فعلی صحیح نیست"
            "PASSWORD_UNCHANGED" -> "رمز جدید باید با رمز فعلی متفاوت باشد"
            "WEAK_PASSWORD" -> "رمز جدید باید حداقل ۸ نویسه باشد"
            "DEVICE_ALREADY_BOUND", "DEVICE_LIMIT_REACHED" -> "ظرفیت دستگاه‌های این حساب تکمیل است"
            "DEVICE_REQUIRED" -> "شناسه امن دستگاه در دسترس نیست؛ برنامه را دوباره باز کنید"
            "PHONE_ALREADY_EXISTS" -> "این شماره موبایل قبلاً ثبت شده است"
            "INVALID_ACCOUNT", "INVALID_PHONE" -> "اطلاعات واردشده معتبر نیست"
            "INSUFFICIENT_BALANCE" -> "موجودی کیف پول کافی نیست"
            "NO_CAPACITY" -> "ظرفیت این پلن فعلاً تکمیل است"
            "DISCOUNT_NOT_AVAILABLE" -> "کد تخفیف معتبر یا قابل استفاده نیست"
            "PROVISION_FAILED" -> "ساخت اشتراک ناموفق بود؛ مبلغ خودکار به کیف پول برگشت"
            "RENEW_FAILED" -> "تمدید انجام نشد؛ مبلغ خودکار به کیف پول برگشت"
            "RATE_LIMITED" -> "درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید"
            "INVALID_TOPUP", "INVALID_PAYMENT_AMOUNT" -> "مبلغ یا شماره پیگیری واریز معتبر نیست"
            "RECEIPT_REQUIRED" -> "شماره پیگیری و تصویر رسید را کامل وارد کنید"
            "INVALID_RECEIPT", "INVALID_RECEIPT_TYPE" -> "تصویر رسید باید JPG، PNG یا WebP معتبر باشد"
            "RECEIPT_TOO_LARGE", "PAYMENT_BODY_TOO_LARGE" -> "حجم تصویر رسید باید کمتر از ۴ مگابایت باشد"
            "RECEIPT_NOT_AVAILABLE", "RECEIPT_ALREADY_USED" -> "این تصویر رسید معتبر نیست یا قبلاً استفاده شده؛ دوباره انتخاب کنید"
            "TOO_MANY_PENDING_TOPUPS" -> "پنج درخواست شارژ شما در حال بررسی است؛ ابتدا منتظر نتیجه بمانید"
            "RECEIPT_RATE_LIMITED" -> "تعداد آپلودها زیاد بود؛ کمی بعد دوباره تلاش کنید"
            "RECEIPT_STORAGE_BUSY" -> "فضای دریافت رسید موقتاً در دسترس نیست؛ کمی بعد دوباره تلاش کنید"
            "INVALID_TICKET" -> "موضوع و متن پیام را کامل وارد کنید"
            "INVALID_AI_QUESTION" -> "پرسش را کامل‌تر بنویسید"
            "AI_NOT_CONFIGURED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_TIMEOUT", "AI_PROVIDER_ERROR" -> "دستیار هوشمند موقتاً در دسترس نیست؛ از تیکت پشتیبانی استفاده کنید"
            "AI_RATE_LIMITED" -> "ظرفیت دستیار موقتاً تکمیل است؛ کمی بعد دوباره امتحان کنید"
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

    private fun deviceRecoveryError(error: Throwable): String {
        val resolved = rootCause(error)
        val apiError = resolved as? ApiException
        return when {
            apiError?.status == 404 || apiError?.status == 405 || apiError?.status == 501 ->
                "سامانه درخواست آزادسازی هنوز روی سرور فعال نشده است؛ کمی بعد دوباره امتحان کنید."
            apiError?.code == "INVALID_CREDENTIALS" -> "رمز عبور صحیح نیست؛ دوباره وارد شوید."
            apiError?.code == "DEVICE_RECOVERY_ALREADY_PENDING" -> "درخواست قبلی شما هنوز در انتظار بررسی است."
            apiError?.code == "DEVICE_SLOT_AVAILABLE" -> "یک جایگاه آزاد است؛ دوباره ورود را بزنید."
            apiError?.code == "RATE_LIMITED" -> "تعداد درخواست‌ها زیاد بود؛ چند دقیقه بعد دوباره امتحان کنید."
            else -> friendly(error)
        }
    }

    private fun friendlyVpnError(error: String?): String? {
        if (error.isNullOrBlank()) return null
        return when {
            error.contains("EMERGENCY_LEASE_EXPIRED", true) -> "اتصال اضطراری توسط مدیریت یا پایان اعتبار متوقف شد"
            error.contains("EMERGENCY_NO_WORKING_ROUTE", true) -> "مسیر اضطراری فعالی پیدا نشد؛ کمی بعد دوباره امتحان کنید"
            error.contains("EMERGENCY_NO_SAFE_ROUTE", true) -> "مسیر اضطراری سالمی پیدا نشد"
            error.contains("EMERGENCY", true) -> "اتصال اضطراری فعلاً در دسترس نیست"
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
