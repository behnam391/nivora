package ir.nivora.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.ManageSearch
import androidx.compose.material.icons.automirrored.rounded.Notes
import androidx.compose.material.icons.automirrored.rounded.ReceiptLong
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.Subject
import androidx.compose.material.icons.automirrored.rounded.TrendingUp
import androidx.compose.material.icons.automirrored.rounded.Undo
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import ir.nivora.app.data.*

private enum class PartnerCustomerScope { MINE, DIRECTORY }
private enum class PartnerSalesScope { NEW, HISTORY }
private data class PartnerControlRequest(val order: ResellerOrder, val action: String)

@Composable
fun PartnerAppDashboard(state: NivoraUiState, actions: NivoraActions, snackbar: SnackbarHostState) {
    val account = state.reseller ?: return
    var destination by rememberSaveable { mutableStateOf(ResellerDestination.OVERVIEW) }
    var customerScope by rememberSaveable { mutableStateOf(PartnerCustomerScope.MINE) }
    var addCustomer by rememberSaveable { mutableStateOf(false) }
    var selectedCustomer by remember { mutableStateOf<ResellerCustomer?>(null) }
    var selectedTarget by remember { mutableStateOf<ResellerSaleTarget?>(null) }
    var pendingPlan by remember { mutableStateOf<Plan?>(null) }
    var targetPicker by rememberSaveable { mutableStateOf(false) }
    var walletTarget by remember { mutableStateOf<ResellerSaleTarget?>(null) }
    var debtTarget by remember { mutableStateOf<ResellerSaleTarget?>(null) }
    var reverseTransfer by remember { mutableStateOf<ResellerWalletTransfer?>(null) }
    var debtAction by remember { mutableStateOf<Pair<ResellerDebt, String>?>(null) }
    var resetCustomer by remember { mutableStateOf<ResellerCustomer?>(null) }
    var renewOrder by remember { mutableStateOf<ResellerOrder?>(null) }
    var controlRequest by remember { mutableStateOf<PartnerControlRequest?>(null) }
    var newTicket by rememberSaveable { mutableStateOf(false) }

    fun target(customer: ResellerCustomer): ResellerSaleTarget {
        val directory = state.resellerDirectory.firstOrNull { it.accountId == customer.accountId }
        return ResellerSaleTarget(
            customerId = customer.id,
            accountId = customer.accountId,
            name = customer.name,
            phone = customer.phone,
            balanceToman = directory?.balanceToman
        )
    }

    fun target(customer: ResellerDirectoryCustomer) = ResellerSaleTarget(
        customerId = null,
        accountId = customer.accountId,
        name = customer.name,
        phone = customer.phone,
        balanceToman = customer.balanceToman
    )

    AuroraBackground(Modifier.fillMaxSize()) {
        Scaffold(
            containerColor = Color.Transparent,
            snackbarHost = { SnackbarHost(snackbar, modifier = Modifier.navigationBarsPadding()) },
            bottomBar = {
                PartnerBottomBar(destination) { next ->
                    destination = next
                    if (next == ResellerDestination.SUPPORT) actions.markNotificationsRead()
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding)) {
                when (destination) {
                    ResellerDestination.OVERVIEW -> PartnerOverview(
                        account = account,
                        refreshing = state.refreshing,
                        onRefresh = actions::refresh,
                        onLogout = actions::logout,
                        onCustomers = { destination = ResellerDestination.CUSTOMERS },
                        onSale = { destination = ResellerDestination.PLANS },
                        onCustomer = {
                            selectedCustomer = it
                            it.accountId?.let { _ -> actions.searchResellerDirectory(it.phone) }
                        },
                        onOrder = { order ->
                            if (ResellerPolicy.canRenew(order)) renewOrder = order
                            else if (ResellerPolicy.canControl(order)) controlRequest = PartnerControlRequest(order, if (order.effectiveStatus == "suspended") "resume" else "suspend")
                        }
                    )
                    ResellerDestination.CUSTOMERS -> PartnerCustomers(
                        own = account.customers,
                        directory = state.resellerDirectory,
                        directoryQuery = state.resellerDirectoryQuery,
                        directoryLoading = state.resellerDirectoryLoading,
                        scope = customerScope,
                        onScope = { customerScope = it },
                        onSearchDirectory = actions::searchResellerDirectory,
                        onAdd = { addCustomer = true },
                        onOwn = {
                            selectedCustomer = it
                            actions.loadResellerCustomerAccess(it)
                            it.accountId?.let { _ -> actions.searchResellerDirectory(it.phone) }
                        },
                        onDirectory = { customer -> selectedTarget = target(customer) },
                        onSale = { customer ->
                            selectedTarget = target(customer)
                            destination = ResellerDestination.PLANS
                        },
                        onWallet = { customer -> walletTarget = target(customer) },
                        onDebt = { customer -> debtTarget = target(customer) }
                    )
                    ResellerDestination.PLANS -> PartnerSales(
                        plans = state.resellerPlans,
                        orders = account.orders,
                        balance = account.balanceToman,
                        target = selectedTarget,
                        onClearTarget = { selectedTarget = null },
                        onChooseTarget = {
                            pendingPlan = it
                            targetPicker = true
                        },
                        onBuy = { plan -> pendingPlan = plan },
                        onCustomers = { destination = ResellerDestination.CUSTOMERS },
                        onRenew = { renewOrder = it },
                        onControl = { order, action -> controlRequest = PartnerControlRequest(order, action) }
                    )
                    ResellerDestination.WALLET -> PartnerWallet(
                        account = account,
                        onReverse = { reverseTransfer = it },
                        onDebtAction = { debt, action -> debtAction = debt to action }
                    )
                    ResellerDestination.SUPPORT -> PartnerSupport(
                        account = account,
                        tickets = state.tickets,
                        onNew = { newTicket = true },
                        onOpen = actions::openTicket,
                        onLogout = actions::logout
                    )
                }
                if (state.actionBusy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
    }

    if (addCustomer) PartnerCreateCustomerDialog(
        busy = state.actionBusy,
        onDismiss = { addCustomer = false },
        onSubmit = { name, phone, password, note ->
            actions.createResellerCustomer(name, phone, password, note)
            addCustomer = false
        }
    )

    selectedCustomer?.let { customer ->
        val directory = state.resellerDirectory.firstOrNull { it.accountId == customer.accountId }
        PartnerOwnCustomerDialog(
            customer = customer,
            walletBalance = directory?.balanceToman,
            orders = account.orders.filter { it.customerId == customer.id },
            walletTransfers = customer.accountId?.let { id -> account.walletTransfers.filter { it.customerAccountId == id } }.orEmpty(),
            debts = customer.accountId?.let { id -> account.debts.filter { it.customerAccountId == id } }.orEmpty(),
            onDismiss = { selectedCustomer = null },
            onSale = {
                selectedTarget = target(customer)
                selectedCustomer = null
                destination = ResellerDestination.PLANS
            },
            onWallet = customer.accountId?.let { id ->
                { walletTarget = target(customer).copy(accountId = id) }
            },
            onDebt = customer.accountId?.let { id ->
                { debtTarget = target(customer).copy(accountId = id) }
            },
            passwordAccessLoading = state.resellerProfileLoadingId == customer.id,
            onReset = if (customer.id in state.resellerPasswordManagedCustomerIds) ({ resetCustomer = customer }) else null,
            onRenew = { renewOrder = it },
            onControl = { order, action -> controlRequest = PartnerControlRequest(order, action) },
            onReverse = { reverseTransfer = it },
            onDebtAction = { debt, action -> debtAction = debt to action }
        )
    }

    selectedTarget?.takeIf { destination == ResellerDestination.CUSTOMERS }?.let { customer ->
        PartnerDirectoryCustomerDialog(
            customer = customer,
            onDismiss = { selectedTarget = null },
            onSale = {
                destination = ResellerDestination.PLANS
            },
            onWallet = { walletTarget = customer },
            onDebt = { debtTarget = customer }
        )
    }

    if (targetPicker) PartnerTargetPickerDialog(
        own = account.customers,
        directory = state.resellerDirectory,
        onDismiss = { targetPicker = false; pendingPlan = null },
        onSelectOwn = {
            selectedTarget = target(it)
            targetPicker = false
        },
        onSelectDirectory = {
            selectedTarget = target(it)
            targetPicker = false
        },
        onNeedSearch = {
            targetPicker = false
            pendingPlan = null
            customerScope = PartnerCustomerScope.DIRECTORY
            destination = ResellerDestination.CUSTOMERS
        }
    )

    pendingPlan?.let { plan ->
        val currentTarget = selectedTarget
        if (!targetPicker && currentTarget != null) PartnerPurchaseDialog(
            plan = plan,
            target = currentTarget,
            resellerBalance = account.balanceToman,
            busy = state.actionBusy,
            onDismiss = { pendingPlan = null },
            onSubmit = { salePrice ->
                actions.resellerPurchaseTarget(plan, currentTarget, salePrice)
                pendingPlan = null
            }
        )
    }

    walletTarget?.let { customer ->
        PartnerWalletCreditDialog(
            customer = customer,
            resellerBalance = account.balanceToman,
            busy = state.actionBusy,
            onDismiss = { walletTarget = null },
            onSubmit = { amount, note ->
                customer.accountId?.let { actions.creditResellerCustomerWallet(it, amount, note) }
                walletTarget = null
            }
        )
    }

    debtTarget?.let { customer ->
        PartnerDebtDialog(
            customer = customer,
            busy = state.actionBusy,
            onDismiss = { debtTarget = null },
            onSubmit = { amount, note ->
                customer.accountId?.let { actions.createResellerCustomerDebt(it, amount, note) }
                debtTarget = null
            }
        )
    }

    reverseTransfer?.let { transfer ->
        PartnerWalletReverseDialog(
            transfer = transfer,
            busy = state.actionBusy,
            onDismiss = { reverseTransfer = null },
            onSubmit = { amount, reason ->
                actions.reverseResellerWalletTransfer(transfer, amount, reason)
                reverseTransfer = null
            }
        )
    }

    debtAction?.let { (debt, action) ->
        PartnerDebtActionDialog(debt, action, state.actionBusy, { debtAction = null }) {
            actions.controlResellerCustomerDebt(debt, action)
            debtAction = null
        }
    }

    resetCustomer?.let { customer ->
        PartnerPasswordDialog(customer, state.actionBusy, { resetCustomer = null }) {
            actions.resetResellerCustomerPassword(customer, it)
            resetCustomer = null
        }
    }

    renewOrder?.let { order ->
        val cost = state.resellerPlans.firstOrNull { it.id == order.planId }?.priceToman ?: 0
        PartnerRenewDialog(order, cost, account.balanceToman, state.actionBusy, { renewOrder = null }) {
            actions.resellerRenew(order, it)
            renewOrder = null
        }
    }

    controlRequest?.let { request ->
        PartnerControlDialog(request.order, request.action, state.actionBusy, { controlRequest = null }) { reason ->
            actions.controlResellerSubscription(request.order, request.action, reason)
            controlRequest = null
        }
    }

    if (newTicket) PartnerNewTicketDialog(state.actionBusy, { newTicket = false }) { subject, body ->
        actions.createTicket(subject, body)
        newTicket = false
    }
    state.ticketConversation?.let { conversation ->
        PartnerConversationDialog(conversation, state.actionBusy, actions::closeTicketConversation, actions::replyTicket)
    }
}

@Composable
private fun PartnerBottomBar(selected: ResellerDestination, onSelect: (ResellerDestination) -> Unit) {
    Surface(
        color = Color(0xE60A1228),
        tonalElevation = 0.dp,
        shadowElevation = 18.dp,
        border = BorderStroke(1.dp, Color.White.copy(.08f))
    ) {
        NavigationBar(containerColor = Color.Transparent, tonalElevation = 0.dp) {
            PartnerNavItem(ResellerDestination.OVERVIEW, selected, Icons.Rounded.SpaceDashboard, "خانه", onSelect)
            PartnerNavItem(ResellerDestination.CUSTOMERS, selected, Icons.Rounded.Groups, "مشتریان", onSelect)
            PartnerNavItem(ResellerDestination.PLANS, selected, Icons.Rounded.Storefront, "فروش", onSelect)
            PartnerNavItem(ResellerDestination.WALLET, selected, Icons.Rounded.AccountBalanceWallet, "کیف پول", onSelect)
            PartnerNavItem(ResellerDestination.SUPPORT, selected, Icons.Rounded.Forum, "پیام‌ها", onSelect)
        }
    }
}

@Composable
private fun RowScope.PartnerNavItem(destination: ResellerDestination, selected: ResellerDestination, icon: ImageVector, label: String, onSelect: (ResellerDestination) -> Unit) {
    NavigationBarItem(
        selected = destination == selected,
        onClick = { onSelect(destination) },
        icon = { Icon(icon, label) },
        label = { Text(label, maxLines = 1) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Color(0xFF071329),
            selectedTextColor = Color(0xFF58DAFF),
            indicatorColor = Color(0xFF58DAFF),
            unselectedIconColor = Color(0xFF8FA4C7),
            unselectedTextColor = Color(0xFF8FA4C7)
        )
    )
}

@Composable
private fun PartnerOverview(
    account: ResellerAccount,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onLogout: () -> Unit,
    onCustomers: () -> Unit,
    onSale: () -> Unit,
    onCustomer: (ResellerCustomer) -> Unit,
    onOrder: (ResellerOrder) -> Unit
) {
    LazyColumn(
        Modifier.fillMaxSize().statusBarsPadding(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item { PartnerHeader(account.name, "مرکز فروش و مدیریت مشتریان", refreshing, onRefresh, onLogout) }
        item {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(30.dp),
                color = Color.Transparent,
                border = BorderStroke(1.dp, Color(0xFF55D8FF).copy(.30f))
            ) {
                Column(
                    Modifier.background(Brush.linearGradient(listOf(Color(0xE6102B62), Color(0xF2081129)))).padding(22.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("اعتبار قابل فروش", color = Color(0xFFA9BBDD), style = MaterialTheme.typography.labelLarge)
                            Text(toman(account.balanceToman), color = Color(0xFF5DE1FF), fontSize = 30.sp, fontWeight = FontWeight.Black)
                        }
                        Box(Modifier.size(56.dp).background(Color(0x225DE1FF), CircleShape), contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.AccountBalanceWallet, null, tint = Color(0xFF5DE1FF), modifier = Modifier.size(29.dp))
                        }
                    }
                    Button(onClick = onSale, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                        Icon(Icons.Rounded.AddShoppingCart, null)
                        Spacer(Modifier.width(8.dp))
                        Text("فروش اشتراک")
                    }
                }
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PartnerMetric("مشتریان", account.customersCount, Icons.Rounded.Groups, Modifier.weight(1f), onCustomers)
                PartnerMetric("اشتراک فعال", account.activeSubscriptions, Icons.Rounded.Verified, Modifier.weight(1f), onCustomers)
            }
        }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PartnerMoney("کل فروش", account.totalRevenueToman, Icons.Rounded.Payments, Modifier.weight(1f))
                PartnerMoney("سود ثبت‌شده", account.totalProfitToman, Icons.AutoMirrored.Rounded.TrendingUp, Modifier.weight(1f))
            }
        }
        item { PartnerSection("مشتریان اخیر", "ورود سریع به پرونده", "مشاهده همه", onCustomers) }
        if (account.customers.isEmpty()) item { PartnerEmpty(Icons.Rounded.GroupAdd, "هنوز مشتری ندارید", "اولین مشتری را ثبت کنید و فروش را شروع کنید.") }
        else items(account.customers.take(4), key = { it.id }) { PartnerOwnCustomerRow(it, { onCustomer(it) }, onSale) }
        item { PartnerSection("فروش‌های اخیر", "وضعیت ساخت و تمدید") }
        if (account.orders.isEmpty()) item { PartnerEmpty(Icons.AutoMirrored.Rounded.ReceiptLong, "فروشی ثبت نشده", "از بخش فروش یک پلن را برای مشتری انتخاب کنید.") }
        else items(account.orders.take(4), key = { it.id }) { PartnerOrderRow(it, onOrder) }
    }
}

