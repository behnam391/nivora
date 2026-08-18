package ir.nivora.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ir.nivora.app.data.Plan
import ir.nivora.app.data.Subscription
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val PersianLocale = Locale.forLanguageTag("fa-IR")
private val PersianNumber = NumberFormat.getNumberInstance(PersianLocale)

fun toman(value: Int): String = "${PersianNumber.format(value)} تومان"
fun faNumber(value: Number): String = PersianNumber.format(value)
fun gb(bytes: Long): String = String.format(PersianLocale, "%.1f", bytes / 1073741824.0)

fun shortDate(value: String): String = runCatching {
    DateTimeFormatter.ofPattern("d MMM · HH:mm", PersianLocale)
        .format(Instant.parse(value).atZone(ZoneId.systemDefault()))
}.getOrDefault(value.take(10))

@Composable
fun CountryFlag(code: String?, modifier: Modifier = Modifier) {
    val normalized = code?.trim()?.uppercase(Locale.US).orEmpty()
    val colors = when (normalized) {
        "DE" -> listOf(Color(0xFF161616), Color(0xFFDD1E32), Color(0xFFFFCE00))
        "NL" -> listOf(Color(0xFFAE1C28), Color.White, Color(0xFF21468B))
        "FR" -> listOf(Color(0xFF1B4F9C), Color.White, Color(0xFFEF4135))
        "IR" -> listOf(Color(0xFF239F40), Color.White, Color(0xFFDA0000))
        "FI" -> listOf(Color.White, Color(0xFF003580), Color.White)
        "TR" -> listOf(Color(0xFFE30A17))
        "AE" -> listOf(Color(0xFF00732F), Color.White, Color.Black)
        "US" -> listOf(Color(0xFFB22234), Color.White, Color(0xFFB22234), Color.White, Color(0xFFB22234))
        "GB" -> listOf(Color(0xFF012169))
        "CA" -> listOf(Color(0xFFD80621), Color.White, Color(0xFFD80621))
        "SG" -> listOf(Color(0xFFEF3340), Color.White)
        "JP" -> listOf(Color.White)
        else -> emptyList()
    }
    Canvas(modifier.clip(RoundedCornerShape(8.dp))) {
        if (colors.isEmpty()) {
            drawRect(Color(0xFF1C3A54))
            drawCircle(Color(0xFF55E6B7), size.minDimension * .2f, center)
        } else {
            val vertical = normalized == "FR" || normalized == "CA"
            colors.forEachIndexed { index, color ->
                if (vertical) drawRect(color, topLeft = androidx.compose.ui.geometry.Offset(size.width * index / colors.size, 0f), size = androidx.compose.ui.geometry.Size(size.width / colors.size, size.height))
                else drawRect(color, topLeft = androidx.compose.ui.geometry.Offset(0f, size.height * index / colors.size), size = androidx.compose.ui.geometry.Size(size.width, size.height / colors.size))
            }
            if (normalized == "JP") drawCircle(Color(0xFFBC002D), size.minDimension * .24f, center)
            if (normalized == "TR") drawCircle(Color.White, size.minDimension * .19f, center)
        }
    }
}

