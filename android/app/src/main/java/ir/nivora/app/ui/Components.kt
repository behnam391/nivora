package ir.nivora.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ir.nivora.app.data.Plan
import ir.nivora.app.data.Subscription
import ir.nivora.app.R
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

fun countryFlag(code: String?): String = when (code?.trim()?.uppercase(Locale.US)) {
    "IR" -> "🇮🇷"; "FI" -> "🇫🇮"; "DE" -> "🇩🇪"; "NL" -> "🇳🇱"
    "FR" -> "🇫🇷"; "TR" -> "🇹🇷"; "AE" -> "🇦🇪"; "US" -> "🇺🇸"
    "GB" -> "🇬🇧"; "CA" -> "🇨🇦"; "SG" -> "🇸🇬"; "JP" -> "🇯🇵"
    else -> "🌐"
}

@Composable
fun NivoraLogo(modifier: Modifier = Modifier, compact: Boolean = false, onDark: Boolean = false) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Image(
            painter = painterResource(R.drawable.nivora_logo_v3),
            contentDescription = "Nivora",
            modifier = Modifier.size(if (compact) 40.dp else 57.dp),
            contentScale = ContentScale.Fit
        )
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
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
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
        shape = RoundedCornerShape(30.dp),
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
                modifier = Modifier.fillMaxWidth().padding(horizontal = 19.dp, vertical = 16.dp),
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
                Spacer(Modifier.height(12.dp))
                Box(
                    modifier = Modifier
                        .size((82 * powerScale).dp)
                        .shadow(18.dp, CircleShape, ambientColor = glow.copy(.48f), spotColor = glow.copy(.48f))
                        .background(glow.copy(.18f), CircleShape)
                        .border(1.dp, glow.copy(.62f), CircleShape)
                        .padding(8.dp)
                        .background(if (connected) NivoraGreen else Color(0xFF17382E), CircleShape)
                        .clickable(enabled = !connecting, onClick = onToggle),
                    contentAlignment = Alignment.Center
                ) {
                    if (connecting) CircularProgressIndicator(color = NivoraGreen, strokeWidth = 4.dp, modifier = Modifier.size(42.dp))
                    else Icon(Icons.Rounded.PowerSettingsNew, if (connected) "قطع اتصال" else "اتصال", tint = if (connected) NivoraInk else Color.White, modifier = Modifier.size(34.dp))
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    subscription?.let { "${countryFlag(it.countryCode)}  ${it.locationName ?: it.planName}" } ?: "اشتراک فعالی انتخاب نشده",
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
                        modifier = Modifier.padding(top = 5.dp)
                    )
                } else if (connecting) {
                    Text(
                        "در حال انتخاب بهترین مسیر برای این شبکه…",
                        color = Color(0xFF9DB9AF),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 5.dp)
                    )
                }
                if (state == "error" && !error.isNullOrBlank()) {
                    Text(error, color = Color(0xFFFFA9AE), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                }
                Spacer(Modifier.height(9.dp))
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
    onRenew: () -> Unit
) {
    var expanded by androidx.compose.runtime.saveable.rememberSaveable(subscription.id) { androidx.compose.runtime.mutableStateOf(false) }
    val progress = (subscription.usagePercent / 100.0).toFloat().coerceIn(0f, 1f)
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = if (selected) CardDefaults.outlinedCardBorder().copy(brush = Brush.linearGradient(listOf(NivoraGreenDark, NivoraGreen))) else CardDefaults.outlinedCardBorder()
    ) {
        Column(Modifier.padding(horizontal = 15.dp, vertical = 13.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Row(Modifier.fillMaxWidth().clickable { onSelect(); expanded = !expanded }, verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
                    Text(countryFlag(subscription.countryCode), fontSize = 23.sp)
                }
                Spacer(Modifier.width(11.dp))
                Column(Modifier.weight(1f)) {
                    Text(subscription.planName, style = MaterialTheme.typography.titleMedium)
                    Text(subscription.locationName ?: "انتخاب خودکار", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
                }
                if (selected) StatusPill("انتخاب‌شده", NivoraGreenDark)
                Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (expanded) "بستن جزئیات" else "نمایش جزئیات", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${gb(subscription.usedBytes)} / ${gb(subscription.totalBytes)} گیگ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${faNumber(subscription.usagePercent)}٪ مصرف", style = MaterialTheme.typography.labelMedium, color = if (progress > .85f) NivoraDanger else NivoraGreenDark)
            }
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(5.dp).clip(CircleShape), color = if (progress > .85f) NivoraDanger else NivoraGreen, trackColor = MaterialTheme.colorScheme.surfaceVariant)
            if (expanded) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SubscriptionMetric(Icons.Rounded.CalendarMonth, if (subscription.startsOnFirstUse) "شروع نشده" else "${faNumber(subscription.remainingDays)} روز")
                    SubscriptionMetric(Icons.Rounded.Devices, "${faNumber(subscription.deviceLimit)} دستگاه")
                    SubscriptionMetric(Icons.Rounded.DataUsage, "${faNumber(subscription.trafficGb)} گیگ")
                }
                if (subscription.routeCount > 1) Text("${faNumber(subscription.routeCount)} مسیر هوشمند برای این اشتراک فعال است", color = NivoraGreenDark, style = MaterialTheme.typography.labelMedium)
                Button(onClick = onRenew, modifier = Modifier.fillMaxWidth().height(40.dp)) { Icon(Icons.Rounded.Autorenew, null, Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)); Text("تمدید اشتراک") }
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
