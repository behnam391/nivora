package ir.nivora.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import android.util.Base64

class ApiClient(private val baseUrl: String, private val deviceId: String = "") {
    private data class RawResponse(val status: Int, val body: String)

    // JSONObject represents a JSON null as the literal text "null" on some Android versions.
    // Do not let that leak into the UI as a location name or country code.
    private fun JSONObject.cleanText(key: String): String? = optString(key, "")
        .trim()
        .takeUnless { it.isEmpty() || it.equals("null", true) || it.equals("undefined", true) }

    // Older orders predate location assignment. Infer only their display country
    // from the plan/location title; new orders always use the server country code.
    private fun inferredCountry(label: String?): String? {
        val text = label?.lowercase().orEmpty()
        return when {
            "فنلاند" in text || "finland" in text || "helsinki" in text || "هلسینکی" in text -> "FI"
            "آلمان" in text || "germany" in text || "nuremberg" in text || "نورمبرگ" in text -> "DE"
            "هلند" in text || "netherlands" in text -> "NL"
            "فرانسه" in text || "france" in text -> "FR"
            "ترکیه" in text || "turkey" in text -> "TR"
            "امارات" in text || "uae" in text -> "AE"
            "آمریکا" in text || "america" in text || "united states" in text -> "US"
            "انگلیس" in text || "بریتانیا" in text || "uk" in text -> "GB"
            "کانادا" in text || "canada" in text -> "CA"
            "سنگاپور" in text || "singapore" in text -> "SG"
            "ژاپن" in text || "japan" in text -> "JP"
            "ایران" in text || "iran" in text -> "IR"
            else -> null
        }
    }