@Composable
fun NivoraLogo(modifier: Modifier = Modifier, compact: Boolean = false, onDark: Boolean = false) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        NivoraMark(Modifier.size(if (compact) 40.dp else 57.dp))
        Column {
            Text("NIVORA", color = if (onDark) Color.White else MaterialTheme.colorScheme.onSurface, fontSize = if (compact) 19.sp else 26.sp, fontWeight = FontWeight.Black, letterSpacing = 2.sp)
            if (!compact) Text("اینترنت امن، ساده و سریع", style = MaterialTheme.typography.bodyMedium, color = if (onDark) Color(0xFFB9D0C8) else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun NivoraMark(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val mark = Path().apply {
            moveTo(.17f * w, .82f * h)
            lineTo(.17f * w, .29f * h)
            cubicTo(.17f * w, .20f * h, .27f * w, .16f * h, .34f * w, .24f * h)
            lineTo(.72f * w, .70f * h)
            lineTo(.72f * w, .28f * h)
            cubicTo(.72f * w, .20f * h, .78f * w, .15f * h, .86f * w, .15f * h)
            lineTo(.89f * w, .15f * h)
            lineTo(.89f * w, .73f * h)
            cubicTo(.89f * w, .84f * h, .77f * w, .89f * h, .70f * w, .80f * h)
            lineTo(.34f * w, .37f * h)
            lineTo(.34f * w, .72f * h)
            cubicTo(.34f * w, .79f * h, .29f * w, .84f * h, .22f * w, .84f * h)
            close()
        }
        drawPath(mark, brush = Brush.linearGradient(listOf(Color(0xFF7CF2CD), NivoraGreen, Color(0xFF07976D))))
        val highlight = Path().apply {
            moveTo(.34f * w, .37f * h)
            lineTo(.45f * w, .50f * h)
            lineTo(.45f * w, .72f * h)
            cubicTo(.45f * w, .78f * h, .40f * w, .82f * h, .34f * w, .83f * h)
            close()
        }
        drawPath(highlight, Color(0xFFCEFFF0).copy(alpha = .55f))
    }
}

@Composable
fun AppTopBar(name: String, unread: Int, refreshing: Boolean, onRefresh: () -> Unit, onNotifications: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("سلام، ${name.substringBefore(' ')} 👋", style = MaterialTheme.typography.titleLarge)
            Text("اتصال و اشتراک‌هایت آماده‌اند", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = onRefresh, enabled = !refreshing) {
            if (refreshing) CircularProgressIndicator(modifier = Modifier.size(21.dp), strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "تازه‌سازی")
        }
        Box {
            IconButton(onClick = onNotifications) { Icon(Icons.Rounded.NotificationsNone, "اعلان‌ها") }
            if (unread > 0) {
                Box(
                    Modifier.align(Alignment.TopEnd).size(19.dp).background(NivoraDanger, CircleShape),
                    contentAlignment = Alignment.Center
                ) { Text(if (unread > 9) "۹+" else faNumber(unread), color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold) }
            }
        }
    }
}

@Composable
fun ConnectionHero(
    state: String,
    error: String?,
    smartRoute: String?,
    subscription: Subscription?,
    pingMs: Long?,
    pingBusy: Boolean,
    onToggle: () -> Unit,
    onPing: () -> Unit
) {
    val connected = state == "connected"
    val connecting = state == "connecting"
    val glow by animateColorAsState(if (connected) NivoraGreen else Color(0xFF31584B), label = "connection-glow")
    val powerScale by animateFloatAsState(if (connected) 1.04f else 1f, label = "power-scale")
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(32.dp),
        colors = CardDefaults.cardColors(containerColor = NivoraInk),
        elevation = CardDefaults.cardElevation(defaultElevation = 10.dp)
    ) {
        Box(
            Modifier.fillMaxWidth().background(
                Brush.radialGradient(
                    colors = listOf(glow.copy(.30f), Color.Transparent),
                    radius = 700f
                )
            )
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("اتصال امن", color = Color.White, style = MaterialTheme.typography.titleLarge)
                        Text(
                            when (state) {
                                "connected" -> "محافظت فعال است"
                                "connecting" -> "در حال ساخت تونل امن…"
                                "error" -> "اتصال برقرار نشد"
                                else -> "برای اتصال دکمه را لمس کنید"
                            },
                            color = if (connected) Color(0xFF8EF0CF) else Color(0xFF9DB9AF),
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                    StatusPill(
                        label = when (state) { "connected" -> "متصل"; "connecting" -> "در حال اتصال"; "error" -> "خطا"; else -> "قطع" },
                        color = when (state) { "connected" -> NivoraGreen; "connecting" -> NivoraWarning; "error" -> NivoraDanger; else -> Color(0xFF8BA099) },
                        dark = true
                    )
                }
                Spacer(Modifier.height(28.dp))
                Box(
                    modifier = Modifier
                        .size((126 * powerScale).dp)
                        .shadow(36.dp, CircleShape, ambientColor = glow.copy(.65f), spotColor = glow.copy(.65f))
                        .background(glow.copy(.18f), CircleShape)
                        .border(1.dp, glow.copy(.62f), CircleShape)
                        .padding(13.dp)
                        .background(if (connected) NivoraGreen else Color(0xFF17382E), CircleShape)
                        .clickable(enabled = !connecting, onClick = onToggle),
                    contentAlignment = Alignment.Center
                ) {
                    if (connecting) CircularProgressIndicator(color = NivoraGreen, strokeWidth = 4.dp, modifier = Modifier.size(48.dp))
                    else Icon(Icons.Rounded.PowerSettingsNew, if (connected) "قطع اتصال" else "اتصال", tint = if (connected) NivoraInk else Color.White, modifier = Modifier.size(50.dp))
                }
                Spacer(Modifier.height(22.dp))
                Text(
                    subscription?.let { it.locationName ?: it.planName } ?: "اشتراک فعالی انتخاب نشده",
                    color = Color.White,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                if (connected && !smartRoute.isNullOrBlank()) {
                    Text(
                        "مسیر هوشمند: $smartRoute",
                        color = Color(0xFF8EF0CF),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 7.dp)
                    )
                } else if (connecting) {
                    Text(
                        "در حال انتخاب بهترین مسیر برای این شبکه…",
                        color = Color(0xFF9DB9AF),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 7.dp)
                    )
                }
                if (state == "error" && !error.isNullOrBlank()) {
                    Text(error, color = Color(0xFFFFA9AE), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                }
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    DarkMetric(Icons.Rounded.Speed, if (pingBusy) "…" else pingMs?.let { "$it ms" } ?: "تست پینگ", onPing)
                    DarkMetric(Icons.Rounded.Lock, "Reality", null)
                }
            }
        }
    }
}

