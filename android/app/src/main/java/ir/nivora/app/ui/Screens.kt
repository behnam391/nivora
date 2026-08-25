package ir.nivora.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Login
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.Subject
import androidx.compose.material.icons.automirrored.rounded.TrendingUp
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import ir.nivora.app.BuildConfig
import ir.nivora.app.data.*

@Composable
fun NivoraApp(state: NivoraUiState, actions: NivoraActions) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.notice?.id) {
        state.notice?.let {
            snackbar.showSnackbar(it.text, withDismissAction = true, duration = SnackbarDuration.Short)
            actions.consumeNotice()
        }
    }
    CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides LayoutDirection.Rtl) {
        when {
            !state.signedIn -> Box(Modifier.fillMaxSize()) {
                AuthScreen(state.actionBusy, actions)
                SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp))
            }
            state.loading && state.account == null && state.reseller == null -> FullScreenLoading()
            state.loadError != null && state.account == null && state.reseller == null -> FullScreenError(state.loadError, actions::refresh, actions::logout)
            state.role == "reseller" -> PartnerAppDashboard(state, actions, snackbar)
            else -> MainDashboard(state, actions, snackbar)
        }
    }
}

@Composable
private fun AuthScreen(busy: Boolean, actions: NivoraActions) {
    val partnerApp = BuildConfig.APP_AUDIENCE == "partner"
    var loginRole by rememberSaveable { mutableStateOf(if (partnerApp) LoginRole.RESELLER else LoginRole.CUSTOMER) }
    var registerMode by rememberSaveable { mutableStateOf(false) }
    var recoveryOpen by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var validation by rememberSaveable { mutableStateOf<String?>(null) }

    fun submit() {
        validation = when {
            registerMode && name.trim().length < 3 -> "نام و نام خانوادگی را کامل وارد کنید"
            !phone.matches(Regex("09\\d{9}")) -> "شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود"
            password.length < 8 -> "رمز عبور باید حداقل ۸ کاراکتر باشد"
            else -> null
        }
        if (validation == null) {
            if (registerMode) actions.register(name.trim(), phone, password) else actions.login(phone, password, loginRole)
        }
    }

    AuroraBackground(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = 20.dp, vertical = 22.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(Modifier.height(12.dp))
            NivoraLogo(modifier = Modifier.fillMaxWidth(), compact = false, onDark = true)
            Spacer(Modifier.height(24.dp))
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(.90f)),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(.30f)),
                elevation = CardDefaults.cardElevation(4.dp)
            ) {
                Column(Modifier.padding(21.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
                    Text(if (registerMode) "ساخت حساب جدید" else if (partnerApp) "Nivora Partner" else "خوش آمدید", style = MaterialTheme.typography.headlineMedium)
                    Text(
                        if (registerMode) "حساب Nivora را در چند ثانیه بسازید." else if (partnerApp) "مشتریان، فروش‌ها و تمدیدها را مدیریت کنید." else "برای مدیریت و اتصال اشتراک وارد شوید.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium
                    )
                    if (!partnerApp) Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(4.dp)) {
                        AuthTab("ورود", !registerMode) { registerMode = false; validation = null }
                        AuthTab("ثبت‌نام", registerMode) { registerMode = true; validation = null }
                    } else {
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(14.dp)).padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.Storefront, null, tint = MaterialTheme.colorScheme.primary)
                            Spacer(Modifier.width(9.dp))
                            Text("حساب همکار توسط مدیریت ساخته و شارژ می‌شود.", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    if (registerMode) {
                        NivoraField(
                            value = name,
                            onValueChange = { name = it },
                            label = "نام و نام خانوادگی",
                            icon = Icons.Rounded.PersonOutline,
                            imeAction = ImeAction.Next
                        )
                    }
                    NivoraField(
                        value = phone,
                        onValueChange = { phone = it.filter(Char::isDigit).take(11) },
                        label = "شماره موبایل",
                        icon = Icons.Rounded.PhoneAndroid,
                        keyboardType = KeyboardType.Phone,
                        imeAction = ImeAction.Next
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("رمز عبور") },
                        leadingIcon = { Icon(Icons.Rounded.Lock, null) },
                        trailingIcon = {
                            IconButton(onClick = { showPassword = !showPassword }) {
                                Icon(if (showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, null)
                            }
                        },
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        shape = RoundedCornerShape(16.dp)
                    )
                    validation?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(
                        onClick = ::submit,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth().height(54.dp)
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(22.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
                        else {
                            Icon(if (registerMode) Icons.Rounded.PersonAdd else Icons.AutoMirrored.Rounded.Login, null)
                            Spacer(Modifier.width(8.dp))
                            Text(if (registerMode) "ساخت حساب" else if (partnerApp) "ورود به مرکز همکاری" else "ورود به Nivora")
                        }
                    }
                    if (!registerMode && loginRole == LoginRole.CUSTOMER) TextButton(onClick = { recoveryOpen = true }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                        Text("رمز عبور را فراموش کرده‌اید؟")
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.VerifiedUser, null, tint = Color(0xFFB9CBE8), modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("اطلاعات ورود روی دستگاه رمزگذاری می‌شود", color = Color(0xFFB9CBE8), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
    if (recoveryOpen) RecoveryDialog({recoveryOpen=false}){actions.openTelegramRecovery();recoveryOpen=false}
}

@Composable
private fun RowScope.AuthTab(label: String, active: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.weight(1f).clip(RoundedCornerShape(11.dp)).background(if (active) MaterialTheme.colorScheme.surface else Color.Transparent).clickable(onClick = onClick).padding(vertical = 10.dp),
        contentAlignment = Alignment.Center
    ) { Text(label, color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.Bold) }
}

@Composable
private fun NivoraField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    icon: ImageVector,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        leadingIcon = { Icon(icon, null) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
        shape = RoundedCornerShape(16.dp)
    )
}

@Composable
private fun RecoveryDialog(onDismiss:()->Unit,onTelegram:()->Unit) {
    AppDialog(onDismiss) {
        DialogTitle(Icons.Rounded.Key,"بازیابی رمز عبور","شماره حساب را با دکمه رسمی تلگرام تأیید و رمز تازه را داخل ربات ثبت کنید.")
        Button(onClick=onTelegram,modifier=Modifier.fillMaxWidth()){Icon(Icons.AutoMirrored.Rounded.Send,null);Spacer(Modifier.width(7.dp));Text("ورود به ربات بازیابی")}
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun MainDashboard(state: NivoraUiState, actions: NivoraActions, snackbar: SnackbarHostState) {
    var destination by rememberSaveable { mutableStateOf(AppDestination.HOME) }
    var purchasePlan by remember { mutableStateOf<Plan?>(null) }
    var renewSubscription by remember { mutableStateOf<Subscription?>(null) }
    var topupOpen by rememberSaveable { mutableStateOf(false) }
    var ticketOpen by rememberSaveable { mutableStateOf(false) }

    AuroraBackground(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = Color.Transparent,
            snackbarHost = { SnackbarHost(snackbar, modifier = Modifier.navigationBarsPadding()) },
            bottomBar = {
                NavigationBar(
                    modifier = Modifier
                        .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outline.copy(.22f), RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)),
                    containerColor = MaterialTheme.colorScheme.surface.copy(alpha = .82f),
                    tonalElevation = 0.dp
                ) {
                    NavigationItem(AppDestination.HOME, destination, Icons.Rounded.Home, "خانه") { destination = it }
                    NavigationItem(AppDestination.PLANS, destination, Icons.Rounded.ShoppingBag, "پلن‌ها") { destination = it }
                    NavigationItem(AppDestination.WALLET, destination, Icons.Rounded.AccountBalanceWallet, "کیف پول") { destination = it }
                    NavigationItem(AppDestination.SUPPORT, destination, Icons.Rounded.SupportAgent, "پشتیبانی") {
                        destination = it
                        actions.markNotificationsRead()
                    }
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (destination) {
                    AppDestination.HOME -> HomeScreen(
                        state,
                        actions,
                        onPlans = { destination = AppDestination.PLANS },
                        onWallet = { destination = AppDestination.WALLET },
                        onNotifications = { destination = AppDestination.SUPPORT; actions.markNotificationsRead() },
                        onRenew = { renewSubscription = it }
                    )
                    AppDestination.PLANS -> PlansScreen(state.plans, state.account?.balanceToman ?: 0) { purchasePlan = it }
                    AppDestination.WALLET -> WalletScreen(state, onTopup = { topupOpen = true })
                    AppDestination.SUPPORT -> SupportScreen(state, onNewTicket = { ticketOpen = true }, onOpenTicket = actions::openTicket, onLogout = actions::logout, onNetworkLab = actions::openNetworkLab)
                }
                if (state.actionBusy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
                if (state.ticketLoading) Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim.copy(.12f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }

    purchasePlan?.let { plan ->
        PurchaseDialog(
            plan = plan,
            balance = state.account?.balanceToman ?: 0,
            discount = state.discount,
            busy = state.actionBusy,
            onValidate = actions::validateDiscount,
            onDismiss = { purchasePlan = null; actions.clearDiscount() },
            onBuy = { code -> actions.purchase(plan, code); purchasePlan = null }
        )
    }
    renewSubscription?.let { subscription ->
        ConfirmDialog(
            icon = Icons.Rounded.Autorenew,
            title = "تمدید ${subscription.planName}",
            body = "حجم و زمان پلن به همین اشتراک افزوده می‌شود و هزینه از کیف پول کسر خواهد شد.",
            confirm = "تأیید و تمدید",
            busy = state.actionBusy,
            onDismiss = { renewSubscription = null },
            onConfirm = { actions.renew(subscription); renewSubscription = null }
        )
    }
    if (topupOpen) TopupDialog(
        cards = state.paymentCards,
        busy = state.actionBusy,
        onLoadCards = actions::loadPaymentCards,
        onCopy = actions::copyText,
        onDismiss = { topupOpen = false },
        onSubmit = { amount, reference,receipt -> actions.submitTopup(amount, reference,receipt); topupOpen = false }
    )
    if (ticketOpen) TicketDialog(
        busy = state.actionBusy,
        onDismiss = { ticketOpen = false },
        onSubmit = { subject, body -> actions.createTicket(subject, body); ticketOpen = false }
    )
    state.ticketConversation?.let {
        TicketConversationDialog(
            conversation = it,
            busy = state.actionBusy,
            onDismiss = actions::closeTicketConversation,
            onReply = actions::replyTicket
        )
    }
    if (state.showVpnDisclosure) VpnDisclosureDialog(actions::dismissVpnDisclosure, actions::acceptVpnDisclosure)
}

@Composable
private fun RowScope.NavigationItem(destination: AppDestination, selected: AppDestination, icon: ImageVector, label: String, onClick: (AppDestination) -> Unit) {
    NavigationBarItem(
        selected = selected == destination,
        onClick = { onClick(destination) },
        icon = { Icon(icon, label) },
        label = { Text(label) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = MaterialTheme.colorScheme.primary,
            selectedTextColor = MaterialTheme.colorScheme.primary,
            indicatorColor = MaterialTheme.colorScheme.primary.copy(.14f),
            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant
        )
    )
}

@Composable
private fun ResellerDashboard(state: NivoraUiState, actions: NivoraActions, snackbar: SnackbarHostState) {
    val account = state.reseller ?: return
    var destination by rememberSaveable { mutableStateOf(ResellerDestination.OVERVIEW) }
    var addCustomerOpen by rememberSaveable { mutableStateOf(false) }
    var detailCustomer by remember { mutableStateOf<ResellerCustomer?>(null) }
    var preferredCustomer by remember { mutableStateOf<ResellerCustomer?>(null) }
    var purchasePlan by remember { mutableStateOf<Plan?>(null) }
    var renewOrder by remember { mutableStateOf<ResellerOrder?>(null) }
    var ticketOpen by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar, modifier = Modifier.navigationBarsPadding()) },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 10.dp) {
                ResellerNavigationItem(ResellerDestination.OVERVIEW, destination, Icons.Rounded.Dashboard, "داشبورد") { destination = it }
                ResellerNavigationItem(ResellerDestination.CUSTOMERS, destination, Icons.Rounded.Groups, "مشتریان") { destination = it }
                ResellerNavigationItem(ResellerDestination.PLANS, destination, Icons.Rounded.AddShoppingCart, "فروش") { destination = it }
                ResellerNavigationItem(ResellerDestination.WALLET, destination, Icons.Rounded.AccountBalanceWallet, "کیف پول") { destination = it }
                ResellerNavigationItem(ResellerDestination.SUPPORT, destination, Icons.Rounded.SupportAgent, "پشتیبانی") { destination = it; actions.markNotificationsRead() }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (destination) {
                ResellerDestination.OVERVIEW -> ResellerOverviewScreen(account, state.refreshing, actions::refresh, actions::logout, onCustomers = { destination = ResellerDestination.CUSTOMERS }, onSale = { destination = ResellerDestination.PLANS }, onCustomer = { detailCustomer = it })
                ResellerDestination.CUSTOMERS -> ResellerCustomersScreen(account.customers, onAdd = { addCustomerOpen = true }, onOpen = { detailCustomer = it }, onSale = { preferredCustomer = it; destination = ResellerDestination.PLANS })
                ResellerDestination.PLANS -> ResellerPlansScreen(state.resellerPlans, account.balanceToman, preferredCustomer) { purchasePlan = it }
                ResellerDestination.WALLET -> ResellerWalletScreen(account)
                ResellerDestination.SUPPORT -> ResellerSupportScreen(account,state.tickets,{ticketOpen=true},actions::openTicket,actions::logout)
            }
            if (state.actionBusy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }

    if (addCustomerOpen) ResellerCustomerDialog(state.actionBusy, onDismiss = { addCustomerOpen = false }) { name, phone,password,note ->
        actions.createResellerCustomer(name, phone,password,note); addCustomerOpen = false
    }
    purchasePlan?.let { plan ->
        ResellerPurchaseDialog(plan, account.customers, preferredCustomer, account.balanceToman, state.actionBusy, onDismiss = { purchasePlan = null; preferredCustomer = null }) { customer, salePrice ->
            actions.resellerPurchase(plan, customer, salePrice); purchasePlan = null; preferredCustomer = null
        }
    }
    detailCustomer?.let { customer ->
        ResellerCustomerDetailDialog(customer, account.orders.filter { it.customerId == customer.id }, state.actionBusy, onDismiss = { detailCustomer = null }, onSale = { detailCustomer = null; preferredCustomer = customer; destination = ResellerDestination.PLANS }, onRenew = { detailCustomer = null; renewOrder = it },onReset={actions.resetResellerCustomerPassword(customer,it)},onControl=actions::controlResellerSubscription)
    }
    renewOrder?.let { order ->
        val cost = state.resellerPlans.firstOrNull { it.id == order.planId }?.priceToman ?: 0
        ResellerRenewDialog(order, cost, state.actionBusy, onDismiss = { renewOrder = null }) { price -> actions.resellerRenew(order, price); renewOrder = null }
    }
    if(ticketOpen) TicketDialog(state.actionBusy,{ticketOpen=false}){subject,body->actions.createTicket(subject,body);ticketOpen=false}
    state.ticketConversation?.let{TicketConversationDialog(it,state.actionBusy,actions::closeTicketConversation,actions::replyTicket)}
}

@Composable
private fun ResellerSupportScreen(account:ResellerAccount,tickets:List<SupportTicket>,onNew:()->Unit,onOpen:(SupportTicket)->Unit,onLogout:()->Unit){LazyColumn(Modifier.fillMaxSize(),contentPadding=PaddingValues(20.dp),verticalArrangement=Arrangement.spacedBy(13.dp)){item{Text("پشتیبانی همکاران",style=MaterialTheme.typography.headlineLarge);Text("اعلان‌های فروش و گفت‌وگو مستقیم با مدیریت",color=MaterialTheme.colorScheme.onSurfaceVariant)};item{SectionHeader("اعلان‌ها",if(account.notifications.isEmpty())"اعلان تازه‌ای ندارید" else "پیام‌های مهم حساب همکاری")};if(account.notifications.isEmpty())item{EmptyState(Icons.Rounded.NotificationsNone,"اعلانی نیست","رویدادهای کیف پول، فروش و پاسخ مدیریت اینجا دیده می‌شوند.")}else items(account.notifications,key={it.id}){NotificationRow(it)};item{SectionHeader("تیکت‌ها","پیگیری درخواست‌های همکاری","تیکت جدید",onNew)};if(tickets.isEmpty())item{EmptyState(Icons.Rounded.Forum,"گفت‌وگویی ندارید","برای مدیریت پیام بفرستید.","پیام جدید",onNew)}else items(tickets,key={it.id}){TicketRow(it){onOpen(it)}};item{OutlinedButton(onClick=onLogout,modifier=Modifier.fillMaxWidth()){Icon(Icons.AutoMirrored.Rounded.Logout,null);Text(" خروج از حساب")}}}}

@Composable
private fun RowScope.ResellerNavigationItem(destination: ResellerDestination, selected: ResellerDestination, icon: ImageVector, label: String, onClick: (ResellerDestination) -> Unit) {
    NavigationBarItem(selected = selected == destination, onClick = { onClick(destination) }, icon = { Icon(icon, label) }, label = { Text(label) }, colors = NavigationBarItemDefaults.colors(indicatorColor = MaterialTheme.colorScheme.primaryContainer))
}

@Composable
private fun ResellerOverviewScreen(account: ResellerAccount, refreshing: Boolean, onRefresh: () -> Unit, onLogout: () -> Unit, onCustomers: () -> Unit, onSale: () -> Unit, onCustomer: (ResellerCustomer) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { PartnerTopBar(account.name, refreshing, onRefresh, onLogout) }
        item {
            Card(shape = RoundedCornerShape(28.dp), colors = CardDefaults.cardColors(containerColor = NivoraInk), modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(NivoraInk, Color(0xFF102A5A)))).padding(22.dp)) {
                    Text("موجودی قابل فروش", color = Color(0xFFB9CBE8), style = MaterialTheme.typography.bodyMedium)
                    Text(toman(account.balanceToman), color = NivoraGreen, fontSize = 29.sp, fontWeight = FontWeight.Black)
                    Spacer(Modifier.height(15.dp))
                    Button(onClick = onSale, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = NivoraGreen, contentColor = NivoraInk)) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(6.dp)); Text("فروش اشتراک جدید") }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PartnerStatCard("مشتریان", account.customersCount, "پرونده", Icons.Rounded.Groups, Modifier.weight(1f), onCustomers)
                PartnerStatCard("اشتراک فعال", account.activeSubscriptions, "سرویس", Icons.Rounded.Verified, Modifier.weight(1f), onCustomers)
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PartnerMoneyCard("فروش ثبت‌شده", account.totalRevenueToman, Icons.Rounded.Payments, Modifier.weight(1f))
                PartnerMoneyCard("سود ثبت‌شده", account.totalProfitToman, Icons.AutoMirrored.Rounded.TrendingUp, Modifier.weight(1f))
            }
        }
        item { SectionHeader("آخرین مشتری‌ها", "دسترسی سریع به پرونده و اشتراک‌ها", "همه مشتریان", onCustomers) }
        if (account.customers.isEmpty()) item { Card(border = CardDefaults.outlinedCardBorder()) { EmptyState(Icons.Rounded.GroupAdd, "دفترچه خالی است", "اولین مشتری را ثبت کنید و اشتراک او را بسازید.", "افزودن مشتری", onCustomers) } }
        else items(account.customers.take(5), key = { it.id }) { customer -> ResellerCustomerCard(customer, { onCustomer(customer) }, onSale) }
    }
}