@Composable
private fun PartnerHeader(name: String, subtitle: String, refreshing: Boolean, onRefresh: () -> Unit, onLogout: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        NivoraLogo(Modifier.width(48.dp), compact = true, onDark = true)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("سلام، ${name.substringBefore(' ')}", color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
            Text(subtitle, color = Color(0xFF93A8CB), style = MaterialTheme.typography.bodySmall)
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تازه‌سازی", tint = Color(0xFFB8C8E4))
        }
        IconButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Rounded.Logout, "خروج", tint = Color(0xFFB8C8E4)) }
    }
}

@Composable
private fun PartnerMetric(label: String, value: Int, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    PartnerGlassCard(modifier.clickable(onClick = onClick)) {
        Icon(icon, null, tint = Color(0xFF5DE1FF))
        Spacer(Modifier.height(8.dp))
        Text(faNumber(value), color = Color.White, fontSize = 23.sp, fontWeight = FontWeight.Black)
        Text(label, color = Color(0xFF9AAED0), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun PartnerMoney(label: String, value: Int, icon: ImageVector, modifier: Modifier) {
    PartnerGlassCard(modifier) {
        Icon(icon, null, tint = Color(0xFF6DB7FF))
        Spacer(Modifier.height(8.dp))
        Text(toman(value), color = Color.White, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Black, maxLines = 1)
        Text(label, color = Color(0xFF9AAED0), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun PartnerCustomers(
    own: List<ResellerCustomer>,
    directory: List<ResellerDirectoryCustomer>,
    directoryQuery: String,
    directoryLoading: Boolean,
    scope: PartnerCustomerScope,
    onScope: (PartnerCustomerScope) -> Unit,
    onSearchDirectory: (String) -> Unit,
    onAdd: () -> Unit,
    onOwn: (ResellerCustomer) -> Unit,
    onDirectory: (ResellerDirectoryCustomer) -> Unit,
    onSale: (ResellerDirectoryCustomer) -> Unit,
    onWallet: (ResellerDirectoryCustomer) -> Unit,
    onDebt: (ResellerDirectoryCustomer) -> Unit
) {
    var ownQuery by rememberSaveable { mutableStateOf("") }
    var directoryInput by rememberSaveable(directoryQuery) { mutableStateOf(directoryQuery) }
    val filtered = remember(own, ownQuery) { own.filter { ResellerPolicy.matchesCustomer(it.name, it.phone, ownQuery) } }
    LazyColumn(
        Modifier.fillMaxSize().statusBarsPadding(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("مشتریان", color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Text("دفتر فروش و جست‌وجوی مشتریان مجاز سامانه", color = Color(0xFF94A8C9))
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(scope == PartnerCustomerScope.MINE, { onScope(PartnerCustomerScope.MINE) }, { Text("دفتر من") }, leadingIcon = { Icon(Icons.Rounded.PersonPin, null) })
                FilterChip(scope == PartnerCustomerScope.DIRECTORY, { onScope(PartnerCustomerScope.DIRECTORY) }, { Text("جست‌وجوی سراسری") }, leadingIcon = { Icon(Icons.AutoMirrored.Rounded.ManageSearch, null) })
            }
        }
        if (scope == PartnerCustomerScope.MINE) {
            item {
                Button(onClick = onAdd, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Rounded.PersonAdd, null)
                    Spacer(Modifier.width(7.dp))
                    Text("ساخت حساب مشتری با رمز")
                }
                Spacer(Modifier.height(8.dp))
                PartnerSearchField(ownQuery, { ownQuery = it }, "نام یا شماره موبایل")
            }
            if (filtered.isEmpty()) item { PartnerEmpty(Icons.Rounded.Groups, "مشتری پیدا نشد", "عبارت جست‌وجو را تغییر دهید یا مشتری جدید بسازید.") }
            else items(filtered, key = { it.id }) { customer -> PartnerOwnCustomerRow(customer, { onOwn(customer) }, {}) }
        } else {
            item {
                PartnerSearchField(directoryInput, { directoryInput = it }, "حداقل سه رقم یا حرف", { onSearchDirectory(directoryInput) }, directoryLoading)
                Spacer(Modifier.height(7.dp))
                Text("فقط حساب‌هایی نمایش داده می‌شوند که سرور اجازه دسترسی داده است.", color = Color(0xFF8095B8), style = MaterialTheme.typography.bodySmall)
            }
            if (directoryLoading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (!directoryLoading && directory.isEmpty()) item { PartnerEmpty(Icons.Rounded.PersonSearch, "نتیجه‌ای نیست", "نام یا شماره موبایل مشتری را جست‌وجو کنید.") }
            else items(directory, key = { it.accountId }) { customer ->
                PartnerDirectoryRow(customer, { onDirectory(customer) }, { onWallet(customer) }, { onSale(customer) }, { onDebt(customer) })
            }
        }
    }
}

@Composable
private fun PartnerSearchField(value: String, onValue: (String) -> Unit, label: String, onSearch: (() -> Unit)? = null, loading: Boolean = false) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        leadingIcon = { Icon(Icons.Rounded.Search, null) },
        trailingIcon = onSearch?.let { search ->
            {
                IconButton(onClick = search, enabled = !loading && value.trim().length >= 3) {
                    if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else Icon(Icons.AutoMirrored.Rounded.ArrowBack, "جست‌وجو")
                }
            }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { if (value.trim().length >= 3) onSearch?.invoke() }),
        shape = RoundedCornerShape(18.dp)
    )
}

@Composable
private fun PartnerOwnCustomerRow(customer: ResellerCustomer, onOpen: () -> Unit, onSale: () -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth().clickable(onClick = onOpen), padding = 15.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PartnerAvatar(customer.name)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(customer.name, color = Color.White, fontWeight = FontWeight.Bold)
                Text(customer.phone, color = Color(0xFF9BB0D1), style = MaterialTheme.typography.bodySmall)
            }
            Surface(color = Color(0x225DE1FF), shape = RoundedCornerShape(10.dp)) {
                Text("${faNumber(customer.activeSubscriptions)} فعال", Modifier.padding(horizontal = 9.dp, vertical = 5.dp), color = Color(0xFF5DE1FF), style = MaterialTheme.typography.labelMedium)
            }
        }
        if (customer.note.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(customer.note, color = Color(0xFF879DBF), style = MaterialTheme.typography.bodySmall, maxLines = 2)
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onOpen, modifier = Modifier.weight(1f)) { Text("پرونده") }
            Button(onClick = onSale, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.Add, null, Modifier.size(18.dp)); Text(" فروش") }
        }
    }
}

