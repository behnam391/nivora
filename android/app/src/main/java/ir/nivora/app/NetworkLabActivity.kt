package ir.nivora.app

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import ir.nivora.app.data.*
import ir.nivora.app.ui.NivoraTheme
import ir.nivora.app.vpn.NivoraVpnService
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.net.URL
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException
import kotlin.concurrent.thread
import kotlin.math.max

class NetworkLabActivity : ComponentActivity() {
    private val api = ApiClient(BuildConfig.API_BASE_URL)
    private lateinit var tokenStore: NeuralMeshTokenStore
    private val preferences by lazy { getSharedPreferences("neuralmesh_lab", MODE_PRIVATE) }
    private val signals = LinkedBlockingQueue<VpnSignal>()
    private val cancelled = AtomicBoolean(false)
    private var receiverRegistered = false

    private var manifest by mutableStateOf<NeuralMeshManifest?>(null)
    private var loading by mutableStateOf(false)
    private var running by mutableStateOf(false)
    private var status by mutableStateOf("آماده دریافت پروفایل‌های امضاشده")
    private var error by mutableStateOf<String?>(null)
    private var completedSteps by mutableIntStateOf(0)
    private var results by mutableStateOf<List<NeuralMeshResult>>(emptyList())
    private var operator by mutableStateOf("مخابرات")
    private var autoSelect by mutableStateOf(true)

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) startRun() else error = "مجوز VPN برای اجرای آزمایش لازم است."
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val vpnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val runId = intent?.getStringExtra(NivoraVpnService.EXTRA_RUN_ID) ?: return
            val value = intent.getStringExtra(NivoraVpnService.EXTRA_STATE) ?: return
            signals.offer(VpnSignal(runId, value, intent.getStringExtra(NivoraVpnService.EXTRA_ERROR)))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!BuildConfig.NETWORK_LAB_ENABLED) {
            finish()
            return
        }
        tokenStore = NeuralMeshTokenStore(this)
        operator = preferences.getString("operator", "مخابرات") ?: "مخابرات"
        autoSelect = preferences.getBoolean("auto_select", true)
        ContextCompat.registerReceiver(this, vpnReceiver, IntentFilter(NivoraVpnService.ACTION_STATE), ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
        setContent {
            NivoraTheme {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    NetworkLabScreen(
                        manifest = manifest,
                        loading = loading,
                        running = running,
                        status = status,
                        error = error,
                        completedSteps = completedSteps,
                        results = results,
                        operator = operator,
                        autoSelect = autoSelect,
                        hasStoredToken = tokenStore.read() != null,
                        onBack = ::finish,
                        onSaveToken = ::saveTokenAndLoad,
                        onForgetToken = ::forgetToken,
                        onRetry = ::loadStoredManifest,
                        onOperator = { operator = it; preferences.edit().putString("operator", it).apply() },
                        onAutoSelect = { autoSelect = it; preferences.edit().putBoolean("auto_select", it).apply() },
                        onRun = ::requestRun,
                        onCancel = ::cancelRun
                    )
                }
            }
        }
        loadStoredManifest()
    }

    override fun onDestroy() {
        cancelRun()
        if (receiverRegistered) unregisterReceiver(vpnReceiver)
        super.onDestroy()
    }

    private fun saveTokenAndLoad(token: String) {
        if (token.trim().length < 32) {
            error = "توکن آزمایش معتبر نیست."
            return
        }
        tokenStore.save(token.trim())
        loadStoredManifest()
    }

    private fun forgetToken() {
        if (running) return
        tokenStore.clear()
        manifest = null
        results = emptyList()
        error = null
        status = "توکن اختصاصی آزمایش را وارد کنید"
    }

    private fun loadStoredManifest() {
        val token = tokenStore.read() ?: return
        if (loading || running) return
        loading = true
        error = null
        status = "در حال اعتبارسنجی Manifest امضاشده…"
        thread(name = "neuralmesh-manifest") {
            runCatching {
                NeuralMeshManifestVerifier.verify(api.neuralMeshManifest(token), BuildConfig.NEURALMESH_PUBLIC_KEY_SPKI)
            }.onSuccess { value -> runOnUiThread {
                manifest = value
                loading = false
                status = "${value.profiles.size} مسیر آزمایشی معتبر آماده‌اند"
            } }.onFailure { failure -> runOnUiThread {
                Log.e("NivoraNetworkLab", "Manifest validation failed", failure)
                loading = false
                error = when ((failure as? ApiException)?.status) {
                    401 -> "توکن آزمایش پذیرفته نشد."
                    410 -> "Manifest منقضی شده و باید روی سرور تمدید شود."
                    else -> if (failure.message?.contains("SIGNATURE") == true) "امضای Manifest معتبر نیست؛ آزمایش متوقف شد." else "دریافت تنظیمات آزمایش انجام نشد."
                }
                status = "Manifest در دسترس نیست"
            } }
        }
    }

    private fun requestRun() {
        if (running || manifest == null) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        val permission = VpnService.prepare(this)
        if (permission != null) vpnPermission.launch(permission) else startRun()
    }

    private fun startRun() {
        val policy = manifest ?: return
        cancelled.set(false)
        running = true
        error = null
        results = emptyList()
        completedSteps = 0
        val networkType = currentNetworkType()
        val storageKey = "${operator}_$networkType"
        val winner = preferences.getString("winner_$storageKey", null)
        val runnerUp = preferences.getString("runner_$storageKey", null)
        val ordered = policy.profiles.sortedBy { profile -> when (profile.id) { winner -> 0; runnerUp -> 1; else -> 2 } }
        thread(name = "neuralmesh-run") {
            val collected = mutableListOf<NeuralMeshResult>()
            for (profile in ordered) {
                if (cancelled.get()) break
                runOnUiThread { status = "آزمایش ${profileLabel(profile)}" }
                val rounds = buildList {
                    for (round in 1..policy.measurement.rounds) {
                        if (cancelled.get()) break
                        add(runRound(profile, round, policy.measurement))
                        runOnUiThread {
                            completedSteps += 1
                            status = "${profileLabel(profile)} · دور $round از ${policy.measurement.rounds}"
                        }
                    }
                }
                val result = NeuralMeshScorer.result(profile, rounds, policy.scoring)
                collected += result
                runOnUiThread { results = collected.toList() }
            }
            stopVpn()
            val ranked = collected.filter { it.accepted && it.score != null }.sortedBy { it.score }
            if (!cancelled.get() && autoSelect && ranked.isNotEmpty()) {
                preferences.edit()
                    .putString("winner_$storageKey", ranked.first().profile.id)
                    .apply { ranked.getOrNull(1)?.let { putString("runner_$storageKey", it.profile.id) } }
                    .putLong("measured_$storageKey", System.currentTimeMillis())
                    .apply()
            }
            runOnUiThread {
                running = false
                status = when {
                    cancelled.get() -> "آزمایش متوقف شد"
                    ranked.isEmpty() -> "هیچ مسیر پایداری در بررسی سریع پیدا نشد"
                    else -> "برنده ${operator} روی $networkType: ${profileLabel(ranked.first().profile)}"
                }
            }
        }
    }

    private fun runRound(profile: NeuralMeshProfile, round: Int, policy: NeuralMeshMeasurementPolicy): NeuralMeshRound {
        stopVpn()
        Thread.sleep(250)
        signals.clear()
        if (cancelled.get()) return failedRound(profile, round, "CANCELLED")
        val runId = UUID.randomUUID().toString()
        val started = SystemClock.elapsedRealtime()
        startForegroundService(Intent(this, NivoraVpnService::class.java)
            .putExtra(NivoraVpnService.EXTRA_SHARE_LINK, profile.uri)
            .putExtra(NivoraVpnService.EXTRA_LABEL, "Network Lab · ${profileLabel(profile)}")
            .putExtra(NivoraVpnService.EXTRA_RUN_ID, runId))
        var connected = false
        var connectError: String? = null
        val deadline = started + policy.connectTimeoutMs
        while (!cancelled.get() && SystemClock.elapsedRealtime() < deadline) {
            val signal = signals.poll(300, TimeUnit.MILLISECONDS) ?: continue
            if (signal.runId != runId) continue
            if (signal.state == "connected") { connected = true; break }
            if (signal.state == "error") { connectError = signal.error ?: "VPN_START_FAILED"; break }
        }
        if (!connected) {
            Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=tunnel outcome=${connectError ?: "CONNECT_TIMEOUT"}")
            stopVpn()
            return failedRound(profile, round, connectError ?: "CONNECT_TIMEOUT", timeout = connectError == null)
        }
        val connectMs = SystemClock.elapsedRealtime() - started
        var resets = 0
        var timeouts = 0
        var disconnects = 0
        fun <T> capture(metric: String, block: () -> T): T? = try { block() } catch (_: SocketTimeoutException) {
            timeouts++; Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=$metric outcome=TIMEOUT"); null
        } catch (_: UnknownHostException) {
            disconnects++; Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=$metric outcome=DNS"); null
        } catch (_: SSLException) {
            disconnects++; Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=$metric outcome=TLS"); null
        } catch (failure: SocketException) {
            val reset = failure.message?.contains("reset", true) == true
            if (reset) resets++ else disconnects++
            Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=$metric outcome=${if (reset) "RESET" else "SOCKET"}")
            null
        } catch (_: IOException) {
            disconnects++; Log.w("NeuralMeshLab", "profile=${profile.id} round=$round metric=$metric outcome=IO"); null
        }
        // Iranian providers may reset one benchmark host (most commonly
        // Google's gstatic 204) while the tunnel and the rest of the Internet
        // are usable. Require all independent probes to fail before rejecting
        // the round, rather than making one Google endpoint a single point of
        // failure.
        val http204 = capture("http204") {
            headerLatency(policy.http204Url, policy.requestTimeoutMs, expected204 = true)
        } ?: capture("youtube-bootstrap") {
            headerLatency(policy.youtube204Url, policy.requestTimeoutMs, expected204 = true)
        } ?: capture("instagram-bootstrap") {
            headerLatency(policy.instagramUrl, policy.requestTimeoutMs)
        }
        if (http204 == null) {
            if (!NivoraVpnService.isCoreRunning()) disconnects++
            stopVpn()
            return NeuralMeshRound(
                profile.id, round, false, connectMs, null, null, null,
                null, null, resets, timeouts, disconnects, "HTTP204_FAILED"
            )
        }
        val instagram = capture("instagram") { headerLatency(policy.instagramUrl, policy.requestTimeoutMs) }
        val youtube = capture("youtube204") { headerLatency(policy.youtube204Url, policy.requestTimeoutMs, expected204 = true) }
        val download = capture("download") { downloadMetric(policy.downloadUrl, policy.downloadBytes, policy.requestTimeoutMs) }
        if (!NivoraVpnService.isCoreRunning()) disconnects++
        stopVpn()
        return NeuralMeshRound(
            profile.id, round, true, connectMs, http204, instagram, youtube,
            download?.first, download?.second, resets, timeouts, disconnects,
            null
        )
    }

    private fun headerLatency(url: String, timeoutMs: Int, expected204: Boolean = false): Long {
        val started = SystemClock.elapsedRealtime()
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            useCaches = false
            instanceFollowRedirects = false
            setRequestProperty("User-Agent", "Nivora-Network-Lab/1.0")
        }
        return try {
            val code = connection.responseCode
            if (expected204 && code != 204) throw IOException("EXPECTED_204")
            if (!expected204 && code !in 200..499) throw IOException("HTTP_$code")
            SystemClock.elapsedRealtime() - started
        } finally { connection.disconnect() }
    }

    private fun downloadMetric(url: String, bytes: Int, timeoutMs: Int): Pair<Long, Double> {
        val started = SystemClock.elapsedRealtime()
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            useCaches = false
            setRequestProperty("Accept-Encoding", "identity")
        }
        var received = 0
        try {
            if (connection.responseCode !in 200..299) throw IOException("DOWNLOAD_HTTP")
            connection.inputStream.use { stream ->
                val buffer = ByteArray(64 * 1024)
                while (received < bytes && !cancelled.get()) {
                    val count = stream.read(buffer, 0, minOf(buffer.size, bytes - received))
                    if (count < 0) break
                    received += count
                }
            }
        } finally { connection.disconnect() }
        if (received < bytes) throw IOException("DOWNLOAD_SHORT")
        val duration = max(1, SystemClock.elapsedRealtime() - started)
        val mbps = received * 8.0 / (duration / 1000.0) / 1_000_000.0
        return duration to mbps
    }

    private fun failedRound(profile: NeuralMeshProfile, round: Int, code: String, timeout: Boolean = false) = NeuralMeshRound(
        profile.id, round, false, null, null, null, null, null, null,
        resets = 0, timeouts = if (timeout) 1 else 0, disconnects = if (timeout) 0 else 1, error = code
    )

    private fun stopVpn() {
        startService(Intent(this, NivoraVpnService::class.java).setAction(NivoraVpnService.ACTION_STOP))
    }

    private fun cancelRun() {
        cancelled.set(true)
        if (running) stopVpn()
    }

    private fun currentNetworkType(): String {
        val manager = getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        return when {
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi-Fi"
            capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Cellular"
            else -> "Other"
        }
    }

    private data class VpnSignal(val runId: String, val state: String, val error: String?)
}