@Composable
private fun PartnerTopBar(name: String, refreshing: Boolean, onRefresh: () -> Unit, onLogout: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text("سلام، ${name.substringBefore(' ')}", style = MaterialTheme.typography.headlineMedium); Text("مرکز همکاری و مدیریت فروش", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        IconButton(onClick = onRefresh, enabled = !refreshing) { if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Icon(Icons.Rounded.Refresh, "تازه‌سازی") }
        IconButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Rounded.Logout, "خروج") }
    }
}

@Composable
private fun PartnerStatCard(label: String, value: Int, suffix: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    Card(modifier.clickable(onClick = onClick), border = CardDefaults.outlinedCardBorder(), shape = RoundedCornerShape(20.dp)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) { Icon(icon, null, tint = MaterialTheme.colorScheme.primary); Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium); Text("${faNumber(value)} $suffix", style = MaterialTheme.typography.titleMedium) } }
}

@Composable
private fun PartnerMoneyCard(label: String, value: Int, icon: ImageVector, modifier: Modifier) {
    Card(modifier, border = CardDefaults.outlinedCardBorder(), shape = RoundedCornerShape(20.dp)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) { Icon(icon, null, tint = MaterialTheme.colorScheme.primary); Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium); Text(toman(value), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1) } }
}

@Composable
private fun ResellerCustomersScreen(customers: List<ResellerCustomer>, onAdd: () -> Unit, onOpen: (ResellerCustomer) -> Unit, onSale: (ResellerCustomer) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = customers.filter { query.isBlank() || it.name.contains(query, true) || it.phone.contains(query) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("دفترچه مشتریان", style = MaterialTheme.typography.headlineLarge); Text("پرونده، فروش و تمدید هر مشتری", color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(12.dp)); Button(onClick = onAdd, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.PersonAdd, null); Spacer(Modifier.width(6.dp)); Text("مشتری جدید") }; Spacer(Modifier.height(10.dp)); NivoraField(query, { query = it }, "جست‌وجوی نام یا موبایل", Icons.Rounded.Search) }
        if (filtered.isEmpty()) item { EmptyState(Icons.Rounded.Groups, "مشتری پیدا نشد", "مشتری تازه ثبت کنید یا جست‌وجو را تغییر دهید.", "افزودن مشتری", onAdd) }
        else items(filtered, key = { it.id }) { customer -> ResellerCustomerCard(customer, { onOpen(customer) }, { onSale(customer) }) }
    }
}