@Composable
private fun PartnerDirectoryRow(customer: ResellerDirectoryCustomer, onOpen: () -> Unit, onWallet: () -> Unit, onSale: () -> Unit, onDebt: () -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth().clickable(onClick = onOpen), padding = 15.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            PartnerAvatar(customer.name)
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(customer.name, color = Color.White, fontWeight = FontWeight.Bold)
                Text(customer.phone, color = Color(0xFF9BB0D1), style = MaterialTheme.typography.bodySmall)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("کیف پول", color = Color(0xFF8095B8), style = MaterialTheme.typography.labelSmall)
                Text(toman(customer.balanceToman), color = Color(0xFF5DE1FF), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(onClick = onWallet, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 7.dp)) { Icon(Icons.Rounded.AccountBalanceWallet, null, Modifier.size(17.dp)); Text(" شارژ") }
            FilledTonalButton(onClick = onDebt, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 7.dp)) { Icon(Icons.Rounded.RequestQuote, null, Modifier.size(17.dp)); Text(" بدهی") }
            Button(onClick = onSale, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 7.dp)) { Icon(Icons.Rounded.AddShoppingCart, null, Modifier.size(17.dp)); Text(" فروش") }
        }
    }
}

@Composable
private fun PartnerSales(
    plans: List<Plan>,
    orders: List<ResellerOrder>,
    balance: Int,
    target: ResellerSaleTarget?,
    onClearTarget: () -> Unit,
    onChooseTarget: (Plan) -> Unit,
    onBuy: (Plan) -> Unit,
    onCustomers: () -> Unit,
    onRenew: (ResellerOrder) -> Unit,
    onControl: (ResellerOrder, String) -> Unit
) {
    var scope by rememberSaveable { mutableStateOf(PartnerSalesScope.NEW) }
    LazyColumn(
        Modifier.fillMaxSize().statusBarsPadding(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("مرکز فروش", color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Text("ساخت، تمدید و کنترل سرویس‌های فروخته‌شده", color = Color(0xFF94A8C9))
            Spacer(Modifier.height(11.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(scope == PartnerSalesScope.NEW, { scope = PartnerSalesScope.NEW }, { Text("فروش جدید") }, leadingIcon = { Icon(Icons.Rounded.AddShoppingCart, null) })
                FilterChip(scope == PartnerSalesScope.HISTORY, { scope = PartnerSalesScope.HISTORY }, { Text("فروش‌ها") }, leadingIcon = { Icon(Icons.AutoMirrored.Rounded.ReceiptLong, null) })
            }
        }
        if (scope == PartnerSalesScope.NEW) {
            item {
                PartnerGlassCard(Modifier.fillMaxWidth(), padding = 15.dp) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.AccountBalanceWallet, null, tint = Color(0xFF5DE1FF))
                        Spacer(Modifier.width(8.dp))
                        Text("اعتبار همکاری", color = Color(0xFF9BB0D1), modifier = Modifier.weight(1f))
                        Text(toman(balance), color = Color.White, fontWeight = FontWeight.Black)
                    }
                    target?.let {
                        Spacer(Modifier.height(10.dp))
                        Row(Modifier.fillMaxWidth().background(Color(0x225DE1FF), RoundedCornerShape(14.dp)).padding(11.dp), verticalAlignment = Alignment.CenterVertically) {
                            PartnerAvatar(it.name, 36.dp)
                            Spacer(Modifier.width(8.dp))
                            Column(Modifier.weight(1f)) { Text(it.name, color = Color.White, fontWeight = FontWeight.Bold); Text(it.phone, color = Color(0xFF9BB0D1), style = MaterialTheme.typography.bodySmall) }
                            TextButton(onClick = onClearTarget) { Text("تغییر") }
                        }
                    }
                }
            }
            if (plans.isEmpty()) item { PartnerEmpty(Icons.Rounded.Inventory2, "پلنی برای فروش نیست", "مدیریت هنوز پلن فعالی در اختیار شما نگذاشته است.") }
            else items(plans, key = { it.id }) { plan ->
                PartnerPlanCard(plan, balance >= plan.priceToman) {
                    if (target == null) onChooseTarget(plan) else onBuy(plan)
                }
            }
        } else {
            if (orders.isEmpty()) item { PartnerEmpty(Icons.AutoMirrored.Rounded.ReceiptLong, "فروشی ثبت نشده", "پس از اولین فروش، سوابق اینجا نمایش داده می‌شود.") }
            else items(orders, key = { it.id }) { order ->
                PartnerOrderCard(order, onRenew, onControl)
            }
        }
        if (scope == PartnerSalesScope.NEW && target == null) item {
            TextButton(onClick = onCustomers, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Groups, null); Text(" انتخاب مشتری از دفترچه") }
        }
    }
}

