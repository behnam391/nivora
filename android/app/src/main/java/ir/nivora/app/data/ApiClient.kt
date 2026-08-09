package ir.nivora.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiClient(private val baseUrl: String) {
    private fun request(path: String, method: String = "GET", token: String? = null, body: JSONObject? = null): JSONObject {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12_000
            readTimeout = 18_000
            setRequestProperty("Accept", "application/json")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray()) }
            }
        }
        val raw = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream)
            .bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        if (connection.responseCode !in 200..299) throw IllegalStateException(json.optString("error", "خطای سرور"))
        return json
    }

    fun login(phone: String, password: String) = session(request("/api/customer/login", "POST", body = JSONObject().put("phone", phone).put("password", password)))
    fun register(name: String, phone: String, password: String) = session(request("/api/customer/register", "POST", body = JSONObject().put("name", name).put("phone", phone).put("password", password)))
    fun requestPasswordReset(phone: String) { request("/api/customer/password-reset-requests", "POST", body = JSONObject().put("phone", phone)) }
    fun purchase(token: String, planId: String): String? = request("/api/customer/wallet/purchase", "POST", token, JSONObject().put("planId", planId)).optString("subscriptionUrl").takeIf { it.isNotBlank() }
    fun renew(token:String, orderId:String) { request("/api/customer/orders/$orderId/renew", "POST", token, JSONObject()) }
    fun topup(token:String, amount:Int, reference:String) { request("/api/customer/wallet/topups", "POST", token, JSONObject().put("amountToman",amount).put("receiptReference",reference)) }
    fun subscription(url:String):String { val c=(URL(url).openConnection() as HttpURLConnection).apply{connectTimeout=12000;readTimeout=18000}; if(c.responseCode !in 200..299) throw IllegalStateException("SUBSCRIPTION_UNAVAILABLE"); return c.inputStream.bufferedReader().use{it.readText()} }
    fun cards():List<PaymentCard>{val j=request("/api/store-config");val a=j.getJSONArray("cards");return buildList{for(i in 0 until a.length())a.getJSONObject(i).let{add(PaymentCard(it.getString("card_number"),it.getString("card_holder"),it.optString("bank_name").takeIf(String::isNotBlank)))}}}

    fun account(token: String): Account {
        val json = request("/api/customer/me", token = token)
        val subscriptions = buildList {
            val orders = json.getJSONArray("orders")
            for (i in 0 until orders.length()) {
                val order = orders.getJSONObject(i)
                add(Subscription(order.getString("id"),order.getString("plan_name"),order.optString("subscription_status",order.getString("status")),order.optString("subscription_url").takeIf{it.isNotBlank()},order.optLong("usedBytes"),order.optLong("totalBytes"),order.optLong("remainingBytes"),order.optDouble("usagePercent"),order.optInt("remainingDays"),order.optLong("expiryTime").takeIf{!order.isNull("expiryTime")},order.optBoolean("startsOnFirstUse"),order.optString("location_name").takeIf{it.isNotBlank()}))
            }
        }
        return Account(json.getString("name"), json.getString("phone"), json.getInt("balanceToman"), subscriptions)
    }

    fun plans(): List<Plan> {
        val connection = (URL(baseUrl.trimEnd('/') + "/api/plans").openConnection() as HttpURLConnection).apply { connectTimeout = 12_000; readTimeout = 18_000 }
        val array = JSONArray(connection.inputStream.bufferedReader().use { it.readText() })
        return buildList { for (i in 0 until array.length()) array.getJSONObject(i).let { add(Plan(it.getString("id"), it.getString("name"), it.getInt("priceIrr"), it.getInt("trafficGb"), it.getInt("durationDays"), it.getInt("deviceLimit"))) } }
    }

    private fun session(json: JSONObject) = Session(json.getString("token"), json.getJSONObject("account").getString("name"))
}
