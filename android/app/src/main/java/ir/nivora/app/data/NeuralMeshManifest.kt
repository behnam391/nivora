package ir.nivora.app.data

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import kotlin.math.max

data class NeuralMeshProfile(
    val id: String,
    val name: String,
    val transport: String,
    val uri: String
)

data class NeuralMeshMeasurementPolicy(
    val rounds: Int,
    val downloadBytes: Int,
    val estimatedTotalBytes: Int,
    val http204Url: String,
    val downloadUrl: String,
    val instagramUrl: String,
    val youtube204Url: String,
    val connectTimeoutMs: Int,
    val requestTimeoutMs: Int
)

data class NeuralMeshScoringPolicy(
    val minimumSuccessfulRounds: Int,
    val tunnelWeight: Double,
    val http204Weight: Double,
    val instagramWeight: Double,
    val youtubeWeight: Double,
    val downloadWeight: Double,
    val resetPenalty: Double,
    val timeoutPenalty: Double,
    val disconnectPenalty: Double
)

data class NeuralMeshManifest(
    val version: Int,
    val issuedAt: String,
    val expiresAt: String,
    val profiles: List<NeuralMeshProfile>,
    val measurement: NeuralMeshMeasurementPolicy,
    val scoring: NeuralMeshScoringPolicy
)

data class NeuralMeshRound(
    val profileId: String,
    val round: Int,
    val connected: Boolean,
    val tunnelConnectMs: Long?,
    val http204Ms: Long?,
    val instagramTtfbMs: Long?,
    val youtube204Ms: Long?,
    val downloadMs: Long?,
    val downloadMbps: Double?,
    val resets: Int,
    val timeouts: Int,
    val disconnects: Int,
    val error: String? = null
)

data class NeuralMeshResult(
    val profile: NeuralMeshProfile,
    val rounds: List<NeuralMeshRound>,
    val score: Double?,
    val accepted: Boolean
)

object NeuralMeshManifestVerifier {
    fun verify(envelope: JSONObject, publicKeySpkiBase64: String, nowMs: Long = System.currentTimeMillis()): NeuralMeshManifest {
        require(envelope.optString("algorithm") == "Ed25519") { "MANIFEST_ALGORITHM" }
        require(publicKeySpkiBase64.isNotBlank()) { "MANIFEST_PUBLIC_KEY" }
        val payload = decodeUrl(envelope.getString("payload"))
        val signatureBytes = decodeUrl(envelope.getString("signature"))
        val publicKey = KeyFactory.getInstance("Ed25519").generatePublic(
            X509EncodedKeySpec(Base64.decode(publicKeySpkiBase64, Base64.DEFAULT))
        )
        val signature = Signature.getInstance("Ed25519").apply {
            initVerify(publicKey)
            update(payload)
        }
        require(signature.verify(signatureBytes)) { "MANIFEST_BAD_SIGNATURE" }
        val json = JSONObject(String(payload, Charsets.UTF_8))
        require(json.optInt("version") >= 1) { "MANIFEST_VERSION" }
        val expiresAt = json.getString("expiresAt")
        require(java.time.Instant.parse(expiresAt).toEpochMilli() > nowMs) { "MANIFEST_EXPIRED" }
        val profilesJson = json.getJSONArray("profiles")
        require(profilesJson.length() in 3..8) { "MANIFEST_PROFILE_COUNT" }
        val profiles = buildList {
            for (index in 0 until profilesJson.length()) profilesJson.getJSONObject(index).let { profile ->
                val uri = profile.getString("uri")
                require(uri.startsWith("vless://")) { "MANIFEST_PROFILE_URI" }
                add(NeuralMeshProfile(profile.getString("id"), profile.getString("name"), profile.getString("transport"), uri))
            }
        }
        require(profiles.map(NeuralMeshProfile::id).distinct().size == profiles.size) { "MANIFEST_PROFILE_ID" }
        val measurement = json.getJSONObject("measurement")
        val scoring = json.getJSONObject("scoring")
        val weights = scoring.getJSONObject("weights")
        return NeuralMeshManifest(
            json.getInt("version"), json.getString("issuedAt"), expiresAt, profiles,
            NeuralMeshMeasurementPolicy(
                measurement.getInt("rounds").coerceIn(1, 10),
                measurement.getInt("downloadBytes").coerceIn(0, 20_000_000),
                measurement.optInt("estimatedTotalBytes", measurement.getInt("downloadBytes") * profiles.size * measurement.getInt("rounds")),
                fixedHttps(measurement.getString("http204Url")),
                fixedHttps(measurement.getString("downloadUrl")),
                fixedHttps(measurement.getString("instagramUrl")),
                fixedHttps(measurement.getString("youtube204Url")),
                measurement.optInt("connectTimeoutMs", 20_000).coerceIn(5_000, 60_000),
                measurement.optInt("requestTimeoutMs", 20_000).coerceIn(5_000, 60_000)
            ),
            NeuralMeshScoringPolicy(
                scoring.optInt("minimumSuccessfulRounds", 2).coerceIn(1, 3),
                weights.optDouble("tunnelConnect", .25),
                weights.optDouble("http204", .20),
                weights.optDouble("instagramTtfb", .20),
                weights.optDouble("youtube204", .15),
                weights.optDouble("download", .20),
                scoring.optDouble("resetPenalty", 20_000.0),
                scoring.optDouble("timeoutPenalty", 20_000.0),
                scoring.optDouble("disconnectPenalty", 15_000.0)
            )
        )
    }

    private fun fixedHttps(value: String): String {
        require(value.startsWith("https://")) { "MANIFEST_TARGET" }
        return value
    }

    private fun decodeUrl(value: String): ByteArray = Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}

object NeuralMeshScorer {
    fun result(profile: NeuralMeshProfile, rounds: List<NeuralMeshRound>, policy: NeuralMeshScoringPolicy): NeuralMeshResult {
        val successful = rounds.filter { it.connected && it.http204Ms != null }
        if (successful.size < policy.minimumSuccessfulRounds) return NeuralMeshResult(profile, rounds, null, false)
        val score = median(successful.mapNotNull { it.tunnelConnectMs }) * policy.tunnelWeight +
            median(successful.mapNotNull { it.http204Ms }) * policy.http204Weight +
            median(successful.mapNotNull { it.instagramTtfbMs }) * policy.instagramWeight +
            median(successful.mapNotNull { it.youtube204Ms }) * policy.youtubeWeight +
            median(successful.mapNotNull { it.downloadMs }) * policy.downloadWeight +
            rounds.sumOf { it.resets } * policy.resetPenalty +
            rounds.sumOf { it.timeouts } * policy.timeoutPenalty +
            rounds.sumOf { it.disconnects } * policy.disconnectPenalty
        return NeuralMeshResult(profile, rounds, max(0.0, score), true)
    }

    private fun median(values: List<Long>): Double {
        if (values.isEmpty()) return 60_000.0
        val ordered = values.sorted()
        return if (ordered.size % 2 == 1) ordered[ordered.size / 2].toDouble()
        else (ordered[ordered.size / 2 - 1] + ordered[ordered.size / 2]) / 2.0
    }
}