    private fun rawRequest(
        path: String,
        method: String = "GET",
        token: String? = null,
        body: JSONObject? = null,
        connectTimeoutMs: Int = 12_000,
        readTimeoutMs: Int = 20_000
    ): RawResponse {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Language", "fa-IR")
            if (deviceId.isNotBlank()) setRequestProperty("X-Nivora-Device", deviceId)
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        return try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val code = runCatching { JSONObject(raw).optString("error") }.getOrNull().orEmpty()
                throw ApiException(code.ifBlank { "SERVER_ERROR" }, status)
            }
            RawResponse(status, raw)
        } finally {
            connection.disconnect()
        }
    }

    private fun request(
        path: String,
        method: String = "GET",
        token: String? = null,
        body: JSONObject? = null,
        connectTimeoutMs: Int = 12_000,
        readTimeoutMs: Int = 20_000
    ): JSONObject {
        val raw = rawRequest(path, method, token, body, connectTimeoutMs, readTimeoutMs).body
        return runCatching { JSONObject(raw) }.getOrElse { throw ApiException("INVALID_SERVER_RESPONSE", 502) }
    }

    private fun deviceRecovery(root: JSONObject): DeviceRecoveryRequest {
        // Accept both the flat response planned by Nivora and common wrapped
        // shapes so the app can be released before the server endpoint lands.
        val payload = root.optJSONObject("request")
            ?: root.optJSONObject("data")?.optJSONObject("request")
            ?: root.optJSONObject("data")
            ?: root
        val id = payload.cleanText("id")
            ?: payload.cleanText("requestId")
            ?: root.cleanText("requestId")
        val status = DeviceRecoveryPolicy.normalizeStatus(
            payload.cleanText("status") ?: root.cleanText("status")
        )
        val message = payload.cleanText("message")
            ?: payload.cleanText("reviewNote")
            ?: root.cleanText("message")
        return DeviceRecoveryRequest(id, status, message)
    }

    fun login(phone: String, password: String, role: String) = session(
        request(if (role == "reseller") "/api/reseller/login" else "/api/customer/login", "POST", body = JSONObject().put("phone", phone).put("password", password)), role
    )

    fun requestDeviceRecovery(phone: String, password: String): DeviceRecoveryRequest = deviceRecovery(
        request(
            "/api/device-recovery/request",
            "POST",
            body = JSONObject().put("phone", phone).put("password", password)
        )
    )

    fun deviceRecoveryStatus(requestId: String): DeviceRecoveryRequest {
        val encoded = URLEncoder.encode(requestId, Charsets.UTF_8.name()).replace("+", "%20")
        return deviceRecovery(request("/api/device-recovery/request/$encoded"))
    }

    fun bindDevice(token: String) { request("/api/customer/device/bind", "POST", token = token) }

    fun register(name: String, phone: String, password: String) = session(
        request(
            "/api/customer/register",
            "POST",
            body = JSONObject().put("name", name).put("phone", phone).put("password", password)
        ), "customer"
    )

    fun neuralMeshManifest(testToken: String): JSONObject = request(
        "/api/neuralmesh/manifest",
        token = testToken
    )

    fun resellerAccount(token: String): ResellerAccount {
        val me = request("/api/reseller/me", token = token)
        val customersRaw = rawRequest("/api/reseller/customers", token = token).body
        val ordersRaw = rawRequest("/api/reseller/orders", token = token).body
        val customers = JSONArray(customersRaw).objects().map {
            ResellerCustomer(
                it.getString("id"), it.cleanText("account_id"), it.getString("name"), it.getString("phone"),
                it.cleanText("note").orEmpty(), it.optInt("active_subscriptions"), it.optInt("subscription_count"),
                it.optInt("revenue_toman"), it.optInt("profit_toman"), false
            )
        }
        val orders = JSONArray(ordersRaw).objects().map(::resellerOrder)
        val transactions = me.array("transactions").objects().map {
            WalletTransaction(
                it.getString("id"), it.getInt("amount_toman"), it.getInt("balance_after_toman"),
                it.getString("type"), it.optString("note").takeIf(String::isNotBlank), it.getString("created_at")
            )
        }
        val notifications = me.array("notifications").objects().map { CustomerNotification(it.getString("id"),it.getString("title"),it.getString("body"),it.optString("read_at").takeIf(String::isNotBlank),it.getString("created_at")) }
        val debts = me.array("debts").objects().map {
            ResellerDebt(
                id = it.getString("id"),
                customerAccountId = it.getString("customer_account_id"),
                customerName = it.optString("customer_name"),
                customerPhone = it.optString("customer_phone"),
                amountToman = it.optInt("amount_toman"),
                note = it.optString("note"),
                status = it.optString("status"),
                createdAt = it.optString("created_at"),
                paymentReportedAt = it.cleanText("payment_reported_at")
            )
        }
        val walletTransfers = me.array("walletTransfers").objects().map {
            ResellerWalletTransfer(
                id = it.getString("id"),
                customerAccountId = it.getString("customer_account_id"),
                customerName = it.optString("customer_name"),
                customerPhone = it.optString("customer_phone"),
                amountToman = it.optInt("amount_toman"),
                reversedAmountToman = it.optInt("reversed_amount_toman"),
                note = it.optString("note"),
                status = it.optString("status"),
                createdAt = it.optString("created_at")
            )
        }
        return ResellerAccount(
            me.getString("name"), me.getString("phone"), me.getInt("balanceToman"),
            me.optInt("customersCount"), me.optInt("salesCount"), me.optInt("activeSubscriptions"),
            me.optInt("totalRevenueToman"), me.optInt("totalProfitToman"), notifications, transactions,
            debts, walletTransfers, customers, orders
        )
    }

    fun resellerPlans(token: String): List<Plan> {
        val raw = rawRequest("/api/reseller/plans", token = token).body
        return JSONArray(raw).objects().map {
            Plan(
                it.getString("id"), it.getString("name"), it.optString("description"),
                it.getInt("price_toman"), it.getInt("traffic_gb"), it.getInt("duration_days"),
                it.getInt("device_limit"), it.optString("locations").split('،').map(String::trim).filter(String::isNotBlank)
            )
        }
    }

    fun createResellerCustomer(token: String, name: String, phone: String, password: String, note: String) {
        request("/api/reseller/customers", "POST", token, JSONObject().put("name", name).put("phone", phone).put("password",password).put("note", note))
    }
    fun resetResellerCustomerPassword(token: String, customerId: String, password: String) { request("/api/reseller/customers/$customerId/reset-password", "POST", token, JSONObject().put("password",password)) }

    fun resellerCustomerAccess(token: String, customerId: String): ResellerCustomerAccess {
        val encoded = URLEncoder.encode(customerId, Charsets.UTF_8.name()).replace("+", "%20")
        val json = request("/api/reseller/customers/$encoded", token = token)
        return ResellerCustomerAccess(
            customerId = json.getString("id"),
            passwordManaged = json.optInt("password_managed") == 1 || json.optBoolean("password_managed")
        )
    }

    fun resellerCustomerDirectory(token: String, query: String): List<ResellerDirectoryCustomer> {
        val normalized = query.trim()
        if (normalized.length < 3) throw ApiException("SEARCH_QUERY_TOO_SHORT", 400)
        val encoded = URLEncoder.encode(normalized, Charsets.UTF_8.name()).replace("+", "%20")
        val raw = rawRequest("/api/reseller/customer-directory?q=$encoded", token = token).body
        return JSONArray(raw).objects().map {
            ResellerDirectoryCustomer(
                accountId = it.getString("id"),
                name = it.getString("name"),
                phone = it.getString("phone"),
                balanceToman = it.optInt("balance_toman")
            )
        }
    }

    fun creditCustomerWallet(token: String, accountId: String, amountToman: Int, note: String): Int {
        val encoded = URLEncoder.encode(accountId, Charsets.UTF_8.name()).replace("+", "%20")
        val json = request(
            "/api/reseller/customers/$encoded/wallet",
            "POST",
            token,
            JSONObject().put("amountToman", amountToman).put("note", note.trim())
        )
        return json.optInt("balanceToman")
    }

    fun reverseCustomerWalletTransfer(token: String, transferId: String, amountToman: Int?, reason: String) {
        val encoded = URLEncoder.encode(transferId, Charsets.UTF_8.name()).replace("+", "%20")
        val body = JSONObject().put("reason", reason.trim())
        amountToman?.let { body.put("amountToman", it) }
        request("/api/reseller/wallet-transfers/$encoded/reverse", "POST", token, body)
    }

    fun createCustomerDebt(token: String, accountId: String, amountToman: Int, note: String): String {
        val encoded = URLEncoder.encode(accountId, Charsets.UTF_8.name()).replace("+", "%20")
        return request(
            "/api/reseller/customers/$encoded/debts",
            "POST",
            token,
            JSONObject().put("amountToman", amountToman).put("note", note.trim())
        ).getString("id")
    }

    fun controlCustomerDebt(token: String, debtId: String, action: String) {
        require(action == "settle" || action == "cancel")
        val encoded = URLEncoder.encode(debtId, Charsets.UTF_8.name()).replace("+", "%20")
        request("/api/reseller/debts/$encoded/$action", "POST", token, JSONObject())
    }

    fun resellerPurchase(token: String, planId: String, customerId: String, salePriceToman: Int): PurchaseResult {
        val json = request("/api/reseller/purchase", "POST", token, JSONObject().put("planId", planId).put("customerId", customerId).put("salePriceToman", salePriceToman))
        return PurchaseResult(json.optString("subscriptionUrl").takeIf(String::isNotBlank), 0, json.optInt("balanceToman"))
    }

    fun resellerPurchase(token: String, planId: String, target: ResellerSaleTarget, salePriceToman: Int): PurchaseResult {
        val body = JSONObject().put("planId", planId).put("salePriceToman", salePriceToman)
        when {
            !target.customerId.isNullOrBlank() -> body.put("customerId", target.customerId)
            !target.accountId.isNullOrBlank() -> body.put("customerAccountId", target.accountId)
            else -> throw ApiException("CUSTOMER_NOT_FOUND", 400)
        }
        val json = request("/api/reseller/purchase", "POST", token, body)
        return PurchaseResult(json.optString("subscriptionUrl").takeIf(String::isNotBlank), 0, json.optInt("balanceToman"))
    }

    fun resellerRenew(token: String, orderId: String, salePriceToman: Int) {
        request("/api/reseller/orders/$orderId/renew", "POST", token, JSONObject().put("salePriceToman", salePriceToman))
    }
    fun controlResellerSubscription(token:String,orderId:String,action:String,reason:String){request("/api/reseller/orders/$orderId/$action","POST",token,JSONObject().put("reason",reason).put("confirm",action=="delete"))}

    fun requestPasswordReset(phone: String): ResetChallenge { val j=request("/api/customer/password-reset/request", "POST", body=JSONObject().put("phone",phone)); return ResetChallenge(j.optString("resetId"),j.optString("debugCode").takeIf(String::isNotBlank)) }
    fun confirmPasswordReset(phone:String, resetId:String, code:String, newPassword:String) { request("/api/customer/password-reset/confirm","POST",body=JSONObject().put("phone",phone).put("resetId",resetId).put("code",code).put("newPassword",newPassword)) }

    fun purchase(token: String, planId: String, discountCode: String = ""): PurchaseResult {
        val json = request(
            "/api/customer/wallet/purchase",
            "POST",
            token,
            JSONObject().put("planId", planId).put("discountCode", discountCode.trim())
        )
        return PurchaseResult(
            json.optString("subscriptionUrl").takeIf { it.isNotBlank() },
            json.optInt("discountToman"),
            json.optInt("balanceToman").takeIf { json.has("balanceToman") }
        )
    }

    fun validateDiscount(token: String, code: String): DiscountResult {
        val json = request(
            "/api/customer/discount/validate",
            "POST",
            token,
            JSONObject().put("code", code.trim())
        )
        return DiscountResult(json.getString("code"), json.getInt("percent"))
    }

    fun renew(token: String, orderId: String) {
        request("/api/customer/orders/$orderId/renew", "POST", token, JSONObject())
    }

    fun uploadReceipt(token:String, bytes:ByteArray, mimeType:String):String = request("/api/receipts","POST",token,JSONObject().put("mimeType",mimeType).put("data",Base64.encodeToString(bytes,Base64.NO_WRAP))).getString("url")
    fun topup(token: String, amount: Int, reference: String, receiptUrl:String) {
        request(
            "/api/customer/wallet/topups",
            "POST",
            token,
            JSONObject().put("amountToman", amount).put("receiptReference", reference.trim()).put("receiptImageUrl",receiptUrl)
        )
    }

    fun subscription(url: String, token: String? = null): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 6_000
            readTimeout = 8_000
            useCaches = false
            setRequestProperty("Accept", "text/plain")
            if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
            if (deviceId.isNotBlank()) setRequestProperty("X-Nivora-Device", deviceId)
        }
        return try {
            if (connection.responseCode !in 200..299) throw ApiException("SUBSCRIPTION_UNAVAILABLE", connection.responseCode)
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Obtains a credential for this connection only. The caller must not cache
     * the returned URI or pass it through UI state/Intents.
     */
    internal fun connectTicket(
        token: String,
        subscriptionId: String,
        routeId: String = CustomerConnectPolicy.CONNECT_ROUTE_ID
    ): EphemeralConnectTicket {
        val encodedId = URLEncoder.encode(subscriptionId, Charsets.UTF_8.name()).replace("+", "%20")
        val json = request(
            path = "/api/customer/subscriptions/$encodedId/connect-ticket",
            method = "POST",
            token = token,
            body = JSONObject().put("routeId", routeId),
            connectTimeoutMs = 4_500,
            readTimeoutMs = 4_500
        )
        val ticket = EphemeralConnectTicket(
            routeId = json.optString("routeId"),
            uri = json.optString("uri"),
            expiresAtEpochMs = CustomerConnectPolicy.expiryEpochMs(json.opt("expiresAt"))
                ?: throw ApiException("INVALID_SERVER_RESPONSE", 502)
        )
        if (!CustomerConnectPolicy.isUsable(ticket, System.currentTimeMillis())) {
            throw ApiException("INVALID_SERVER_RESPONSE", 502)
        }
        return ticket
    }

    fun cards(): List<PaymentCard> {
        val array = request("/api/store-config").getJSONArray("cards")
        return buildList {
            for (i in 0 until array.length()) array.getJSONObject(i).let {
                add(
                    PaymentCard(
                        it.getString("card_number"),
                        it.getString("card_holder"),
                        it.optString("bank_name").takeIf(String::isNotBlank)
                    )
                )
            }
        }
    }
    fun telegramBotUsername():String=request("/api/store-config").optString("telegramBotUsername")

    fun account(token: String): Account {
        val json = request("/api/customer/me", token = token)
        val subscriptions = json.array("orders").objects().map { order ->
            Subscription(
                id = order.getString("id"),
                planName = order.getString("plan_name"),
                status = order.optString("subscription_status", order.getString("status")),
                url = order.cleanText("subscription_url"),
                usedBytes = order.optLong("usedBytes"),
                totalBytes = order.optLong("totalBytes"),
                remainingBytes = order.optLong("remainingBytes"),
                usagePercent = order.optDouble("usagePercent").takeIf { it.isFinite() } ?: 0.0,
                remainingDays = order.optInt("remainingDays"),
                expiryTime = order.optLong("expiryTime").takeIf { order.has("expiryTime") && !order.isNull("expiryTime") },
                startsOnFirstUse = order.optBoolean("startsOnFirstUse"),
                locationName = order.cleanText("location_name"),
                countryCode = order.cleanText("country_code") ?: inferredCountry(order.cleanText("location_name") ?: order.optString("plan_name")),
                flagEmoji = order.cleanText("flag_emoji"),
                city = order.cleanText("city"),
                routeCount = order.optInt("route_count"),
                trafficGb = order.optInt("traffic_gb"),
                durationDays = order.optInt("duration_days"),
                deviceLimit = order.optInt("device_limit")
            )
        }
        val transactions = json.array("transactions").objects().map {
            WalletTransaction(
                it.getString("id"), it.getInt("amount_toman"), it.getInt("balance_after_toman"),
                it.getString("type"), it.optString("note").takeIf(String::isNotBlank), it.getString("created_at")
            )
        }
        val topups = json.array("topups").objects().map {
            WalletTopup(
                it.getString("id"), it.getInt("amount_toman"),
                it.optString("receipt_reference").takeIf(String::isNotBlank), it.getString("status"),
                it.cleanText("review_note"), it.getString("created_at")
            )
        }
        val notifications = json.array("notifications").objects().map {
            CustomerNotification(
                it.getString("id"), it.getString("title"), it.getString("body"),
                it.optString("read_at").takeIf(String::isNotBlank), it.getString("created_at")
            )
        }
        return Account(
            json.getString("name"), json.getString("phone"), json.getInt("balanceToman"),
            subscriptions, transactions, topups, notifications
        )
    }

    fun plans(): List<Plan> {
        val raw = rawRequest("/api/plans").body
        val array = runCatching { JSONArray(raw) }.getOrElse { throw ApiException("INVALID_SERVER_RESPONSE", 502) }
        return array.objects().map {
            Plan(
                id = it.getString("id"),
                name = it.getString("name"),
                description = it.optString("description").takeIf(String::isNotBlank).orEmpty(),
                priceToman = it.getInt("priceIrr"),
                trafficGb = it.getInt("trafficGb"),
                durationDays = it.getInt("durationDays"),
                deviceLimit = it.getInt("deviceLimit"),
                locations = it.array("locations").objects().mapNotNull { location ->
                    location.optString("name").takeIf(String::isNotBlank)
                }
            )
        }
    }

    fun tickets(token: String, role: String = "customer"): List<SupportTicket> {
        val raw = rawRequest("/api/${if(role=="reseller") "reseller" else "customer"}/tickets", token = token).body
        return runCatching { JSONArray(raw) }.getOrElse { throw ApiException("INVALID_SERVER_RESPONSE", 502) }
            .objects().map {
                SupportTicket(
                    it.getString("id"), it.getString("subject"), it.getString("status"),
                    it.optString("last_message").takeIf(String::isNotBlank), it.getString("updated_at")
                )
            }
    }

    fun createTicket(token: String, subject: String, body: String, role: String = "customer") {
        request(
            "/api/${if(role=="reseller") "reseller" else "customer"}/tickets", "POST", token,
            JSONObject().put("subject", subject.trim()).put("body", body.trim())
        )
    }

    fun ticket(token: String, ticketId: String, role: String = "customer"): TicketConversation {
        val json = request("/api/${if(role=="reseller") "reseller" else "customer"}/tickets/$ticketId", token = token)
        return TicketConversation(
            id = json.getString("id"),
            subject = json.getString("subject"),
            status = json.getString("status"),
            messages = json.array("messages").objects().map {
                TicketMessage(
                    it.getString("id"), it.getString("sender_role"),
                    it.getString("body"), it.getString("created_at")
                )
            }
        )
    }

    fun replyTicket(token: String, ticketId: String, body: String, role: String = "customer") {
        request(
            "/api/${if(role=="reseller") "reseller" else "customer"}/tickets/$ticketId", "POST", token,
            JSONObject().put("body", body.trim())
        )
    }

    fun markNotificationsRead(token: String, role: String = "customer") {
        request("/api/${if(role=="reseller") "reseller" else "customer"}/notifications/read", "POST", token, JSONObject())
    }

    fun changePassword(token: String, currentPassword: String, newPassword: String) {
        request(
            "/api/customer/change-password", "POST", token,
            JSONObject().put("currentPassword", currentPassword).put("newPassword", newPassword)
        )
    }

    fun clearNotifications(token: String, role: String = "customer") {
        request("/api/${if(role=="reseller") "reseller" else "customer"}/notifications", "DELETE", token)
    }

    fun clearTickets(token: String, role: String = "customer") {
        request("/api/${if(role=="reseller") "reseller" else "customer"}/tickets", "DELETE", token)
    }

    private fun resellerOrder(json: JSONObject) = ResellerOrder(
        json.getString("id"), json.getString("plan_id"), json.cleanText("reseller_customer_id"),
        json.optString("customer_name"), json.optString("phone"), json.getString("plan_name"),
        json.optString("order_kind", "purchase"), json.optString("subscription_status", json.optString("status")),
        json.cleanText("control_status") ?: "active",
        json.cleanText("subscription_url"), json.cleanText("location_name"),
        json.optInt("traffic_gb"), json.optInt("duration_days"), json.optInt("remainingDays"),
        json.optInt("reseller_sale_price_toman"), json.getString("created_at")
    )

    private fun session(json: JSONObject, role: String) = Session(
        json.getString("token"),
        json.getJSONObject("account").getString("name"), role
    )

    private fun JSONObject.array(key: String) = optJSONArray(key) ?: JSONArray()
    private fun JSONArray.objects() = buildList {
        for (i in 0 until length()) optJSONObject(i)?.let(::add)
    }
}
