package ir.nivora.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class CustomerDashboardSnapshot(
    val account: Account,
    val plans: List<Plan>,
    val tickets: List<SupportTicket>
)

/**
 * Encrypted last-known dashboard used only for instant first paint. Live data
 * replaces it immediately after launch; subscription credentials never enter
 * plain SharedPreferences.
 */
class DashboardSnapshotStore(context: Context) {
    private val preferences = context.getSharedPreferences("dashboard_snapshot_v1", Context.MODE_PRIVATE)
    private val alias = "nivora_dashboard_snapshot_key_v1"

    fun readCustomer(sessionToken: String): CustomerDashboardSnapshot? {
        val storageKey = tokenKey(sessionToken)
        val encoded = preferences.getString(storageKey, null) ?: return null
        if (System.currentTimeMillis() - preferences.getLong("${storageKey}_updated", 0L) > MAX_AGE_MS) return null
        return runCatching {
            val payload = Base64.decode(encoded, Base64.NO_WRAP)
            require(payload.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.copyOfRange(0, 12)))
            val raw = String(cipher.doFinal(payload.copyOfRange(12, payload.size)), Charsets.UTF_8)
            require(raw.length <= MAX_CHARS)
            decode(JSONObject(raw))
        }.getOrNull()
    }

    fun saveCustomer(sessionToken: String, snapshot: CustomerDashboardSnapshot) {
        val raw = encode(snapshot).toString()
        if (raw.length > MAX_CHARS) return
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(raw.toByteArray(Charsets.UTF_8))
        val storageKey = tokenKey(sessionToken)
        preferences.edit()
            .putString(storageKey, Base64.encodeToString(payload, Base64.NO_WRAP))
            .putLong("${storageKey}_updated", System.currentTimeMillis())
            .apply()
    }

    fun clear() = preferences.edit().clear().apply()

    private fun encode(snapshot: CustomerDashboardSnapshot) = JSONObject()
        .put("account", accountJson(snapshot.account))
        .put("plans", JSONArray().apply { snapshot.plans.forEach { put(planJson(it)) } })
        .put("tickets", JSONArray().apply { snapshot.tickets.forEach { put(ticketJson(it)) } })

    private fun decode(root: JSONObject): CustomerDashboardSnapshot {
        val account = root.getJSONObject("account")
        return CustomerDashboardSnapshot(
            account = Account(
                name = account.getString("name"),
                phone = account.getString("phone"),
                balanceToman = account.getInt("balanceToman"),
                subscriptions = account.getJSONArray("subscriptions").objects(::subscription),
                transactions = account.optJSONArray("transactions").objects(::transaction),
                topups = account.optJSONArray("topups").objects(::topup),
                notifications = account.optJSONArray("notifications").objects(::notification)
            ),
            plans = root.optJSONArray("plans").objects(::plan),
            tickets = root.optJSONArray("tickets").objects(::ticket)
        )
    }

    private fun accountJson(account: Account) = JSONObject()
        .put("name", account.name)
        .put("phone", account.phone)
        .put("balanceToman", account.balanceToman)
        .put("subscriptions", JSONArray().apply { account.subscriptions.forEach { put(subscriptionJson(it)) } })
        .put("transactions", JSONArray().apply { account.transactions.forEach { put(transactionJson(it)) } })
        .put("topups", JSONArray().apply { account.topups.forEach { put(topupJson(it)) } })
        .put("notifications", JSONArray().apply { account.notifications.forEach { put(notificationJson(it)) } })

    private fun subscriptionJson(value: Subscription) = JSONObject()
        .put("id", value.id).put("planName", value.planName).put("status", value.status)
        .putNullable("url", value.url).put("usedBytes", value.usedBytes).put("totalBytes", value.totalBytes)
        .put("remainingBytes", value.remainingBytes).put("usagePercent", value.usagePercent)
        .put("remainingDays", value.remainingDays).putNullable("expiryTime", value.expiryTime)
        .put("startsOnFirstUse", value.startsOnFirstUse).putNullable("locationName", value.locationName)
        .putNullable("countryCode", value.countryCode).putNullable("flagEmoji", value.flagEmoji)
        .putNullable("city", value.city).put("routeCount", value.routeCount).put("trafficGb", value.trafficGb)
        .put("durationDays", value.durationDays).put("deviceLimit", value.deviceLimit)

    private fun subscription(json: JSONObject) = Subscription(
        json.getString("id"), json.getString("planName"), json.getString("status"), json.textOrNull("url"),
        json.optLong("usedBytes"), json.optLong("totalBytes"), json.optLong("remainingBytes"),
        json.optDouble("usagePercent"), json.optInt("remainingDays"), json.longOrNull("expiryTime"),
        json.optBoolean("startsOnFirstUse"), json.textOrNull("locationName"), json.textOrNull("countryCode"),
        json.textOrNull("flagEmoji"), json.textOrNull("city"), json.optInt("routeCount"),
        json.optInt("trafficGb"), json.optInt("durationDays"), json.optInt("deviceLimit")
    )

    private fun planJson(value: Plan) = JSONObject()
        .put("id", value.id).put("name", value.name).put("description", value.description)
        .put("priceToman", value.priceToman).put("trafficGb", value.trafficGb)
        .put("durationDays", value.durationDays).put("deviceLimit", value.deviceLimit)
        .put("locations", JSONArray(value.locations))

    private fun plan(json: JSONObject) = Plan(
        json.getString("id"), json.getString("name"), json.optString("description"),
        json.optInt("priceToman"), json.optInt("trafficGb"), json.optInt("durationDays"),
        json.optInt("deviceLimit"), json.optJSONArray("locations").strings()
    )

    private fun ticketJson(value: SupportTicket) = JSONObject()
        .put("id", value.id).put("subject", value.subject).put("status", value.status)
        .putNullable("lastMessage", value.lastMessage).put("updatedAt", value.updatedAt)

    private fun ticket(json: JSONObject) = SupportTicket(
        json.getString("id"), json.getString("subject"), json.getString("status"),
        json.textOrNull("lastMessage"), json.getString("updatedAt")
    )

    private fun transactionJson(value: WalletTransaction) = JSONObject()
        .put("id", value.id).put("amountToman", value.amountToman).put("balanceAfterToman", value.balanceAfterToman)
        .put("type", value.type).putNullable("note", value.note).put("createdAt", value.createdAt)

    private fun transaction(json: JSONObject) = WalletTransaction(
        json.getString("id"), json.optInt("amountToman"), json.optInt("balanceAfterToman"),
        json.getString("type"), json.textOrNull("note"), json.getString("createdAt")
    )

    private fun topupJson(value: WalletTopup) = JSONObject()
        .put("id", value.id).put("amountToman", value.amountToman).putNullable("reference", value.reference)
        .put("status", value.status).putNullable("reviewNote", value.reviewNote).put("createdAt", value.createdAt)

    private fun topup(json: JSONObject) = WalletTopup(
        json.getString("id"), json.optInt("amountToman"), json.textOrNull("reference"),
        json.getString("status"), json.textOrNull("reviewNote"), json.getString("createdAt")
    )

    private fun notificationJson(value: CustomerNotification) = JSONObject()
        .put("id", value.id).put("title", value.title).put("body", value.body)
        .putNullable("readAt", value.readAt).put("createdAt", value.createdAt)

    private fun notification(json: JSONObject) = CustomerNotification(
        json.getString("id"), json.getString("title"), json.getString("body"),
        json.textOrNull("readAt"), json.getString("createdAt")
    )

    private fun tokenKey(token: String): String = MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            generateKey()
        }
    }

    private fun JSONObject.putNullable(name: String, value: Any?) = put(name, value ?: JSONObject.NULL)
    private fun JSONObject.textOrNull(name: String) = optString(name).takeUnless { isNull(name) || it.isBlank() }
    private fun JSONObject.longOrNull(name: String) = if (has(name) && !isNull(name)) optLong(name) else null
    private fun <T> JSONArray?.objects(mapper: (JSONObject) -> T): List<T> =
        if (this == null) emptyList() else (0 until length()).map { mapper(getJSONObject(it)) }

    private fun JSONArray?.strings(): List<String> =
        if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }

    private companion object {
        const val MAX_CHARS = 2_000_000
        const val MAX_AGE_MS = 30L * 24 * 60 * 60 * 1_000
    }
}