@Composable
private fun PartnerPlanCard(plan: Plan, affordable: Boolean, onBuy: () -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 17.dp) {
        Row {
            Column(Modifier.weight(1f)) {
                Text(plan.name, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
                Text(plan.description.ifBlank { "اشتراک آماده تحویل فوری" }, color = Color(0xFF93A8C9), style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(toman(plan.priceToman), color = Color(0xFF5DE1FF), fontWeight = FontWeight.Black)
                Text("هزینه شما", color = Color(0xFF7F94B7), style = MaterialTheme.typography.labelSmall)
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            PartnerMiniStat("حجم", "${faNumber(plan.trafficGb)} گیگ", Modifier.weight(1f))
            PartnerMiniStat("اعتبار", "${faNumber(plan.durationDays)} روز", Modifier.weight(1f))
            PartnerMiniStat("دستگاه", faNumber(plan.deviceLimit), Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Button(onClick = onBuy, enabled = affordable, modifier = Modifier.fillMaxWidth()) {
            Text(if (affordable) "انتخاب و ساخت" else "موجودی ناکافی")
        }
    }
}

@Composable
private fun PartnerOrderRow(order: ResellerOrder, onOpen: (ResellerOrder) -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth().clickable { onOpen(order) }, padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(order.customerName, color = Color.White, fontWeight = FontWeight.Bold)
                Text("${order.planName} · ${shortDate(order.createdAt)}", color = Color(0xFF91A6C8), style = MaterialTheme.typography.bodySmall)
            }
            PartnerStatus(order.effectiveStatus)
        }
    }
}

@Composable
private fun PartnerOrderCard(order: ResellerOrder, onRenew: (ResellerOrder) -> Unit, onControl: (ResellerOrder, String) -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 15.dp) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Text(order.customerName, color = Color.White, fontWeight = FontWeight.Black)
                Text("${order.phone} · ${order.planName}", color = Color(0xFF9BB0D1), style = MaterialTheme.typography.bodySmall)
                Text("${order.locationName ?: "انتخاب خودکار"} · ${faNumber(order.remainingDays)} روز مانده", color = Color(0xFF7890B5), style = MaterialTheme.typography.labelSmall)
            }
            PartnerStatus(order.effectiveStatus)
        }
        Spacer(Modifier.height(9.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (ResellerPolicy.canRenew(order)) FilledTonalButton(onClick = { onRenew(order) }, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.Autorenew, null, Modifier.size(17.dp)); Text(" تمدید") }
            if (order.orderKind == "purchase" && order.effectiveStatus == "active") OutlinedButton(onClick = { onControl(order, "suspend") }, modifier = Modifier.weight(1f)) { Text("تعلیق") }
            if (order.orderKind == "purchase" && order.effectiveStatus == "suspended") Button(onClick = { onControl(order, "resume") }, modifier = Modifier.weight(1f)) { Text("فعال‌سازی") }
            if (order.orderKind == "purchase" && order.effectiveStatus !in setOf("deleted", "failed")) IconButton(onClick = { onControl(order, "delete") }) { Icon(Icons.Rounded.DeleteOutline, "حذف", tint = Color(0xFFFF7890)) }
        }
    }
}

