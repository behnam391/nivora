package ir.nivora.app.data

/** Only first-party origins, and only replay-safe requests, may fail over. */
object ApiRoutePolicy {
    fun origins(baseUrl: String): List<String> = when (baseUrl.trimEnd('/')) {
        "https://api.nivorali.com" -> listOf("https://api.nivorali.com", "https://b.nivorali.com")
        "https://b.nivorali.com" -> listOf("https://b.nivorali.com", "https://api.nivorali.com")
        else -> listOf(baseUrl.trimEnd('/'))
    }

    fun canRetry(path: String, method: String): Boolean = method == "GET" ||
        (method == "POST" && path in setOf("/api/customer/connection-ready", "/api/customer/device/bind"))
}