@Composable
private fun ResellerCustomerCard(customer: ResellerCustomer, onOpen: () -> Unit, onSale: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onOpen), shape = RoundedCornerShape(22.dp), border = CardDefaults.outlinedCardBorder()) {
        Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Box(Modifier.size(45.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) { Text(customer.name.take(1), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black) }; Spacer(Modifier.width(11.dp)); Column(Modifier.weight(1f)) { Text(customer.name, style = MaterialTheme.typography.titleMedium); Text(customer.phone, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }; StatusPill("${faNumber(customer.activeSubscriptions)} فعال", NivoraGreenDark) }
            if (customer.note.isNotBlank()) Text(customer.note, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedButton(onClick = onOpen, modifier = Modifier.weight(1f)) { Text("پرونده") }; Button(onClick = onSale, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.Add, null, Modifier.size(18.dp)); Text(" فروش") } }
        }
    }
}

@Composable
private fun ResellerPlansScreen(plans: List<Plan>, balance: Int, preferredCustomer: ResellerCustomer?, onBuy: (Plan) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
        item { Text("فروش اشتراک", style = MaterialTheme.typography.headlineLarge); Text(preferredCustomer?.let { "مشتری انتخاب‌شده: ${it.name}" } ?: "پلن را انتخاب و مشتری را مشخص کنید.", color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(10.dp)); Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp)).padding(14.dp), verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Rounded.AccountBalanceWallet, null, tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.width(8.dp)); Text("موجودی همکاری", Modifier.weight(1f)); Text(toman(balance), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary) } }
        if (plans.isEmpty()) item { EmptyState(Icons.Rounded.Inventory2, "پلنی فعال نیست", "پس از فعال‌شدن پلن توسط مدیریت اینجا نمایش داده می‌شود.") }
        else items(plans, key = { it.id }) { plan -> Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(23.dp), border = CardDefaults.outlinedCardBorder()) { Column(Modifier.padding(19.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) { Row { Column(Modifier.weight(1f)) { Text(plan.name, style = MaterialTheme.typography.titleLarge); Text(plan.description, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2) }; Column(horizontalAlignment = Alignment.End) { Text(toman(plan.priceToman), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black); Text("هزینه شما", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }; Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { InfoTile("حجم", "${faNumber(plan.trafficGb)} گیگ"); InfoTile("اعتبار", "${faNumber(plan.durationDays)} روز"); InfoTile("دستگاه", faNumber(plan.deviceLimit)) }; Button(onClick = { onBuy(plan) }, enabled = balance >= plan.priceToman, modifier = Modifier.fillMaxWidth()) { Text(if (balance >= plan.priceToman) "انتخاب مشتری و ساخت" else "موجودی ناکافی") } } } }
    }
}

