package ir.nivora.app.data

import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.util.Base64

data class ServiceEndpoint(val host: String, val port: Int)

object NetworkTools {
    fun endpointFromSubscription(raw: String): ServiceEndpoint? {
        val text = decodeSubscription(raw)
        return text.lineSequence().map(String::trim).filter(String::isNotBlank).firstNotNullOfOrNull(::endpointFromLink)
    }

    fun measure(endpoint: ServiceEndpoint, attempts: Int = 3): Long {
        val samples = buildList {
            repeat(attempts.coerceIn(1, 5)) {
                val started = System.nanoTime()
                Socket().use { socket ->
                    socket.tcpNoDelay = true
                    socket.connect(InetSocketAddress(endpoint.host, endpoint.port), 6_000)
                }
                add((System.nanoTime() - started) / 1_000_000)
            }
        }.sorted()
        return samples[samples.size / 2]
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