@Composable
private fun DarkMetric(icon: ImageVector, label: String, onClick: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Color.White.copy(.08f))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 15.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        Icon(icon, null, tint = NivoraGreen, modifier = Modifier.size(18.dp))
        Text(label, color = Color.White, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun SectionHeader(title: String, subtitle: String? = null, action: String? = null, onAction: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        if (action != null && onAction != null) TextButton(onClick = onAction) { Text(action) }
    }
}

@Composable
fun SubscriptionCard(
    subscription: Subscription,
    selected: Boolean,
    onSelect: () -> Unit,
    onCopy: () -> Unit,
    onRenew: () -> Unit
) {
    val progress = (subscription.usagePercent / 100.0).toFloat().coerceIn(0f, 1f)
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (selected) CardDefaults.outlinedCardBorder().copy(brush = Brush.linearGradient(listOf(NivoraGreenDark, NivoraGreen))) else CardDefaults.outlinedCardBorder()
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
                    CountryFlag(subscription.countryCode, Modifier.fillMaxSize())
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(subscription.planName, style = MaterialTheme.typography.titleMedium)
                    Text(subscription.locationName ?: "انتخاب خودکار", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                    if (subscription.routeCount > 1) Text("${faNumber(subscription.routeCount)} مسیر هوشمند", color = NivoraGreenDark, style = MaterialTheme.typography.labelMedium)
                }
                if (selected) StatusPill("انتخاب‌شده", NivoraGreenDark)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("مصرف ${gb(subscription.usedBytes)} از ${gb(subscription.totalBytes)} گیگ", style = MaterialTheme.typography.bodyMedium)
                Text("${faNumber(subscription.usagePercent)}٪", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            }
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth().height(8.dp).clip(CircleShape),
                color = if (progress > .85f) NivoraDanger else NivoraGreen,
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SubscriptionMetric(Icons.Rounded.CalendarMonth, if (subscription.startsOnFirstUse) "از اولین اتصال" else "${faNumber(subscription.remainingDays)} روز")
                SubscriptionMetric(Icons.Rounded.Devices, "${faNumber(subscription.deviceLimit)} دستگاه")
                SubscriptionMetric(Icons.Rounded.DataUsage, "${faNumber(subscription.trafficGb)} گیگ")
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(.65f))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onCopy, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.ContentCopy, null, Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)); Text("کپی لینک") }
                Button(onClick = onRenew, modifier = Modifier.weight(1f)) { Icon(Icons.Rounded.Autorenew, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("تمدید") }
            }
        }
    }
}