@Composable
private fun ResellerWalletScreen(account: ResellerAccount) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("کیف پول همکاری", style = MaterialTheme.typography.headlineLarge); Text("ریز برداشت‌ها و بازگشت وجه", color = MaterialTheme.colorScheme.onSurfaceVariant); Spacer(Modifier.height(13.dp)); Card(colors = CardDefaults.cardColors(containerColor = NivoraInk), shape = RoundedCornerShape(25.dp)) { Column(Modifier.fillMaxWidth().padding(22.dp)) { Text("موجودی قابل فروش", color = Color(0xFFB9CBE8)); Text(toman(account.balanceToman), color = NivoraGreen, fontSize = 28.sp, fontWeight = FontWeight.Black) } } }
        if (account.transactions.isEmpty()) item { EmptyState(Icons.AutoMirrored.Rounded.ReceiptLong, "تراکنشی نیست", "شارژها و خریدهای شما اینجا ثبت می‌شوند.") }
        else items(account.transactions, key = { it.id }) { TransactionRow(it) }
    }
}

@Composable
private fun ResellerCustomerDialog(busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String,String, String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }; var phone by rememberSaveable { mutableStateOf("") };var password by rememberSaveable{mutableStateOf("")}; var note by rememberSaveable { mutableStateOf("") }; var error by rememberSaveable { mutableStateOf<String?>(null) }
    AppDialog(onDismiss) { DialogTitle(Icons.Rounded.PersonAdd,"مشتری جدید","حساب ورود مشتری را همراه پرونده فروش بسازید.");NivoraField(name,{name=it.take(80)},"نام و نام خانوادگی",Icons.Rounded.PersonOutline);NivoraField(phone,{phone=it.filter(Char::isDigit).take(11)},"شماره موبایل",Icons.Rounded.PhoneAndroid,KeyboardType.Phone);NivoraField(password,{password=it},"رمز ورود مشتری",Icons.Rounded.Lock,KeyboardType.Password);OutlinedTextField(note,{note=it.take(500)},Modifier.fillMaxWidth(),label={Text("یادداشت داخلی (اختیاری)")},minLines=2,shape=RoundedCornerShape(16.dp));error?.let{Text(it,color=NivoraDanger)};Button(onClick={error=when{name.trim().length<2->"نام مشتری را کامل وارد کنید";!phone.matches(Regex("09\\d{9}"))->"شماره موبایل معتبر نیست";password.length<8->"رمز باید حداقل ۸ کاراکتر باشد";else->null};if(error==null)onSubmit(name.trim(),phone,password,note.trim())},enabled=!busy,modifier=Modifier.fillMaxWidth()){Text("ساخت حساب مشتری")};TextButton(onClick=onDismiss,modifier=Modifier.fillMaxWidth()){Text("انصراف")} }
}

