package ir.nivora.app.data

import java.util.Base64

internal object SubscriptionBundleFormat {
    private const val LIMIT=2_000_000
    private val route=Regex("^(vless|vmess|trojan|ss|ssr|socks|socks5|hysteria|hysteria2|hy2|tuic|wireguard)://",RegexOption.IGNORE_CASE)
    fun normalize(raw:String):String? {
        if(raw.length !in 1..LIMIT)return null
        val trimmed=raw.trim()
        val decoded=if(route.containsMatchIn(trimmed))trimmed else {
            val compact=trimmed.replace(Regex("\\s+"),"")
            sequenceOf(Base64.getDecoder(),Base64.getUrlDecoder()).mapNotNull { decoder ->
                runCatching { String(decoder.decode(compact),Charsets.UTF_8).trim() }.getOrNull()
            }.firstOrNull { route.containsMatchIn(it) }?:return null
        }
        val lines=decoded.lineSequence().map(String::trim).filter(String::isNotBlank).toList()
        return lines.takeIf { it.isNotEmpty() && it.all(route::containsMatchIn) }?.joinToString("\n")
    }
}
