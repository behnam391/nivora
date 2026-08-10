package ir.nivora.app.data

import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

data class ServiceEndpoint(val host: String, val port: Int, val serverName: String? = null, val tls: Boolean = false)
data class EndpointMeasurement(val endpoint: ServiceEndpoint, val latencyMs: Long)

object NetworkTools {
    fun endpointFromSubscription(raw: String): ServiceEndpoint? = endpointsFromSubscription(raw).firstOrNull()

    fun endpointsFromSubscription(raw: String): List<ServiceEndpoint> = decodeSubscription(raw)
        .lineSequence().map(String::trim).filter(String::isNotBlank)
        .mapNotNull(::endpointFromLink).distinct().toList()

    fun measure(endpoint: ServiceEndpoint, attempts: Int = 3, timeoutMs: Int = 6_000): Long {
        val samples = buildList {
            repeat(attempts.coerceIn(1, 5)) {
                val started = System.nanoTime()
                Socket().use { socket ->
                    socket.tcpNoDelay = true
                    socket.connect(InetSocketAddress(endpoint.host, endpoint.port), timeoutMs.coerceIn(500, 10_000))
                    if (endpoint.tls && !endpoint.serverName.isNullOrBlank()) verifyTlsRoute(socket, endpoint, timeoutMs)
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
            unique.map { endpoint -> executor.submit<EndpointMeasurement?> {
                runCatching { EndpointMeasurement(endpoint, measure(endpoint, attempts = 1, timeoutMs = timeoutMs)) }.getOrNull()
            } }.mapNotNull { future -> runCatching { future.get((timeoutMs + 1_000).toLong(), TimeUnit.MILLISECONDS) }.getOrNull() }
                .minByOrNull(EndpointMeasurement::latencyMs)
        } finally { executor.shutdownNow() }
    }

    private fun verifyTlsRoute(socket: Socket, endpoint: ServiceEndpoint, timeoutMs: Int) {
        val serverName = endpoint.serverName ?: return
        val secure = (SSLSocketFactory.getDefault() as SSLSocketFactory)
            .createSocket(socket, serverName, endpoint.port, false) as SSLSocket
        secure.soTimeout = timeoutMs.coerceIn(500, 10_000)
        secure.sslParameters = secure.sslParameters.apply {
            serverNames = listOf(SNIHostName(serverName))
            endpointIdentificationAlgorithm = "HTTPS"
        }
        secure.use {
            it.startHandshake()
            it.outputStream.write("HEAD / HTTP/1.1\r\nHost: $serverName\r\nConnection: close\r\n\r\n".toByteArray())
            it.outputStream.flush()
            if (it.inputStream.read() < 0) error("TLS_ROUTE_NO_RESPONSE")
        }
    }

    private fun decodeSubscription(raw: String): String {
        val trimmed = raw.trim()
        if (trimmed.contains("://")) return trimmed
        return runCatching { String(Base64.getMimeDecoder().decode(trimmed), Charsets.UTF_8).takeIf { it.contains("://") } }.getOrNull() ?: trimmed
    }

    private fun endpointFromLink(link: String): ServiceEndpoint? = runCatching {
        when {
            link.startsWith("vmess://", ignoreCase = true) -> {
                val json = JSONObject(String(Base64.getMimeDecoder().decode(link.substringAfter("://")), Charsets.UTF_8))
                val tls = json.optString("tls").equals("tls", ignoreCase = true)
                val serverName = json.optString("sni").ifBlank { json.optString("host") }.ifBlank { null }
                ServiceEndpoint(json.getString("add"), json.get("port").toString().toInt(), serverName, tls)
            }
            else -> {
                val uri = URI(link)
                val port = if (uri.port > 0) uri.port else when (uri.scheme?.lowercase()) { "https", "vless", "trojan" -> 443 else -> return null }
                val params = uri.rawQuery.orEmpty().split('&').associate { part ->
                    val pair = part.split('=', limit = 2); pair[0] to (pair.getOrNull(1)?.let(::decode) ?: "")
                }
                val tls = params["security"]?.equals("tls", ignoreCase = true) == true
                val serverName = params["sni"].orEmpty().ifBlank { params["host"].orEmpty() }.ifBlank { null }
                uri.host?.takeIf(String::isNotBlank)?.let { ServiceEndpoint(it, port, serverName, tls) }
            }
        }
    }.getOrNull()

    private fun decode(value: String) = runCatching { java.net.URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrDefault(value)
}