@Composable
private fun ResellerPurchaseDialog(plan: Plan, customers: List<ResellerCustomer>, preferred: ResellerCustomer?, balance: Int, busy: Boolean, onDismiss: () -> Unit, onSubmit: (ResellerCustomer, Int) -> Unit) {
    var selectedId by rememberSaveable(plan.id, preferred?.id) { mutableStateOf(preferred?.id ?: customers.firstOrNull()?.id.orEmpty()) }; var salePrice by rememberSaveable(plan.id) { mutableStateOf(plan.priceToman.toString()) }; val selected = customers.firstOrNull { it.id == selectedId }; val sale = salePrice.toIntOrNull() ?: 0; val profit = sale - plan.priceToman
    AppDialog(onDismiss) { DialogTitle(Icons.Rounded.AddShoppingCart, "فروش ${plan.name}", "هزینه همکاری ${toman(plan.priceToman)} از کیف پول کسر می‌شود."); Text("انتخاب مشتری", style = MaterialTheme.typography.titleMedium); customers.forEach { customer -> Row(Modifier.fillMaxWidth().clickable { selectedId = customer.id }.background(if (selectedId == customer.id) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)).padding(11.dp), verticalAlignment = Alignment.CenterVertically) { RadioButton(selectedId == customer.id, { selectedId = customer.id }); Column { Text(customer.name, fontWeight = FontWeight.Bold); Text(customer.phone, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) } } }; OutlinedTextField(salePrice, { salePrice = it.filter(Char::isDigit).take(9) }, Modifier.fillMaxWidth(), label = { Text("مبلغ فروش به مشتری (تومان)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = RoundedCornerShape(16.dp)); PriceLine("سود این فروش", "${if (profit >= 0) "+" else ""}${toman(profit)}", if (profit >= 0) NivoraGreenDark else NivoraDanger, true); if (balance < plan.priceToman) Text("موجودی کیف پول کافی نیست.", color = NivoraDanger); Button(onClick = { selected?.let { onSubmit(it, sale) } }, enabled = !busy && selected != null && salePrice.isNotBlank() && balance >= plan.priceToman, modifier = Modifier.fillMaxWidth()) { Text("پرداخت و ساخت اشتراک") }; TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") } }
}

@Composable
private fun ResellerCustomerDetailDialog(customer: ResellerCustomer, orders: List<ResellerOrder>, busy:Boolean,onDismiss: () -> Unit, onSale: () -> Unit, onRenew: (ResellerOrder) -> Unit,onReset:(String)->Unit,onControl:(ResellerOrder,String,String)->Unit) {
    var password by rememberSaveable(customer.id){mutableStateOf("")}
    if(customer.managedAccount) Card(border=CardDefaults.outlinedCardBorder()){Column(Modifier.padding(14.dp)){NivoraField(password,{password=it},"رمز جدید مشتری",Icons.Rounded.Lock,KeyboardType.Password);Button(onClick={onReset(password);password=""},enabled=!busy&&password.length>=8,modifier=Modifier.fillMaxWidth()){Text("تغییر رمز مشتری")}}}
    AppDialog(onDismiss) { DialogTitle(Icons.Rounded.AccountCircle, customer.name, customer.phone); Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { InfoTile("فعال", faNumber(customer.activeSubscriptions)); InfoTile("فروش", toman(customer.revenueToman)); InfoTile("سود", toman(customer.profitToman)) }; Button(onClick = onSale, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(6.dp)); Text("اشتراک جدید برای مشتری") }; Text("اشتراک‌ها و تمدیدها", style = MaterialTheme.typography.titleMedium); if (orders.isEmpty()) Text("هنوز اشتراکی ثبت نشده است.", color = MaterialTheme.colorScheme.onSurfaceVariant) else orders.forEach { order -> Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Row { Column(Modifier.weight(1f)) { Text(order.planName, fontWeight = FontWeight.Bold); Text(if (order.orderKind == "renewal") "تمدید · ${shortDate(order.createdAt)}" else "فروش اولیه · ${shortDate(order.createdAt)}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }; StatusPill(if (order.status == "active") "فعال" else order.status, if (order.status == "active") NivoraGreenDark else NivoraWarning) }; if (order.orderKind == "purchase" && order.status == "active") Button(onClick = { onRenew(order) }, modifier = Modifier.fillMaxWidth()) { Text("تمدید") } } } }; TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("بستن") } }
}

@Composable
private fun ResellerRenewDialog(order: ResellerOrder, cost: Int, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int) -> Unit) {
    var salePrice by rememberSaveable(order.id) { mutableStateOf((order.salePriceToman.takeIf { it > 0 } ?: cost).toString()) }; val sale = salePrice.toIntOrNull() ?: 0; val profit = sale - cost
    AppDialog(onDismiss) { DialogTitle(Icons.Rounded.Autorenew, "تمدید ${order.planName}", "${order.customerName} · هزینه شما ${toman(cost)}"); OutlinedTextField(salePrice, { salePrice = it.filter(Char::isDigit).take(9) }, Modifier.fillMaxWidth(), label = { Text("مبلغ تمدید برای مشتری") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = RoundedCornerShape(16.dp)); PriceLine("سود این تمدید", "${if (profit >= 0) "+" else ""}${toman(profit)}", if (profit >= 0) NivoraGreenDark else NivoraDanger, true); Button(onClick = { onSubmit(sale) }, enabled = !busy && salePrice.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("تأیید و تمدید") }; TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") } }
}

@Composable
private fun HomeScreen(
    state: NivoraUiState,
    actions: NivoraActions,
    onPlans: () -> Unit,
    onWallet: () -> Unit,
    onNotifications: () -> Unit,
    onRenew: (Subscription) -> Unit
) {
    val account = state.account ?: return
    var subscriptionsOpen by rememberSaveable { mutableStateOf(false) }
    val selectedSubscription = state.selectedSubscription ?: state.activeSubscriptions.firstOrNull()
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)
    ) {
        item {
            AppTopBar(
                account.name,
                account.notifications.count { it.readAt == null },
                state.refreshing,
                actions::refresh,
                onNotifications
            )
        }
        item {
            Column(Modifier.padding(horizontal = 20.dp)) {
                ConnectionHero(state.vpnState, state.vpnError, state.selectedSubscription, state.pingMs, state.pingBusy, actions::toggleVpn, actions::measurePing)
            }
        }
        item {
            Row(Modifier.padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                QuickCard(Icons.Rounded.AccountBalanceWallet, "کیف پول", toman(account.balanceToman), onWallet)
                QuickCard(Icons.Rounded.Bolt, "وضعیت سرویس", if (state.activeSubscriptions.isEmpty()) "بدون اشتراک" else "فعال", onPlans)
            }
        }
        item {
            Column(Modifier.padding(horizontal = 20.dp)) {
                SectionHeader(
                    "اشتراک‌های من",
                    if (state.activeSubscriptions.isEmpty()) "برای شروع یک پلن انتخاب کنید" else "${faNumber(state.activeSubscriptions.size)} اشتراک در حساب شما",
                    if (state.activeSubscriptions.isEmpty()) "خرید پلن" else if (subscriptionsOpen) "بستن فهرست" else "مدیریت همه",
                    if (state.activeSubscriptions.isEmpty()) onPlans else { { subscriptionsOpen = !subscriptionsOpen } }
                )
            }
        }
        if (state.activeSubscriptions.isEmpty()) {
            item {
                Card(Modifier.padding(horizontal = 20.dp).fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) {
                    EmptyState(Icons.Rounded.VpnKeyOff, "اشتراک فعالی ندارید", "از بخش پلن‌ها اشتراک مناسب را انتخاب کنید؛ ساخت آن فوری انجام می‌شود.", "مشاهده پلن‌ها", onPlans)
                }
            }
        } else {
            selectedSubscription?.let { subscription ->
                item(key = "selected-${subscription.id}") {
                    Box(Modifier.padding(horizontal = 20.dp)) {
                        SubscriptionCard(subscription, true, { actions.selectSubscription(subscription) }, { onRenew(subscription) })
                    }
                }
            }
            if (subscriptionsOpen) items(state.activeSubscriptions.filter { it.id != selectedSubscription?.id }, key = { it.id }) { subscription ->
                Box(Modifier.padding(horizontal = 20.dp)) {
                    SubscriptionCard(
                        subscription,
                        false,
                        { actions.selectSubscription(subscription) },
                        { onRenew(subscription) }
                    )
                }
            }
        }
    }
}

@Composable
private fun RowScope.QuickCard(icon: ImageVector, label: String, value: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier = Modifier
            .weight(1f)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface.copy(.72f))
            .border(1.dp, MaterialTheme.colorScheme.outline.copy(.28f), shape)
            .clickable(onClick = onClick)
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
            Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
            Text(value, style = MaterialTheme.typography.titleMedium, maxLines = 1)
        }
    }
}