@Composable
private fun RowScope.SubscriptionMetric(icon: ImageVector, value: String) {
    Column(
        modifier = Modifier.weight(1f).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(13.dp)).padding(vertical = 9.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(17.dp))
        Spacer(Modifier.height(4.dp))
        Text(value, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

@Composable
fun PlanCard(plan: Plan, index: Int, onBuy: () -> Unit) {
    val featured = index == 1
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(26.dp),
        colors = CardDefaults.cardColors(containerColor = if (featured) NivoraInk else MaterialTheme.colorScheme.surface),
        border = if (featured) null else CardDefaults.outlinedCardBorder()
    ) {
        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(plan.name, style = MaterialTheme.typography.titleLarge, color = if (featured) Color.White else MaterialTheme.colorScheme.onSurface)
                        if (featured) StatusPill("پیشنهادی", NivoraGreen, dark = true)
                    }
                    if (plan.description.isNotBlank()) Text(plan.description, color = if (featured) Color(0xFFA8BFB7) else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(faNumber(plan.priceToman), color = if (featured) NivoraGreen else MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Black, fontSize = 23.sp)
                    Text("تومان", color = if (featured) Color(0xFFA8BFB7) else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PlanFeature(Icons.Rounded.DataUsage, "${faNumber(plan.trafficGb)} گیگ", featured)
                PlanFeature(Icons.Rounded.CalendarMonth, "${faNumber(plan.durationDays)} روز", featured)
                PlanFeature(Icons.Rounded.Devices, "${faNumber(plan.deviceLimit)} دستگاه", featured)
            }
            if (plan.locations.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.LocationOn, null, tint = NivoraGreen, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(plan.locations.joinToString("، "), color = if (featured) Color(0xFFC2D5CE) else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Button(
                onClick = onBuy,
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = if (featured) ButtonDefaults.buttonColors(containerColor = NivoraGreen, contentColor = NivoraInk) else ButtonDefaults.buttonColors()
            ) { Text("انتخاب و خرید پلن") }
        }
    }
}

@Composable
private fun RowScope.PlanFeature(icon: ImageVector, value: String, dark: Boolean) {
    Row(
        modifier = Modifier.weight(1f).background(if (dark) Color.White.copy(.08f) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(13.dp)).padding(horizontal = 8.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, null, tint = NivoraGreen, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(4.dp))
        Text(value, color = if (dark) Color.White else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

@Composable
fun WalletBalanceCard(balance: Int, onTopup: () -> Unit) {
    Card(shape = RoundedCornerShape(28.dp), colors = CardDefaults.cardColors(containerColor = NivoraInk), modifier = Modifier.fillMaxWidth()) {
        Box(Modifier.background(Brush.linearGradient(listOf(NivoraInk, Color(0xFF104738))))) {
            Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(45.dp).background(Color.White.copy(.1f), RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.AccountBalanceWallet, null, tint = NivoraGreen)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("موجودی کیف پول", color = Color(0xFFB6CCC4), style = MaterialTheme.typography.bodyMedium)
                        Text(toman(balance), color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black)
                    }
                }
                Button(onClick = onTopup, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = NivoraGreen, contentColor = NivoraInk)) {
                    Icon(Icons.Rounded.Add, null); Spacer(Modifier.width(7.dp)); Text("افزایش موجودی")
                }
            }
        }
    }
}

@Composable
fun StatusPill(label: String, color: Color, dark: Boolean = false) {
    Box(
        Modifier.background(color.copy(if (dark) .18f else .12f), CircleShape).border(1.dp, color.copy(.35f), CircleShape).padding(horizontal = 10.dp, vertical = 5.dp)
    ) { Text(label, color = if (dark && color == NivoraGreen) Color(0xFF8EF0CF) else color, style = MaterialTheme.typography.labelMedium) }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, body: String, action: String? = null, onAction: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 32.dp, horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Box(Modifier.size(64.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(22.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(30.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null && onAction != null) Button(onClick = onAction) { Text(action) }
    }
}

@Composable
fun FullScreenLoading() {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
            NivoraLogo()
            CircularProgressIndicator(color = NivoraGreen, strokeWidth = 3.dp)
            Text("در حال آماده‌سازی حساب…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun FullScreenError(message: String, onRetry: () -> Unit, onLogout: () -> Unit) {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Box(Modifier.size(74.dp).background(MaterialTheme.colorScheme.error.copy(.10f), RoundedCornerShape(25.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.CloudOff, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(36.dp))
            }
            Text("ارتباط برقرار نشد", style = MaterialTheme.typography.headlineMedium)
            Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Refresh, null); Spacer(Modifier.width(6.dp)); Text("تلاش دوباره") }
            TextButton(onClick = onLogout) { Text("خروج از حساب") }
        }
    }
}