@Composable
private fun PartnerWallet(account: ResellerAccount, onReverse: (ResellerWalletTransfer) -> Unit, onDebtAction: (ResellerDebt, String) -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize().statusBarsPadding(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("کیف پول همکاری", color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Text("برداشت فروش، شارژ مشتری و بازگشت وجه", color = Color(0xFF94A8C9))
        }
        item {
            Surface(shape = RoundedCornerShape(27.dp), color = Color.Transparent, border = BorderStroke(1.dp, Color(0xFF5DE1FF).copy(.25f))) {
                Column(Modifier.background(Brush.linearGradient(listOf(Color(0xFF11346C), Color(0xFF081126)))).padding(22.dp)) {
                    Text("موجودی فعلی", color = Color(0xFFA8BCDB))
                    Text(toman(account.balanceToman), color = Color(0xFF5DE1FF), fontSize = 29.sp, fontWeight = FontWeight.Black)
                    Text("هر شارژ مشتری مستقیماً از این اعتبار کسر می‌شود.", color = Color(0xFF849ABD), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item { PartnerSection("تراکنش‌ها", "${faNumber(account.transactions.size)} مورد اخیر") }
        if (account.transactions.isEmpty()) item { PartnerEmpty(Icons.AutoMirrored.Rounded.ReceiptLong, "تراکنشی نیست", "شارژها و فروش‌های شما اینجا ثبت می‌شوند.") }
        else items(account.transactions, key = { it.id }) { PartnerTransaction(it) }
        item { PartnerSection("شارژهای مشتریان", "قابل اصلاح تا سقف مبلغ باقی‌مانده") }
        if (account.walletTransfers.isEmpty()) item { PartnerEmpty(Icons.Rounded.SyncAlt, "انتقالی ثبت نشده", "شارژ کیف پول مشتریان در این بخش قابل پیگیری است.") }
        else items(account.walletTransfers, key = { it.id }) { PartnerWalletTransferRow(it, onReverse) }
        item { PartnerSection("بدهی‌های باز", "اعلام پرداخت مشتری را تأیید یا لغو کنید") }
        if (account.debts.isEmpty()) item { PartnerEmpty(Icons.Rounded.RequestQuote, "بدهی بازی نیست", "بدهی‌های فعال مشتریان اینجا نمایش داده می‌شوند.") }
        else items(account.debts, key = { it.id }) { PartnerDebtRow(it, onDebtAction) }
    }
}

@Composable
private fun PartnerSupport(account: ResellerAccount, tickets: List<SupportTicket>, onNew: () -> Unit, onOpen: (SupportTicket) -> Unit, onLogout: () -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize().statusBarsPadding(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            Text("پیام‌ها و پشتیبانی", color = Color.White, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
            Text("اعلان‌های فروش و گفت‌وگوی مستقیم با مدیریت", color = Color(0xFF94A8C9))
        }
        item { PartnerSection("اعلان‌ها", if (account.notifications.none { it.readAt == null }) "همه خوانده شده" else "${faNumber(account.notifications.count { it.readAt == null })} اعلان تازه") }
        if (account.notifications.isEmpty()) item { PartnerEmpty(Icons.Rounded.NotificationsNone, "اعلانی نیست", "فروش، شارژ و پاسخ مدیریت اینجا اعلام می‌شود.") }
        else items(account.notifications, key = { it.id }) { PartnerNotification(it) }
        item { PartnerSection("تیکت‌ها", "پیگیری درخواست‌های همکاری", "تیکت جدید", onNew) }
        if (tickets.isEmpty()) item { PartnerEmpty(Icons.AutoMirrored.Rounded.Chat, "گفت‌وگویی ندارید", "برای مدیریت پیام بفرستید.") }
        else items(tickets, key = { it.id }) { PartnerTicket(it) { onOpen(it) } }
        item { OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Rounded.Logout, null); Text(" خروج از حساب") } }
    }
}

@Composable
private fun PartnerGlassCard(modifier: Modifier = Modifier, padding: androidx.compose.ui.unit.Dp = 16.dp, content: @Composable ColumnScope.() -> Unit) {
    Surface(modifier, shape = RoundedCornerShape(22.dp), color = Color(0xB20C1730), border = BorderStroke(1.dp, Color.White.copy(.09f))) {
        Column(Modifier.padding(padding), content = content)
    }
}

@Composable
private fun PartnerAvatar(name: String, size: androidx.compose.ui.unit.Dp = 43.dp) {
    Box(
        Modifier.size(size).background(Brush.linearGradient(listOf(Color(0xFF235CC8), Color(0xFF27D6FF))), RoundedCornerShape(size / 3)),
        contentAlignment = Alignment.Center
    ) { Text(name.trim().take(1), color = Color.White, fontWeight = FontWeight.Black) }
}

@Composable
private fun PartnerSection(title: String, subtitle: String? = null, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold); subtitle?.let { Text(it, color = Color(0xFF8096B9), style = MaterialTheme.typography.bodySmall) } }
        if (action != null && onAction != null) TextButton(onClick = onAction) { Text(action) }
    }
}

@Composable
private fun PartnerMiniStat(label: String, value: String, modifier: Modifier) {
    Column(modifier.background(Color.White.copy(.05f), RoundedCornerShape(13.dp)).padding(9.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = Color.White, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Text(label, color = Color(0xFF8197BA), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun PartnerStatus(status: String) {
    val color = when (status) {
        "active" -> Color(0xFF4DE1B0)
        "suspended" -> Color(0xFFFFB75D)
        "failed", "deleted" -> Color(0xFFFF718B)
        else -> Color(0xFF76B5FF)
    }
    val label = when (status) {
        "active" -> "فعال"
        "suspended" -> "تعلیق"
        "deleted" -> "حذف‌شده"
        "failed" -> "ناموفق"
        "expired" -> "منقضی"
        "pending_provision" -> "در حال ساخت"
        else -> status
    }
    Surface(color = color.copy(.14f), shape = RoundedCornerShape(10.dp)) { Text(label, Modifier.padding(horizontal = 9.dp, vertical = 5.dp), color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold) }
}

@Composable
private fun PartnerEmpty(icon: ImageVector, title: String, body: String) {
    PartnerGlassCard(Modifier.fillMaxWidth()) {
        Icon(icon, null, tint = Color(0xFF5DE1FF), modifier = Modifier.size(31.dp))
        Spacer(Modifier.height(8.dp))
        Text(title, color = Color.White, fontWeight = FontWeight.Bold)
        Text(body, color = Color(0xFF8FA4C6), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun PartnerTransaction(item: WalletTransaction) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).background((if (item.amountToman >= 0) Color(0xFF46D7A4) else Color(0xFFFF718B)).copy(.14f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(if (item.amountToman >= 0) Icons.Rounded.SouthWest else Icons.Rounded.NorthEast, null, tint = if (item.amountToman >= 0) Color(0xFF46D7A4) else Color(0xFFFF718B), modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) { Text(item.note ?: "تراکنش کیف پول", color = Color.White, fontWeight = FontWeight.Bold); Text(shortDate(item.createdAt), color = Color(0xFF8095B8), style = MaterialTheme.typography.bodySmall) }
            Text("${if (item.amountToman > 0) "+" else ""}${toman(item.amountToman)}", color = if (item.amountToman >= 0) Color(0xFF46D7A4) else Color(0xFFFF8AA0), fontWeight = FontWeight.Black)
        }
    }
}

@Composable
private fun PartnerWalletTransferRow(item: ResellerWalletTransfer, onReverse: (ResellerWalletTransfer) -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).background(Color(0x225DE1FF), CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.SyncAlt, null, tint = Color(0xFF5DE1FF), modifier = Modifier.size(19.dp))
            }
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(item.customerName, color = Color.White, fontWeight = FontWeight.Bold)
                Text("${item.customerPhone} · ${shortDate(item.createdAt)}", color = Color(0xFF849ABD), style = MaterialTheme.typography.bodySmall)
                if (item.note.isNotBlank()) Text(item.note, color = Color(0xFF94A8C9), style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(toman(item.amountToman), color = Color(0xFF5DE1FF), fontWeight = FontWeight.Black)
                if (item.reversedAmountToman > 0) Text("برگشت ${toman(item.reversedAmountToman)}", color = Color(0xFFFFB75D), style = MaterialTheme.typography.labelSmall)
            }
        }
        if (item.remainingAmountToman > 0 && item.status != "reversed") {
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { onReverse(item) }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Rounded.Undo, null, Modifier.size(17.dp)); Text(" اصلاح / برگشت شارژ") }
        }
    }
}