@Composable
private fun PlansScreen(plans: List<Plan>, balance: Int, onBuy: (Plan) -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Column(Modifier.padding(vertical = 4.dp)) {
                Text("انتخاب پلن", style = MaterialTheme.typography.headlineLarge)
                Text("اشتراک بلافاصله پس از خرید ساخته می‌شود.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(12.dp))
                Row(
                    Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp)).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Rounded.AccountBalanceWallet, null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(8.dp))
                    Text("موجودی شما", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text(toman(balance), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        if (plans.isEmpty()) item { EmptyState(Icons.Rounded.Inventory2, "پلنی موجود نیست", "پس از فعال‌شدن پلن‌ها توسط مدیریت، اینجا نمایش داده می‌شوند.") }
        items(plans, key = { it.id }) { plan -> PlanCard(plan, plans.indexOf(plan), onBuy = { onBuy(plan) }) }
    }
}

@Composable
private fun WalletScreen(state: NivoraUiState, onTopup: () -> Unit) {
    val account = state.account ?: return
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(15.dp)
    ) {
        item {
            Text("کیف پول", style = MaterialTheme.typography.headlineLarge)
            Text("موجودی، واریزها و خریدهای شما", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item { WalletBalanceCard(account.balanceToman, onTopup) }
        item { SectionHeader("درخواست‌های شارژ", "وضعیت بررسی واریزهای کارت‌به‌کارت") }
        if (account.topups.isEmpty()) item {
            Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) { EmptyState(Icons.AutoMirrored.Rounded.ReceiptLong, "درخواستی ثبت نشده", "پس از کارت‌به‌کارت، شماره پیگیری را اینجا ثبت کنید.") }
        } else items(account.topups.take(5), key = { it.id }) { TopupRow(it) }
        item { SectionHeader("گردش حساب", "آخرین تراکنش‌های کیف پول") }
        if (account.transactions.isEmpty()) item {
            Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) { EmptyState(Icons.Rounded.History, "گردشی وجود ندارد", "خریدها و شارژهای کیف پول اینجا ثبت می‌شوند.") }
        } else items(account.transactions, key = { it.id }) { TransactionRow(it) }
    }
}

@Composable
private fun TopupRow(topup: WalletTopup) {
    Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Receipt, null, tint = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(toman(topup.amountToman), style = MaterialTheme.typography.titleMedium)
                Text(shortDate(topup.createdAt), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                topup.reviewNote?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
            }
            val (label, color) = when (topup.status) {
                "approved" -> "تأیید شد" to NivoraGreenDark
                "rejected" -> "رد شد" to NivoraDanger
                else -> "در بررسی" to NivoraWarning
            }
            StatusPill(label, color)
        }
    }
}

@Composable
private fun TransactionRow(transaction: WalletTransaction) {
    val positive = transaction.amountToman > 0
    val label = when (transaction.type) {
        "purchase" -> "خرید اشتراک"
        "refund" -> "بازپرداخت"
        "transfer_in" -> "شارژ کیف پول"
        "manual_credit" -> "افزایش موجودی"
        "manual_debit" -> "کاهش موجودی"
        else -> transaction.note ?: "تراکنش کیف پول"
    }
    Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background((if (positive) NivoraGreenDark else NivoraDanger).copy(.10f), RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(if (positive) Icons.Rounded.SouthWest else Icons.Rounded.NorthEast, null, tint = if (positive) NivoraGreenDark else NivoraDanger)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleMedium)
                Text(shortDate(transaction.createdAt), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
            }
            Text(
                "${if (positive) "+" else "−"}${toman(kotlin.math.abs(transaction.amountToman))}",
                color = if (positive) NivoraGreenDark else NivoraDanger,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

@Composable
private fun SupportScreen(state: NivoraUiState, onNewTicket: () -> Unit, onOpenTicket: (SupportTicket) -> Unit, onLogout: () -> Unit, onNetworkLab: () -> Unit) {
    val account = state.account ?: return
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Text("پشتیبانی و حساب", style = MaterialTheme.typography.headlineLarge)
            Text("اعلان‌ها و گفتگو با تیم Nivora", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item {
            Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = NivoraInk), shape = RoundedCornerShape(24.dp)) {
                Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(52.dp).background(NivoraGreen, CircleShape), contentAlignment = Alignment.Center) {
                        Text(account.name.take(1), color = NivoraInk, fontSize = 22.sp, fontWeight = FontWeight.Black)
                    }
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f)) {
                        Text(account.name, color = Color.White, style = MaterialTheme.typography.titleLarge)
                        Text(account.phone, color = Color(0xFFAAC0B8), style = MaterialTheme.typography.bodyMedium)
                    }
                    Icon(Icons.Rounded.Verified, null, tint = NivoraGreen)
                }
            }
        }
        item { SectionHeader("اعلان‌ها", if (account.notifications.isEmpty()) "اعلان تازه‌ای ندارید" else "آخرین پیام‌های حساب") }
        if (account.notifications.isEmpty()) item {
            Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) { EmptyState(Icons.Rounded.NotificationsNone, "همه‌چیز آرام است", "اعلان خرید، تمدید و پاسخ پشتیبانی اینجا نمایش داده می‌شود.") }
        } else items(account.notifications.take(8), key = { it.id }) { NotificationRow(it) }
        item { SectionHeader("تیکت‌های پشتیبانی", "پاسخ‌ها را از همین بخش دنبال کنید", "تیکت جدید", onNewTicket) }
        if (state.tickets.isEmpty()) item {
            Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) { EmptyState(Icons.Rounded.Forum, "گفتگویی ندارید", "اگر پرسشی دارید برای تیم پشتیبانی پیام بفرستید.", "ارسال پیام", onNewTicket) }
        } else items(state.tickets, key = { it.id }) { TicketRow(it) { onOpenTicket(it) } }
        item {
            Card(Modifier.fillMaxWidth(), border = CardDefaults.outlinedCardBorder()) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.Info, null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(8.dp))
                        Text("Nivora ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleMedium)
                    }
                    Text("اتصال امن و خودکار · اطلاعات ورود روی دستگاه رمزگذاری می‌شود", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    if (BuildConfig.NETWORK_LAB_ENABLED) FilledTonalButton(onClick = onNetworkLab, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Rounded.Science, null); Spacer(Modifier.width(7.dp)); Text("آزمایشگاه هوشمند شبکه")
                    }
                    OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.AutoMirrored.Rounded.Logout, null); Spacer(Modifier.width(7.dp)); Text("خروج امن از حساب")
                    }
                }
            }
        }
    }
}

