package ir.nivora.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiClient(private val baseUrl: String) {
    private data class RawResponse(val status: Int, val body: String)

    private fun rawRequest(
        path: String,
        method: String = "GET",
        token: String? = null,
        body: JSONObject? = null
    ): RawResponse {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12_000
            readTimeout = 20_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Accept-Language", "fa-IR")
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
        body: JSONObject? = null
    ): JSONObject {
        val raw = rawRequest(path, method, token, body).body
        return runCatching { JSONObject(raw) }.getOrElse { throw ApiException("INVALID_SERVER_RESPONSE", 502) }
    }

    fun login(phone: String, password: String, role: String) = session(
        request(if (role == "reseller") "/api/reseller/login" else "/api/customer/login", "POST", body = JSONObject().put("phone", phone).put("password", password)), role
    )

    fun register(name: String, phone: String, password: String) = session(
        request(
            "/api/customer/register",
            "POST",
            body = JSONObject().put("name", name).put("phone", phone).put("password", password)
        ), "customer"
    )

    fun resellerAccount(token: String): ResellerAccount {
        val me = request("/api/reseller/me", token = token)
        val customersRaw = rawRequest("/api/reseller/customers", token = token).body
        val ordersRaw = rawRequest("/api/reseller/orders", token = token).body
        val customers = JSONArray(customersRaw).objects().map {
            ResellerCustomer(
                it.getString("id"), it.getString("name"), it.getString("phone"),
                it.optString("note"), it.optInt("active_subscriptions"), it.optInt("subscription_count"),
                it.optInt("revenue_toman"), it.optInt("profit_toman")
            )
        }
        val orders = JSONArray(ordersRaw).objects().map(::resellerOrder)
        val transactions = me.array("transactions").objects().map {
            WalletTransaction(
                it.getString("id"), it.getInt("amount_toman"), it.getInt("balance_after_toman"),
                it.getString("type"), it.optString("note").takeIf(String::isNotBlank), it.getString("created_at")
            )
        }
        return ResellerAccount(
            me.getString("name"), me.getString("phone"), me.getInt("balanceToman"),
            me.optInt("customersCount"), me.optInt("salesCount"), me.optInt("activeSubscriptions"),
            me.optInt("totalRevenueToman"), me.optInt("totalProfitToman"), transactions, customers, orders
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

    fun createResellerCustomer(token: String, name: String, phone: String, note: String) {
        request("/api/reseller/customers", "POST", token, JSONObject().put("name", name).put("phone", phone).put("note", note))
    }

    fun resellerPurchase(token: String, planId: String, customerId: String, salePriceToman: Int): PurchaseResult {
        val json = request("/api/reseller/purchase", "POST", token, JSONObject().put("planId", planId).put("customerId", customerId).put("salePriceToman", salePriceToman))
        return PurchaseResult(json.optString("subscriptionUrl").takeIf(String::isNotBlank), 0, json.optInt("balanceToman"))
    }

    fun resellerRenew(token: String, orderId: String, salePriceToman: Int) {
        request("/api/reseller/orders/$orderId/renew", "POST", token, JSONObject().put("salePriceToman", salePriceToman))
    }

    fun requestPasswordReset(phone: String) {
        request("/api/customer/password-reset-requests", "POST", body = JSONObject().put("phone", phone))
    }

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

    fun topup(token: String, amount: Int, reference: String) {
        request(
            "/api/customer/wallet/topups",
            "POST",
            token,
            JSONObject().put("amountToman", amount).put("receiptReference", reference.trim())
        )
    }

    fun subscription(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000
            readTimeout = 20_000
            useCaches = false
        }
        return try {
            if (connection.responseCode !in 200..299) throw ApiException("SUBSCRIPTION_UNAVAILABLE", connection.responseCode)
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
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

    fun account(token: String): Account {
        val json = request("/api/customer/me", token = token)
        val subscriptions = json.array("orders").objects().map { order ->
            Subscription(
                id = order.getString("id"),
                planName = order.getString("plan_name"),
                status = order.optString("subscription_status", order.getString("status")),
                url = order.optString("subscription_url").takeIf(String::isNotBlank),
                usedBytes = order.optLong("usedBytes"),
                totalBytes = order.optLong("totalBytes"),
                remainingBytes = order.optLong("remainingBytes"),
                usagePercent = order.optDouble("usagePercent").takeIf { it.isFinite() } ?: 0.0,
                remainingDays = order.optInt("remainingDays"),
                expiryTime = order.optLong("expiryTime").takeIf { order.has("expiryTime") && !order.isNull("expiryTime") },
                startsOnFirstUse = order.optBoolean("startsOnFirstUse"),
                locationName = order.optString("location_name").takeIf(String::isNotBlank),
                countryCode = order.optString("country_code").takeIf(String::isNotBlank),
                city = order.optString("city").takeIf(String::isNotBlank),
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
                it.optString("review_note").takeIf(String::isNotBlank), it.getString("created_at")
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

    fun tickets(token: String): List<SupportTicket> {
        val raw = rawRequest("/api/customer/tickets", token = token).body
        return runCatching { JSONArray(raw) }.getOrElse { throw ApiException("INVALID_SERVER_RESPONSE", 502) }
            .objects().map {
                SupportTicket(
                    it.getString("id"), it.getString("subject"), it.getString("status"),
                    it.optString("last_message").takeIf(String::isNotBlank), it.getString("updated_at")
                )
            }
    }

    fun createTicket(token: String, subject: String, body: String) {
        request(
            "/api/customer/tickets", "POST", token,
            JSONObject().put("subject", subject.trim()).put("body", body.trim())
        )
    }

    fun ticket(token: String, ticketId: String): TicketConversation {
        val json = request("/api/customer/tickets/$ticketId", token = token)
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

    fun replyTicket(token: String, ticketId: String, body: String) {
        request(
            "/api/customer/tickets/$ticketId", "POST", token,
            JSONObject().put("body", body.trim())
        )
    }

    fun markNotificationsRead(token: String) {
        request("/api/customer/notifications/read", "POST", token, JSONObject())
    }

    private fun resellerOrder(json: JSONObject) = ResellerOrder(
        json.getString("id"), json.getString("plan_id"), json.optString("reseller_customer_id").takeIf(String::isNotBlank),
        json.optString("customer_name"), json.optString("phone"), json.getString("plan_name"),
        json.optString("order_kind", "purchase"), json.optString("subscription_status", json.optString("status")),
        json.optString("subscription_url").takeIf(String::isNotBlank), json.optString("location_name").takeIf(String::isNotBlank),
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