private fun profileLabel(profile: NeuralMeshProfile): String = when (profile.id) {
    "reality-vision-8443" -> "Reality Vision"
    "hysteria2-turbo-7443" -> "Hysteria2 Turbo"
    "xhttp-reality-2095" -> "XHTTP Reality"
    "xhttp-tls-edge" -> "XHTTP TLS Edge"
    "vless-wss-cloudflare" -> "VLESS WSS Cloudflare"
    "vless-grpc-cloudflare" -> "VLESS gRPC Cloudflare"
    "vless-httpupgrade-cloudflare" -> "VLESS HTTPUpgrade Cloudflare"
    else -> profile.name
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NetworkLabScreen(
    manifest: NeuralMeshManifest?,
    loading: Boolean,
    running: Boolean,
    status: String,
    error: String?,
    completedSteps: Int,
    results: List<NeuralMeshResult>,
    operator: String,
    autoSelect: Boolean,
    hasStoredToken: Boolean,
    onBack: () -> Unit,
    onSaveToken: (String) -> Unit,
    onForgetToken: () -> Unit,
    onRetry: () -> Unit,
    onOperator: (String) -> Unit,
    onAutoSelect: (Boolean) -> Unit,
    onRun: () -> Unit,
    onCancel: () -> Unit
) {
    var token by rememberSaveable { mutableStateOf("") }
    var operatorMenu by remember { mutableStateOf(false) }
    val totalSteps = manifest?.let { it.profiles.size * it.measurement.rounds } ?: 12
    Scaffold(topBar = {
        TopAppBar(
            title = { Column { Text("Network Lab", fontWeight = FontWeight.Black); Text("NeuralMesh v1", style = MaterialTheme.typography.labelMedium) } },
            navigationIcon = { IconButton(onClick = onBack, enabled = !running) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "بازگشت") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)
        )
    }) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF0B332A)), shape = RoundedCornerShape(24.dp)) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.Science, null, tint = Color(0xFF38E0AC), modifier = Modifier.size(32.dp))
                            Spacer(Modifier.width(10.dp))
                            Column { Text("انتخاب مسیر بر اساس اینترنت واقعی", color = Color.White, style = MaterialTheme.typography.titleLarge); Text(status, color = Color(0xFFB7D7CC)) }
                        }
                        if (running) {
                            LinearProgressIndicator(progress = { completedSteps.toFloat() / totalSteps.coerceAtLeast(1) }, modifier = Modifier.fillMaxWidth())
                            Text("$completedSteps از $totalSteps آزمایش", color = Color.White, style = MaterialTheme.typography.labelLarge)
                        }
                    }
                }
            }
            if (!hasStoredToken) item {
                Card(shape = RoundedCornerShape(22.dp)) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("فعال‌سازی امن آزمایشگاه", style = MaterialTheme.typography.titleLarge)
                        Text("توکن فقط به‌صورت رمزگذاری‌شده در Keystore گوشی نگهداری می‌شود و در گزارش‌ها نمایش داده نمی‌شود.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        OutlinedTextField(token, { token = it.trim().take(256) }, Modifier.fillMaxWidth(), label = { Text("توکن آزمایش") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
                        Button(onClick = { onSaveToken(token); token = "" }, enabled = token.length >= 32 && !loading, modifier = Modifier.fillMaxWidth()) { Text("ذخیره امن و دریافت Manifest") }
                    }
                }
            }
            if (error != null) item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer), shape = RoundedCornerShape(18.dp)) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(error, color = MaterialTheme.colorScheme.onErrorContainer)
                        Row { TextButton(onClick = onRetry, enabled = !loading) { Text("تلاش دوباره") }; TextButton(onClick = onForgetToken, enabled = !running) { Text("تغییر توکن") } }
                    }
                }
            }
            if (manifest != null) {
                item {
                    Card(shape = RoundedCornerShape(22.dp)) {
                        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
                            Text("تنظیم اجرای واقعی", style = MaterialTheme.typography.titleLarge)
                            ExposedDropdownMenuBox(expanded = operatorMenu, onExpandedChange = { if (!running) operatorMenu = it }) {
                                OutlinedTextField(operator, {}, readOnly = true, modifier = Modifier.menuAnchor().fillMaxWidth(), label = { Text("اپراتور / اینترنت") }, trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(operatorMenu) })
                                ExposedDropdownMenu(operatorMenu, { operatorMenu = false }) {
                                    listOf("مخابرات", "ایرانسل", "همراه اول").forEach { value -> DropdownMenuItem({ Text(value) }, onClick = { onOperator(value); operatorMenu = false }) }
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) { Text("انتخاب خودکار", fontWeight = FontWeight.Bold); Text("برنده و مسیر پشتیبان برای همین اپراتور روی گوشی ذخیره می‌شوند.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                                Switch(autoSelect, onAutoSelect, enabled = !running)
                            }
                        }
                    }
                }
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer), shape = RoundedCornerShape(20.dp)) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
                            Icon(Icons.Rounded.DataUsage, null); Spacer(Modifier.width(10.dp))
                            Text("این اجرا ${manifest.profiles.size} مسیر را هرکدام ${manifest.measurement.rounds} بار بررسی می‌کند و حدود ${manifest.measurement.estimatedTotalBytes / 1_000_000} مگابایت مصرف دارد. فقط مقصدهای ثابت آزمایش می‌شوند و داده شخصی ذخیره نمی‌شود.", modifier = Modifier.weight(1f))
                        }
                    }
                }
                item {
                    if (running) OutlinedButton(onClick = onCancel, Modifier.fillMaxWidth()) { Icon(Icons.Rounded.StopCircle, null); Spacer(Modifier.width(8.dp)); Text("توقف آزمایش") }
                    else Button(onClick = onRun, enabled = !loading, modifier = Modifier.fillMaxWidth().height(54.dp)) { Icon(Icons.Rounded.PlayArrow, null); Spacer(Modifier.width(8.dp)); Text("شروع آزمایش هوشمند") }
                }
                if (results.isNotEmpty()) item { Text("نتیجه مسیرها", style = MaterialTheme.typography.headlineSmall) }
                items(results, key = { it.profile.id }) { result -> ResultCard(result) }
                item {
                    TextButton(onClick = onForgetToken, enabled = !running, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.DeleteOutline, null); Spacer(Modifier.width(7.dp)); Text("حذف توکن آزمایش از گوشی") }
                }
            } else if (loading) item { Box(Modifier.fillMaxWidth().padding(28.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
        }
    }
}

@Composable
private fun ResultCard(result: NeuralMeshResult) {
    val medianMbps = result.rounds.mapNotNull { it.downloadMbps }.sorted().let { if (it.isEmpty()) null else it[it.size / 2] }
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = if (result.accepted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (result.accepted) Icons.Rounded.CheckCircle else Icons.Rounded.Cancel, null)
                Spacer(Modifier.width(8.dp))
                Text(profileLabel(result.profile), modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(result.score?.let { "امتیاز ${it.toLong()}" } ?: "مردود", style = MaterialTheme.typography.labelLarge)
            }
            Text("${result.rounds.count { it.connected }} از ${result.rounds.size} دور موفق" + (medianMbps?.let { " · ${"%.1f".format(it)} Mbps" } ?: ""), color = MaterialTheme.colorScheme.onSurfaceVariant)
            val resets = result.rounds.sumOf { it.resets }; val timeouts = result.rounds.sumOf { it.timeouts }; val disconnects = result.rounds.sumOf { it.disconnects }
            Text("Reset: $resets · Timeout: $timeouts · Disconnect: $disconnects", style = MaterialTheme.typography.bodySmall)
        }
    }
}