@Composable
private fun PartnerDebtRow(item: ResellerDebt, onAction: (ResellerDebt, String) -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 14.dp) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(Icons.Rounded.RequestQuote, null, tint = if (item.status == "payment_reported") Color(0xFF4DE1B0) else Color(0xFFFFB75D))
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(item.customerName, color = Color.White, fontWeight = FontWeight.Bold)
                Text(item.note, color = Color(0xFF9BB0D1), style = MaterialTheme.typography.bodySmall)
                Text(if (item.status == "payment_reported") "مشتری پرداخت را اعلام کرده" else "در انتظار پرداخت", color = if (item.status == "payment_reported") Color(0xFF4DE1B0) else Color(0xFFFFB75D), style = MaterialTheme.typography.labelSmall)
            }
            Text(toman(item.amountToman), color = Color.White, fontWeight = FontWeight.Black)
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { onAction(item, "settle") }, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.CheckCircle, null, Modifier.size(17.dp)); Text(" تسویه شد") }
            OutlinedButton(onClick = { onAction(item, "cancel") }, modifier = Modifier.weight(1f)) { Text("لغو بدهی") }
        }
    }
}

@Composable
private fun PartnerNotification(item: CustomerNotification) {
    PartnerGlassCard(Modifier.fillMaxWidth(), padding = 14.dp) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.size(9.dp).background(if (item.readAt == null) Color(0xFF5DE1FF) else Color(0xFF526784), CircleShape))
            Spacer(Modifier.width(9.dp))
            Column { Text(item.title, color = Color.White, fontWeight = FontWeight.Bold); Text(item.body, color = Color(0xFFA0B2D0), style = MaterialTheme.typography.bodySmall); Text(shortDate(item.createdAt), color = Color(0xFF7188AD), style = MaterialTheme.typography.labelSmall) }
        }
    }
}

@Composable
private fun PartnerTicket(ticket: SupportTicket, onClick: () -> Unit) {
    PartnerGlassCard(Modifier.fillMaxWidth().clickable(onClick = onClick), padding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Forum, null, tint = Color(0xFF5DE1FF))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) { Text(ticket.subject, color = Color.White, fontWeight = FontWeight.Bold); Text(ticket.lastMessage ?: "بدون پیام", color = Color(0xFF8FA4C6), style = MaterialTheme.typography.bodySmall, maxLines = 1) }
            PartnerStatus(if (ticket.status == "answered") "active" else ticket.status)
        }
    }
}

@Composable
private fun PartnerDialog(onDismiss: () -> Unit, title: String, subtitle: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Surface(
            modifier = Modifier.fillMaxWidth().heightIn(max = 680.dp),
            shape = RoundedCornerShape(27.dp),
            color = Color(0xFF0A142B),
            border = BorderStroke(1.dp, Color(0xFF5DE1FF).copy(.20f)),
            shadowElevation = 24.dp
        ) {
            Column(Modifier.padding(19.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
                Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
                subtitle?.let { Text(it, color = Color(0xFF92A8CA), style = MaterialTheme.typography.bodySmall) }
                content()
            }
        }
    }
}

@Composable
private fun PartnerCreateCustomerDialog(busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String, String, String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    PartnerDialog(onDismiss, "ساخت حساب مشتری", "شماره موبایل تکراری پذیرفته نمی‌شود و مشتری با همین رمز وارد اپ می‌شود.") {
        PartnerField(name, { name = it.take(80) }, "نام و نام خانوادگی", Icons.Rounded.PersonOutline)
        PartnerField(phone, { phone = it.filter(Char::isDigit).take(11) }, "شماره موبایل", Icons.Rounded.PhoneAndroid, KeyboardType.Phone)
        PartnerPasswordField(password, { password = it }, "رمز ورود مشتری")
        PartnerField(note, { note = it.take(300) }, "یادداشت داخلی (اختیاری)", Icons.AutoMirrored.Rounded.Notes)
        error?.let { Text(it, color = Color(0xFFFF7890), style = MaterialTheme.typography.bodySmall) }
        Button(onClick = {
            error = when {
                name.trim().length < 2 -> "نام مشتری را کامل وارد کنید"
                !phone.matches(Regex("09\\d{9}")) -> "شماره موبایل معتبر نیست"
                password.length < 8 -> "رمز باید حداقل ۸ کاراکتر باشد"
                else -> null
            }
            if (error == null) onSubmit(name.trim(), phone, password, note.trim())
        }, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("ساخت حساب و پرونده") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerOwnCustomerDialog(
    customer: ResellerCustomer,
    walletBalance: Int?,
    orders: List<ResellerOrder>,
    walletTransfers: List<ResellerWalletTransfer>,
    debts: List<ResellerDebt>,
    onDismiss: () -> Unit,
    onSale: () -> Unit,
    onWallet: (() -> Unit)?,
    onDebt: (() -> Unit)?,
    passwordAccessLoading: Boolean,
    onReset: (() -> Unit)?,
    onRenew: (ResellerOrder) -> Unit,
    onControl: (ResellerOrder, String) -> Unit,
    onReverse: (ResellerWalletTransfer) -> Unit,
    onDebtAction: (ResellerDebt, String) -> Unit
) {
    PartnerDialog(onDismiss, customer.name, "${customer.phone} · پرونده اختصاصی شما") {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            PartnerMiniStat("اشتراک فعال", faNumber(customer.activeSubscriptions), Modifier.weight(1f))
            PartnerMiniStat("فروش", toman(customer.revenueToman), Modifier.weight(1f))
            PartnerMiniStat("کیف پول", walletBalance?.let(::toman) ?: "در حال دریافت", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Button(onClick = onSale, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Icon(Icons.Rounded.AddShoppingCart, null, Modifier.size(17.dp)); Text(" فروش") }
            if (onWallet != null) FilledTonalButton(onClick = onWallet, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("شارژ کیف پول") }
            if (onDebt != null) OutlinedButton(onClick = onDebt, modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 6.dp)) { Text("ثبت بدهی") }
        }
        if (passwordAccessLoading) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        } else if (onReset != null) {
            TextButton(onClick = onReset, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Password, null); Text(" تغییر رمز مشتری") }
        }
        Text("اشتراک‌های فروخته‌شده", color = Color.White, fontWeight = FontWeight.Bold)
        if (orders.isEmpty()) Text("هنوز اشتراکی برای این مشتری ثبت نشده است.", color = Color(0xFF8FA4C6))
        else LazyColumn(Modifier.heightIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(orders, key = { it.id }) { order -> PartnerOrderCard(order, onRenew, onControl) }
        }
        if (walletTransfers.isNotEmpty()) {
            Text("شارژهای ثبت‌شده", color = Color.White, fontWeight = FontWeight.Bold)
            walletTransfers.take(3).forEach { PartnerWalletTransferRow(it, onReverse) }
        }
        if (debts.isNotEmpty()) {
            Text("بدهی‌های باز", color = Color.White, fontWeight = FontWeight.Bold)
            debts.take(3).forEach { PartnerDebtRow(it, onDebtAction) }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("بستن") }
    }
}

@Composable
private fun PartnerDirectoryCustomerDialog(customer: ResellerSaleTarget, onDismiss: () -> Unit, onSale: () -> Unit, onWallet: () -> Unit, onDebt: () -> Unit) {
    PartnerDialog(onDismiss, customer.name, "${customer.phone} · مشتری موجود سامانه") {
        PartnerGlassCard(Modifier.fillMaxWidth()) {
            Text("موجودی کیف پول مشتری", color = Color(0xFF93A8C9))
            Text(customer.balanceToman?.let(::toman) ?: "نامشخص", color = Color(0xFF5DE1FF), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black)
        }
        Button(onClick = onSale, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.AddShoppingCart, null); Text(" فروش اشتراک") }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onWallet, modifier = Modifier.weight(1f)) { Text("شارژ کیف پول") }
            OutlinedButton(onClick = onDebt, modifier = Modifier.weight(1f)) { Text("ثبت بدهی") }
        }
        Text("پس از اولین فروش یا شارژ، این مشتری به دفتر شما متصل می‌شود.", color = Color(0xFF8095B8), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("بستن") }
    }
}

