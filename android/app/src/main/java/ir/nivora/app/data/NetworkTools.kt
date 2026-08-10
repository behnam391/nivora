package ir.nivora.app.data

import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class ServiceEndpoint(val host: String, val port: Int)
data class EndpointMeasurement(val endpoint: ServiceEndpoint, val latencyMs: Long)

object NetworkTools {
    fun endpointFromSubscription(raw: String): ServiceEndpoint? {
        return endpointsFromSubscription(raw).firstOrNull()
    }

    fun endpointsFromSubscription(raw: String): List<ServiceEndpoint> {
        val text = decodeSubscription(raw)
        return text.lineSequence().map(String::trim).filter(String::isNotBlank)
            .mapNotNull(::endpointFromLink).distinct().toList()
    }

    fun measure(endpoint: ServiceEndpoint, attempts: Int = 3, timeoutMs: Int = 6_000): Long {
        val samples = buildList {
            repeat(attempts.coerceIn(1, 5)) {
                val started = System.nanoTime()
                Socket().use { socket ->
                    socket.tcpNoDelay = true
                    socket.connect(InetSocketAddress(endpoint.host, endpoint.port), timeoutMs.coerceIn(500, 10_000))
                }
                add((System.nanoTime() - started) / 1_000_000)
            }
        }.sorted()
        return samples[samples.size / 2]
    }

    fun fastest(endpoints: List<ServiceEndpoint>, timeoutMs: Int = 3_000): EndpointMeasurement? {
        val unique = endpoints.distinct().take(12)
        if (unique.isEmpty()) return null
        val executor = Executors.newFixedThreadPool(unique.size.coerceAtMost(4))
        return try {
            unique.map { endpoint ->
                executor.submit<EndpointMeasurement?> {
                    runCatching { EndpointMeasurement(endpoint, measure(endpoint, attempts = 1, timeoutMs = timeoutMs)) }.getOrNull()
                }
            }.mapNotNull { future -> runCatching { future.get((timeoutMs + 750).toLong(), TimeUnit.MILLISECONDS) }.getOrNull() }
                .minByOrNull(EndpointMeasurement::latencyMs)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun decodeSubscription(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.contains("://")) return trimmed
        return runCatching {
            String(Base64.getMimeDecoder().decode(trimmed), Charsets.UTF_8).takeIf { it.contains("://") }
        }.getOrNull() ?: trimmed
    }

    private fun endpointFromLink(link: String): ServiceEndpoint? = runCatching {
        when {
            link.startsWith("vmess://", ignoreCase = true) -> {
                val json = JSONObject(String(Base64.getMimeDecoder().decode(link.substringAfter("://")), Charsets.UTF_8))
                ServiceEndpoint(json.getString("add"), json.get("port").toString().toInt())
            }
            else -> {
                val uri = URI(link)
                val port = if (uri.port > 0) uri.port else when (uri.scheme?.lowercase()) {
                    "https", "vless", "trojan" -> 443
                    else -> return null
                }
                uri.host?.takeIf(String::isNotBlank)?.let { ServiceEndpoint(it, port) }
            }
        }
    }.getOrNull()
}
