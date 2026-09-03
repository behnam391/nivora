package ir.nivora.app.data

import android.content.Context
import org.json.JSONObject
import java.security.MessageDigest

data class RememberedRoute(val winner: String, val backup: String?, val updatedAt: Long)

class SmartRouteMemory(context: Context) {
    private val preferences = context.getSharedPreferences("smart_routes_v1", Context.MODE_PRIVATE)

    fun read(networkKey: String, maxAgeMs: Long = 60 * 60 * 1000L): RememberedRoute? {
        val winner = preferences.getString("${networkKey}_winner", null) ?: return null
        val route = RememberedRoute(
            winner,
            preferences.getString("${networkKey}_backup", null),
            preferences.getLong("${networkKey}_updated", 0L)
        )
        return route.takeIf { it.updatedAt > 0L && System.currentTimeMillis() - it.updatedAt <= maxAgeMs }
    }

    fun promote(networkKey: String, winner: String, previousWinner: String?) {
        preferences.edit()
            .putString("${networkKey}_winner", winner)
            .apply {
                if (!previousWinner.isNullOrBlank() && previousWinner != winner) {
                    putString("${networkKey}_backup", previousWinner)
                }
            }
            .putLong("${networkKey}_updated", System.currentTimeMillis())
            .apply()
    }

    fun save(networkKey: String, winner: String, backup: String?) {
        preferences.edit()
            .putString("${networkKey}_winner", winner)
            .apply { if (backup == null) remove("${networkKey}_backup") else putString("${networkKey}_backup", backup) }
            .putLong("${networkKey}_updated", System.currentTimeMillis())
            .apply()
    }

    companion object {
        fun signature(outbound: JSONObject): String {
            val stream = outbound.optJSONObject("streamSettings")
            val endpoint = endpoint(outbound)
            val material = listOf(
                outbound.optString("protocol"), endpoint.first, endpoint.second.toString(),
                stream?.optString("network").orEmpty(), stream?.optString("security").orEmpty(),
                stream?.optJSONObject("tlsSettings")?.optString("serverName").orEmpty(),
                stream?.optJSONObject("realitySettings")?.optString("serverName").orEmpty(),
                stream?.optJSONObject("xhttpSettings")?.optString("path").orEmpty(),
                stream?.optJSONObject("wsSettings")?.optString("path").orEmpty(),
                stream?.optJSONObject("grpcSettings")?.optString("serviceName").orEmpty()
            ).joinToString("|")
            return MessageDigest.getInstance("SHA-256").digest(material.toByteArray())
                .take(12).joinToString("") { "%02x".format(it) }
        }

        fun label(outbound: JSONObject): String {
            val stream = outbound.optJSONObject("streamSettings")
            val transport = stream?.optString("network").orEmpty().ifBlank { "tcp" }.uppercase()
            val security = stream?.optString("security").orEmpty()
            val securityLabel = when {
                security.equals("reality", true) -> "Reality"
                security.equals("tls", true) -> "TLS"
                else -> "Direct"
            }
            return "$transport · $securityLabel"
        }

        private fun endpoint(outbound: JSONObject): Pair<String, Int> {
            val settings = outbound.optJSONObject("settings") ?: return "" to 0
            val flatAddress = settings.optString("address").ifBlank { settings.optString("server") }
            val flatPort = settings.optInt("port")
            if (flatAddress.isNotBlank() && flatPort > 0) return flatAddress to flatPort
            for (key in listOf("vnext", "servers")) {
                val server = settings.optJSONArray(key)?.optJSONObject(0) ?: continue
                return server.optString("address").ifBlank { server.optString("server") } to server.optInt("port")
            }
            return "" to 0
        }
    }
}