@Composable
private fun PartnerTargetPickerDialog(
    own: List<ResellerCustomer>,
    directory: List<ResellerDirectoryCustomer>,
    onDismiss: () -> Unit,
    onSelectOwn: (ResellerCustomer) -> Unit,
    onSelectDirectory: (ResellerDirectoryCustomer) -> Unit,
    onNeedSearch: () -> Unit
) {
    var query by rememberSaveable { mutableStateOf("") }
    val ownRows = own.filter { ResellerPolicy.matchesCustomer(it.name, it.phone, query) }
    val knownAccounts = own.mapNotNull { it.accountId }.toSet()
    val directoryRows = directory.filter { it.accountId !in knownAccounts && ResellerPolicy.matchesCustomer(it.name, it.phone, query) }
    PartnerDialog(onDismiss, "انتخاب مشتری", "فروش فقط برای مشتری انتخاب‌شده ثبت می‌شود.") {
        PartnerSearchField(query, { query = it }, "نام یا شماره موبایل")
        LazyColumn(Modifier.heightIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            items(ownRows, key = { "own-${it.id}" }) { customer ->
                PartnerPickerRow(customer.name, customer.phone, "دفتر من") { onSelectOwn(customer) }
            }
            items(directoryRows, key = { "directory-${it.accountId}" }) { customer ->
                PartnerPickerRow(customer.name, customer.phone, "مشتری سامانه") { onSelectDirectory(customer) }
            }
        }
        TextButton(onClick = onNeedSearch, modifier = Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Rounded.ManageSearch, null); Text(" جست‌وجوی کامل مشتریان") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerPickerRow(name: String, phone: String, badge: String, onClick: () -> Unit) {
    Surface(Modifier.fillMaxWidth().clickable(onClick = onClick), color = Color.White.copy(.05f), shape = RoundedCornerShape(14.dp)) {
        Row(Modifier.padding(11.dp), verticalAlignment = Alignment.CenterVertically) {
            PartnerAvatar(name, 35.dp); Spacer(Modifier.width(8.dp)); Column(Modifier.weight(1f)) { Text(name, color = Color.White, fontWeight = FontWeight.Bold); Text(phone, color = Color(0xFF8FA4C6), style = MaterialTheme.typography.bodySmall) }; Text(badge, color = Color(0xFF5DE1FF), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun PartnerPurchaseDialog(plan: Plan, target: ResellerSaleTarget, resellerBalance: Int, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int) -> Unit) {
    var saleText by rememberSaveable(plan.id, target.phone) { mutableStateOf(plan.priceToman.toString()) }
    val sale = saleText.toIntOrNull() ?: 0
    val profit = ResellerPolicy.profit(sale, plan.priceToman)
    PartnerDialog(onDismiss, "فروش ${plan.name}", "برای ${target.name} · ${target.phone}") {
        PartnerGlassCard(Modifier.fillMaxWidth()) {
            Row { Text("هزینه همکاری", color = Color(0xFF9BB0D1), modifier = Modifier.weight(1f)); Text(toman(plan.priceToman), color = Color.White, fontWeight = FontWeight.Bold) }
            Row { Text("اعتبار شما", color = Color(0xFF9BB0D1), modifier = Modifier.weight(1f)); Text(toman(resellerBalance), color = Color(0xFF5DE1FF), fontWeight = FontWeight.Bold) }
        }
        PartnerNumberField(saleText, { saleText = it }, "مبلغ فروش به مشتری")
        Row { Text("سود این فروش", color = Color(0xFF9BB0D1), modifier = Modifier.weight(1f)); Text("${if (profit >= 0) "+" else ""}${toman(profit)}", color = if (profit >= 0) Color(0xFF4DE1B0) else Color(0xFFFF7890), fontWeight = FontWeight.Black) }
        Button(onClick = { onSubmit(sale) }, enabled = !busy && sale >= 0 && resellerBalance >= plan.priceToman, modifier = Modifier.fillMaxWidth()) { Text("پرداخت و ساخت اشتراک") }
        if (resellerBalance < plan.priceToman) Text("اعتبار همکاری برای این فروش کافی نیست.", color = Color(0xFFFF7890), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerWalletCreditDialog(customer: ResellerSaleTarget, resellerBalance: Int, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int, String) -> Unit) {
    var amountText by rememberSaveable(customer.phone) { mutableStateOf("") }
    var note by rememberSaveable(customer.phone) { mutableStateOf("شارژ توسط همکار فروش") }
    val amount = amountText.toIntOrNull() ?: 0
    PartnerDialog(onDismiss, "شارژ کیف پول", "${customer.name} · موجودی فعلی ${customer.balanceToman?.let(::toman) ?: "نامشخص"}") {
        PartnerNumberField(amountText, { amountText = it }, "مبلغ شارژ (تومان)")
        PartnerField(note, { note = it.take(250) }, "توضیح تراکنش", Icons.AutoMirrored.Rounded.Notes)
        Text("مبلغ از اعتبار همکاری شما کسر و به کیف پول مشتری افزوده می‌شود.", color = Color(0xFF8FA4C6), style = MaterialTheme.typography.bodySmall)
        Button(onClick = { onSubmit(amount, note.trim()) }, enabled = !busy && ResellerPolicy.validTransfer(amount, resellerBalance), modifier = Modifier.fillMaxWidth()) { Text("تأیید انتقال ${if (amount > 0) toman(amount) else ""}") }
        if (amount > resellerBalance) Text("اعتبار همکاری کافی نیست.", color = Color(0xFFFF7890))
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerDebtDialog(customer: ResellerSaleTarget, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int, String) -> Unit) {
    var amountText by rememberSaveable(customer.phone) { mutableStateOf("") }
    var note by rememberSaveable(customer.phone) { mutableStateOf("") }
    val amount = amountText.toIntOrNull() ?: 0
    PartnerDialog(onDismiss, "ثبت بدهی مشتری", "بدهی در اپ ${customer.name} نمایش داده و اعلان می‌شود.") {
        PartnerNumberField(amountText, { amountText = it }, "مبلغ بدهی (تومان)")
        PartnerField(note, { note = it.take(250) }, "دلیل بدهی", Icons.Rounded.RequestQuote)
        Button(onClick = { onSubmit(amount, note.trim()) }, enabled = !busy && ResellerPolicy.validDebt(amount, note), modifier = Modifier.fillMaxWidth()) { Text("ثبت و اطلاع به مشتری") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerWalletReverseDialog(transfer: ResellerWalletTransfer, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int?, String) -> Unit) {
    var amountText by rememberSaveable(transfer.id) { mutableStateOf(transfer.remainingAmountToman.toString()) }
    var reason by rememberSaveable(transfer.id) { mutableStateOf("اصلاح شارژ توسط همکار فروش") }
    val amount = amountText.toIntOrNull() ?: 0
    PartnerDialog(onDismiss, "اصلاح شارژ ${transfer.customerName}", "حداکثر مبلغ قابل برگشت ${toman(transfer.remainingAmountToman)}") {
        PartnerNumberField(amountText, { amountText = it }, "مبلغ برگشت")
        PartnerField(reason, { reason = it.take(250) }, "دلیل اصلاح", Icons.AutoMirrored.Rounded.Notes)
        Text("مبلغ از کیف پول مشتری کسر و به اعتبار همکاری شما بازگردانده می‌شود.", color = Color(0xFFFFB6C3), style = MaterialTheme.typography.bodySmall)
        Button(
            onClick = { onSubmit(amount, reason.trim()) },
            enabled = !busy && amount in 1..transfer.remainingAmountToman && reason.trim().length >= 3,
            modifier = Modifier.fillMaxWidth()
        ) { Text("تأیید برگشت ${if (amount > 0) toman(amount) else ""}") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerDebtActionDialog(debt: ResellerDebt, action: String, busy: Boolean, onDismiss: () -> Unit, onSubmit: () -> Unit) {
    val settle = action == "settle"
    PartnerDialog(
        onDismiss,
        if (settle) "تأیید تسویه بدهی" else "لغو بدهی",
        "${debt.customerName} · ${toman(debt.amountToman)}"
    ) {
        Text(
            if (settle) "پس از تأیید، بدهی در اپ مشتری پرداخت‌شده نمایش داده می‌شود."
            else "این بدهی لغو می‌شود و دیگر از مشتری مطالبه نخواهد شد.",
            color = Color(0xFF9BB0D1)
        )
        Button(
            onClick = onSubmit,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            colors = if (settle) ButtonDefaults.buttonColors() else ButtonDefaults.buttonColors(containerColor = Color(0xFF9E3850))
        ) { Text(if (settle) "پرداخت تأیید شد" else "بدهی لغو شود") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerPasswordDialog(customer: ResellerCustomer, busy: Boolean, onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var password by rememberSaveable(customer.id) { mutableStateOf("") }
    PartnerDialog(onDismiss, "تغییر رمز ${customer.name}", "نشست‌های قبلی مشتری پس از تغییر رمز بسته می‌شوند.") {
        PartnerPasswordField(password, { password = it }, "رمز جدید")
        Button(onClick = { onSubmit(password) }, enabled = !busy && password.length >= 8, modifier = Modifier.fillMaxWidth()) { Text("ذخیره رمز جدید") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerRenewDialog(order: ResellerOrder, cost: Int, balance: Int, busy: Boolean, onDismiss: () -> Unit, onSubmit: (Int) -> Unit) {
    var saleText by rememberSaveable(order.id) { mutableStateOf((order.salePriceToman.takeIf { it > 0 } ?: cost).toString()) }
    val sale = saleText.toIntOrNull() ?: 0
    val profit = ResellerPolicy.profit(sale, cost)
    PartnerDialog(onDismiss, "تمدید ${order.planName}", "${order.customerName} · هزینه شما ${toman(cost)}") {
        PartnerNumberField(saleText, { saleText = it }, "مبلغ تمدید برای مشتری")
        Row { Text("سود تمدید", color = Color(0xFF9BB0D1), modifier = Modifier.weight(1f)); Text("${if (profit >= 0) "+" else ""}${toman(profit)}", color = if (profit >= 0) Color(0xFF4DE1B0) else Color(0xFFFF7890), fontWeight = FontWeight.Black) }
        Button(onClick = { onSubmit(sale) }, enabled = !busy && balance >= cost && sale >= 0, modifier = Modifier.fillMaxWidth()) { Text("تأیید و تمدید") }
        if (balance < cost) Text("اعتبار همکاری کافی نیست.", color = Color(0xFFFF7890))
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerControlDialog(order: ResellerOrder, action: String, busy: Boolean, onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var reason by rememberSaveable(order.id, action) { mutableStateOf("") }
    var confirmed by rememberSaveable(order.id, action) { mutableStateOf(false) }
    val title = when (action) { "suspend" -> "تعلیق اشتراک"; "resume" -> "فعال‌سازی اشتراک"; else -> "حذف اشتراک" }
    PartnerDialog(onDismiss, title, "${order.customerName} · ${order.planName}") {
        if (action != "resume") PartnerField(reason, { reason = it.take(250) }, if (action == "suspend") "دلیل تعلیق برای مشتری" else "دلیل حذف (اختیاری)", Icons.AutoMirrored.Rounded.Notes)
        if (action == "delete") Row(Modifier.fillMaxWidth().clickable { confirmed = !confirmed }, verticalAlignment = Alignment.CenterVertically) { Checkbox(confirmed, { confirmed = it }); Text("می‌دانم حذف اشتراک قابل بازگشت نیست.", color = Color(0xFFFFA0B0), style = MaterialTheme.typography.bodySmall) }
        Button(
            onClick = { onSubmit(reason.trim()) },
            enabled = !busy && when (action) { "suspend" -> reason.trim().length >= 3; "delete" -> confirmed; else -> true },
            modifier = Modifier.fillMaxWidth(),
            colors = if (action == "delete") ButtonDefaults.buttonColors(containerColor = Color(0xFFB92F4B)) else ButtonDefaults.buttonColors()
        ) { Text(title) }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerNewTicketDialog(busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String) -> Unit) {
    var subject by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    PartnerDialog(onDismiss, "تیکت جدید", "درخواست شما مستقیم برای مدیریت ارسال می‌شود.") {
        PartnerField(subject, { subject = it.take(120) }, "موضوع", Icons.AutoMirrored.Rounded.Subject)
        OutlinedTextField(body, { body = it.take(1500) }, Modifier.fillMaxWidth(), label = { Text("متن پیام") }, minLines = 4, shape = RoundedCornerShape(16.dp))
        Button(onClick = { onSubmit(subject.trim(), body.trim()) }, enabled = !busy && subject.trim().length >= 3 && body.trim().length >= 3, modifier = Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Rounded.Send, null); Text(" ارسال") }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("انصراف") }
    }
}

@Composable
private fun PartnerConversationDialog(conversation: TicketConversation, busy: Boolean, onDismiss: () -> Unit, onReply: (String) -> Unit) {
    var reply by rememberSaveable(conversation.id) { mutableStateOf("") }
    PartnerDialog(onDismiss, conversation.subject, if (conversation.status == "closed") "گفت‌وگو بسته شده است" else "گفت‌وگو با مدیریت") {
        LazyColumn(Modifier.heightIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(conversation.messages, key = { it.id }) { message ->
                val mine = message.senderRole != "admin"
                Surface(
                    modifier = Modifier.fillMaxWidth(if (mine) .88f else .92f).align(if (mine) Alignment.End else Alignment.Start),
                    color = if (mine) Color(0xFF123D77) else Color.White.copy(.07f),
                    shape = RoundedCornerShape(15.dp)
                ) {
                    Column(Modifier.padding(11.dp)) { Text(if (mine) "شما" else "مدیریت", color = Color(0xFF5DE1FF), style = MaterialTheme.typography.labelSmall); Text(message.body, color = Color.White); Text(shortDate(message.createdAt), color = Color(0xFF849ABD), style = MaterialTheme.typography.labelSmall) }
                }
            }
        }
        if (conversation.status != "closed") {
            OutlinedTextField(reply, { reply = it.take(1200) }, Modifier.fillMaxWidth(), label = { Text("پاسخ") }, minLines = 2, shape = RoundedCornerShape(16.dp))
            Button(onClick = { onReply(reply.trim()); reply = "" }, enabled = !busy && reply.trim().length >= 2, modifier = Modifier.fillMaxWidth()) { Icon(Icons.AutoMirrored.Rounded.Send, null); Text(" ارسال پاسخ") }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("بستن") }
    }
}

@Composable
private fun PartnerField(value: String, onValue: (String) -> Unit, label: String, icon: ImageVector, keyboardType: KeyboardType = KeyboardType.Text) {
    OutlinedTextField(value, onValue, Modifier.fillMaxWidth(), label = { Text(label) }, leadingIcon = { Icon(icon, null) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = keyboardType), shape = RoundedCornerShape(16.dp))
}

@Composable
private fun PartnerPasswordField(value: String, onValue: (String) -> Unit, label: String) {
    OutlinedTextField(value, onValue, Modifier.fillMaxWidth(), label = { Text(label) }, leadingIcon = { Icon(Icons.Rounded.Lock, null) }, visualTransformation = PasswordVisualTransformation(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), shape = RoundedCornerShape(16.dp))
}

@Composable
private fun PartnerNumberField(value: String, onValue: (String) -> Unit, label: String) {
    OutlinedTextField(value, { onValue(it.filter(Char::isDigit).take(10)) }, Modifier.fillMaxWidth(), label = { Text(label) }, leadingIcon = { Icon(Icons.Rounded.Payments, null) }, suffix = { Text("تومان") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), shape = RoundedCornerShape(16.dp))
}