@Composable
private fun NotificationRow(item: CustomerNotification) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = if (item.readAt == null) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface),
        border = CardDefaults.outlinedCardBorder()
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(40.dp).background(if (item.readAt == null) NivoraGreen.copy(.18f) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Notifications, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(21.dp))
            }
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(item.title, style = MaterialTheme.typography.titleMedium)
                Text(item.body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                Text(shortDate(item.createdAt), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun TicketRow(ticket: SupportTicket, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), border = CardDefaults.outlinedCardBorder()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.ChatBubbleOutline, null, tint = MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(ticket.subject, style = MaterialTheme.typography.titleMedium)
                ticket.lastMessage?.let { Text(it, maxLines = 1, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium) }
                Text(shortDate(ticket.updatedAt), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
            }
            val (label, color) = when (ticket.status) {
                "answered" -> "پاسخ داده شد" to NivoraGreenDark
                "closed" -> "بسته" to NivoraMuted
                else -> "باز" to NivoraWarning
            }
            StatusPill(label, color)
            Spacer(Modifier.width(5.dp))
            Icon(Icons.Rounded.ChevronLeft, "باز کردن", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(19.dp))
        }
    }
}

@Composable
private fun PurchaseDialog(
    plan: Plan,
    balance: Int,
    discount: DiscountResult?,
    busy: Boolean,
    onValidate: (String) -> Unit,
    onDismiss: () -> Unit,
    onBuy: (String) -> Unit
) {
    var code by rememberSaveable { mutableStateOf("") }
    val appliedDiscount = discount?.takeIf { it.code.equals(code.trim(), ignoreCase = true) }
    val discountAmount = appliedDiscount?.let { plan.priceToman * it.percent / 100 } ?: 0
    val payable = plan.priceToman - discountAmount
    AppDialog(onDismiss) {
        DialogTitle(Icons.Rounded.ShoppingBag, "خرید ${plan.name}", "اشتراک پس از پرداخت به‌صورت خودکار ساخته می‌شود.")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            InfoTile("حجم", "${faNumber(plan.trafficGb)} گیگ")
            InfoTile("اعتبار", "${faNumber(plan.durationDays)} روز")
            InfoTile("دستگاه", faNumber(plan.deviceLimit))
        }
        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase(); if (discount?.code != it.uppercase()) {} },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("کد تخفیف (اختیاری)") },
            leadingIcon = { Icon(Icons.Rounded.LocalOffer, null) },
            trailingIcon = { TextButton(onClick = { if (code.length >= 3) onValidate(code) }, enabled = !busy) { Text("بررسی") } },
            singleLine = true,
            shape = RoundedCornerShape(16.dp)
        )
        if (appliedDiscount != null) Text("کد ${appliedDiscount.code}: ${faNumber(appliedDiscount.percent)}٪ تخفیف", color = NivoraGreenDark, style = MaterialTheme.typography.bodyMedium)
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PriceLine("قیمت پلن", toman(plan.priceToman))
            if (discountAmount > 0) PriceLine("تخفیف", "− ${toman(discountAmount)}", NivoraGreenDark)
            HorizontalDivider()
            PriceLine("مبلغ نهایی", toman(payable), MaterialTheme.colorScheme.primary, true)
            PriceLine("موجودی پس از خرید", toman(balance - payable), if (balance >= payable) MaterialTheme.colorScheme.onSurfaceVariant else NivoraDanger)
        }
        if (balance < payable) Text("موجودی کیف پول برای این خرید کافی نیست.", color = NivoraDanger, style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { onBuy(code) }, enabled = !busy && balance >= payable, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            if (busy) CircularProgressIndicator(Modifier.size(21.dp), color = MaterialTheme.colorScheme.onPrimary, strokeWidth = 2.dp)
            else Text("پرداخت و ساخت فوری")
        }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun RowScope.InfoTile(label: String, value: String) {
    Column(Modifier.weight(1f).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(13.dp)).padding(vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
        Text(value, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun PriceLine(label: String, value: String, color: Color = MaterialTheme.colorScheme.onSurface, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Text(value, color = color, fontWeight = if (bold) FontWeight.Black else FontWeight.SemiBold)
    }
}

@Composable
private fun TopupDialog(
    cards: List<PaymentCard>,
    busy: Boolean,
    onLoadCards: () -> Unit,
    onCopy: (String, String) -> Unit,
    onDismiss: () -> Unit,
    onSubmit: (Int, String,String) -> Unit
) {
    var amount by rememberSaveable { mutableStateOf("") }
    var reference by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var receiptUri by rememberSaveable { mutableStateOf("") }
    val receiptPicker=rememberLauncherForActivityResult(ActivityResultContracts.GetContent()){it?.let{receiptUri=it.toString()}}
    LaunchedEffect(Unit) { onLoadCards() }
    AppDialog(onDismiss) {
        DialogTitle(Icons.Rounded.AccountBalanceWallet, "شارژ کیف پول", "مبلغ را کارت‌به‌کارت کنید و شماره پیگیری را ثبت کنید.")
        if (cards.isEmpty()) {
            Box(Modifier.fillMaxWidth().height(130.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else cards.forEach { card -> BankCard(card, onCopy) }
        OutlinedTextField(
            value = amount,
            onValueChange = { amount = it.filter(Char::isDigit).take(9) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("مبلغ به تومان") },
            leadingIcon = { Icon(Icons.Rounded.Payments, null) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
            supportingText = { amount.toIntOrNull()?.let { Text(toman(it)) } },
            shape = RoundedCornerShape(16.dp)
        )
        NivoraField(reference, { reference = it.take(40) }, "شماره پیگیری واریز", Icons.AutoMirrored.Rounded.ReceiptLong)
        OutlinedButton(onClick={receiptPicker.launch("image/*")},modifier=Modifier.fillMaxWidth()){Icon(Icons.Rounded.AddPhotoAlternate,null);Spacer(Modifier.width(7.dp));Text(if(receiptUri.isBlank())"انتخاب تصویر رسید" else "تصویر رسید انتخاب شد")}
        error?.let { Text(it, color = NivoraDanger, style = MaterialTheme.typography.bodyMedium) }
        Button(
            onClick = {
                val value = amount.toIntOrNull()
                error = when {
                    value == null || value < 1000 -> "مبلغ معتبر وارد کنید"
                    reference.trim().length < 3 -> "شماره پیگیری واریز را وارد کنید"
                    else -> null
                }
                if(error==null&&receiptUri.isBlank())error="تصویر رسید را انتخاب کنید"
                if (error == null) onSubmit(value!!, reference.trim(),receiptUri)
            },
            enabled = !busy && cards.isNotEmpty(),
            modifier = Modifier.fillMaxWidth()
        ) { Text("ارسال برای تأیید") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun BankCard(card: PaymentCard, onCopy: (String, String) -> Unit) {
    Card(shape = RoundedCornerShape(22.dp), colors = CardDefaults.cardColors(containerColor = NivoraInk), modifier = Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(NivoraInk, Color(0xFF123A78)))).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.CreditCard, null, tint = NivoraGreen)
                Spacer(Modifier.weight(1f))
                Text(card.bank ?: "کارت بانکی", color = Color(0xFFC0D7CF), style = MaterialTheme.typography.labelLarge)
            }
            CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides LayoutDirection.Ltr) {
                Text(
                    card.number.chunked(4).joinToString("   "),
                    color = Color.White,
                    fontSize = 19.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.2.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clickable { onCopy(card.number, "شماره کارت کپی شد") }
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(card.holder, color = Color.White, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { onCopy(card.number, "شماره کارت کپی شد") }, colors = ButtonDefaults.textButtonColors(contentColor = NivoraGreen)) {
                    Icon(Icons.Rounded.ContentCopy, null, Modifier.size(17.dp)); Spacer(Modifier.width(5.dp)); Text("کپی")
                }
            }
        }
    }
}

@Composable
private fun TicketDialog(busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String) -> Unit) {
    var subject by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    AppDialog(onDismiss) {
        DialogTitle(Icons.Rounded.SupportAgent, "تیکت جدید", "موضوع را کوتاه و مشکل را با جزئیات بنویسید.")
        NivoraField(subject, { subject = it.take(80) }, "موضوع", Icons.AutoMirrored.Rounded.Subject)
        OutlinedTextField(
            value = body,
            onValueChange = { body = it.take(1000) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 130.dp),
            label = { Text("متن پیام") },
            leadingIcon = { Icon(Icons.AutoMirrored.Rounded.Chat, null) },
            shape = RoundedCornerShape(16.dp)
        )
        error?.let { Text(it, color = NivoraDanger) }
        Button(
            onClick = {
                error = when { subject.trim().length < 3 -> "موضوع را کامل‌تر بنویسید"; body.trim().length < 3 -> "متن پیام را وارد کنید"; else -> null }
                if (error == null) onSubmit(subject.trim(), body.trim())
            },
            enabled = !busy,
            modifier = Modifier.fillMaxWidth()
        ) { Icon(Icons.AutoMirrored.Rounded.Send, null); Spacer(Modifier.width(7.dp)); Text("ارسال تیکت") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun TicketConversationDialog(
    conversation: TicketConversation,
    busy: Boolean,
    onDismiss: () -> Unit,
    onReply: (String) -> Unit
) {
    var reply by rememberSaveable(conversation.id) { mutableStateOf("") }
    AppDialog(onDismiss) {
        DialogTitle(
            Icons.Rounded.Forum,
            conversation.subject,
            when (conversation.status) { "answered" -> "پشتیبانی پاسخ داده است"; "closed" -> "این گفتگو بسته شده است"; else -> "گفتگو در حال پیگیری است" }
        )
        Column(
            Modifier.fillMaxWidth().heightIn(max = 360.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp)
        ) {
            conversation.messages.forEach { message ->
                val customer = message.senderRole == "customer"
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = if (customer) Arrangement.Start else Arrangement.End
                ) {
                    Column(
                        Modifier.fillMaxWidth(.86f).background(
                            if (customer) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(18.dp, 18.dp, if (customer) 5.dp else 18.dp, if (customer) 18.dp else 5.dp)
                        ).padding(13.dp)
                    ) {
                        Text(if (customer) "شما" else "پشتیبانی Nivora", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        Text(message.body, style = MaterialTheme.typography.bodyMedium)
                        Text(shortDate(message.createdAt), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (conversation.status != "closed") {
            OutlinedTextField(
                value = reply,
                onValueChange = { reply = it.take(1000) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("پاسخ شما") },
                minLines = 2,
                shape = RoundedCornerShape(16.dp)
            )
            Button(
                onClick = { if (reply.trim().length >= 2) { onReply(reply.trim()); reply = "" } },
                enabled = !busy && reply.trim().length >= 2,
                modifier = Modifier.fillMaxWidth()
            ) { Icon(Icons.AutoMirrored.Rounded.Send, null); Spacer(Modifier.width(7.dp)); Text("ارسال پاسخ") }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("بستن") }
    }
}

@Composable
private fun ConfirmDialog(icon: ImageVector, title: String, body: String, confirm: String, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AppDialog(onDismiss) {
        DialogTitle(icon, title, body)
        Button(onClick = onConfirm, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text(confirm) }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun VpnDisclosureDialog(onDismiss: () -> Unit, onAccept: () -> Unit) {
    AppDialog(onDismiss) {
        DialogTitle(Icons.Rounded.VerifiedUser, "حریم خصوصی اتصال", "پیش از اولین اتصال، نحوه کار VPN را بررسی کنید.")
        Column(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(18.dp)).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            DisclosureLine(Icons.Rounded.Route, "ترافیک دستگاه از تونل رمزگذاری‌شده و سرور انتخابی عبور می‌کند.")
            DisclosureLine(Icons.Rounded.VisibilityOff, "Nivora محتوای ترافیک و تاریخچه مرور شما را مشاهده یا ذخیره نمی‌کند.")
            DisclosureLine(Icons.Rounded.DataUsage, "فقط وضعیت حساب، حجم مصرفی و اعتبار اشتراک از سرور دریافت می‌شود.")
        }
        Text("با ادامه، اجازه ساخت اتصال VPN در مرحله بعد از طرف اندروید درخواست می‌شود.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onAccept, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.CheckCircle, null); Spacer(Modifier.width(7.dp)); Text("متوجه شدم و ادامه") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("فعلاً نه") }
    }
}

@Composable
private fun DisclosureLine(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(9.dp))
        Text(text, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AppDialog(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier.fillMaxWidth().heightIn(max = 720.dp),
            shape = RoundedCornerShape(28.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
        ) {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content
            )
        }
    }
}

@Composable
private fun DialogTitle(icon: ImageVector, title: String, body: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
