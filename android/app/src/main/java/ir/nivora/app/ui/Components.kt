package ir.nivora.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ir.nivora.app.R
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

fun countryFlag(code: String?): String = when (code?.trim()?.uppercase(Locale.US)) {
    "IR" -> "🇮🇷"; "FI" -> "🇫🇮"; "DE" -> "🇩🇪"; "NL" -> "🇳🇱"
    "FR" -> "🇫🇷"; "TR" -> "🇹🇷"; "AE" -> "🇦🇪"; "US" -> "🇺🇸"
    "GB" -> "🇬🇧"; "CA" -> "🇨🇦"; "SG" -> "🇸🇬"; "JP" -> "🇯🇵"
    else -> "🌐"
}

@Composable
fun NivoraLogo(modifier: Modifier = Modifier, compact: Boolean = false, onDark: Boolean = false) {
    // A single branded resource is shared with the launcher/splash pipeline so
    // the user never sees a second, slightly different logo after first paint.
    Image(
        painter = painterResource(R.drawable.nivora_brand_full),
        contentDescription = "Nivora",
        modifier = modifier
            .height(if (compact) 38.dp else 104.dp)
            .widthIn(max = if (compact) 132.dp else 240.dp),
        contentScale = ContentScale.Fit,
        alpha = if (onDark) 1f else .98f
    )
}

/** Static aurora pools provide a glass backdrop without a live blur pass. */
@Composable
fun AuroraBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val base = MaterialTheme.colorScheme.background
    val dark = MaterialTheme.colorScheme.surface.luminance() < .35f
    Box(
        modifier
            .background(
                Brush.verticalGradient(
                    if (dark) listOf(Color(0xFF070A18), Color(0xFF0B1230), Color(0xFF080B1B))
                    else listOf(Color(0xFFF7F9FF), Color(0xFFEEF3FF), Color(0xFFF9FAFF))
                )
            )
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawCircle(
                color = Color(0xFF6278FF).copy(alpha = if (dark) .25f else .15f),
                radius = size.minDimension * .66f,
                center = Offset(size.width * .95f, size.height * .08f)
            )
            drawCircle(
                color = Color(0xFF39D8FF).copy(alpha = if (dark) .15f else .10f),
                radius = size.minDimension * .54f,
                center = Offset(size.width * .08f, size.height * .55f)
            )
            drawCircle(
                color = Color(0xFFFF6B9B).copy(alpha = if (dark) .075f else .045f),
                radius = size.minDimension * .42f,
                center = Offset(size.width * .88f, size.height * .88f)
            )
            drawRect(base.copy(alpha = if (dark) .05f else .12f))
        }
        content()
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
    subscription: Subscription?,
    pingMs: Long?,
    pingBusy: Boolean,
    onToggle: () -> Unit,
    onPing: () -> Unit
) {
    val visualState = when (state) {
        "connected" -> ConnectionVisualState.Connected
        "connecting" -> ConnectionVisualState.Connecting
        "disconnecting" -> ConnectionVisualState.Disconnecting
        "error" -> ConnectionVisualState.Error
        else -> ConnectionVisualState.Disconnected
    }
    val glow by animateColorAsState(
        when (visualState) {
            ConnectionVisualState.Connected -> Color(0xFF45D9FF)
            ConnectionVisualState.Connecting -> Color(0xFF7B82FF)
            ConnectionVisualState.Disconnecting -> Color(0xFF6E8BBE)
            ConnectionVisualState.Error -> Color(0xFFFF6B8A)
            ConnectionVisualState.Disconnected -> Color(0xFF6976B8)
        },
        animationSpec = tween(420),
        label = "connection-glow"
    )
    val powerScale by animateFloatAsState(
        targetValue = if (visualState == ConnectionVisualState.Connected) 1.04f else 1f,
        animationSpec = tween(360),
        label = "connection-scale"
    )
    val shape = RoundedCornerShape(28.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(Color(0xE6161D3C), Color(0xD50B1634), Color(0xD8172442))
                )
            )
            .border(1.dp, Color.White.copy(.13f), shape)
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawCircle(glow.copy(.18f), radius = size.minDimension * .68f, center = Offset(size.width * .82f, size.height * .20f))
            drawCircle(Color(0xFF3DDCFF).copy(.07f), radius = size.minDimension * .50f, center = Offset(size.width * .10f, size.height * .95f))
        }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 17.dp, vertical = 15.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        subscription?.let { "${countryFlag(it.countryCode)}  ${it.locationName ?: it.planName}" }
                            ?: "اشتراک فعالی انتخاب نشده",
                        color = Color.White,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text("محافظت هوشمند Nivora", color = Color(0xFFB9C5EB), style = MaterialTheme.typography.labelMedium)
                }
                StatusPill(
                    label = when (visualState) {
                        ConnectionVisualState.Connected -> "متصل"
                        ConnectionVisualState.Connecting -> "در حال اتصال"
                        ConnectionVisualState.Disconnecting -> "در حال قطع"
                        ConnectionVisualState.Error -> "نیاز به تلاش دوباره"
                        ConnectionVisualState.Disconnected -> "آماده"
                    },
                    color = glow,
                    dark = true
                )
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    AnimatedContent(
                        targetState = visualState,
                        transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(150)) },
                        label = "connection-copy"
                    ) { target ->
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(
                                when (target) {
                                    ConnectionVisualState.Connected -> "اینترنت آزاد آماده است"
                                    ConnectionVisualState.Connecting -> "در حال پیدا کردن بهترین مسیر…"
                                    ConnectionVisualState.Disconnecting -> "در حال پایان اتصال…"
                                    ConnectionVisualState.Error -> "اتصال کامل نشد"
                                    ConnectionVisualState.Disconnected -> "برای شروع لمس کنید"
                                },
                                color = Color.White,
                                style = MaterialTheme.typography.titleLarge
                            )
                            Text(
                                when (target) {
                                    ConnectionVisualState.Connected -> "برای قطع اتصال، دکمه را لمس کنید"
                                    ConnectionVisualState.Connecting -> "برای لغو، دوباره دکمه را لمس کنید"
                                    ConnectionVisualState.Disconnecting -> "چند لحظه صبر کنید"
                                    ConnectionVisualState.Error -> error ?: "دوباره تلاش کنید"
                                    ConnectionVisualState.Disconnected -> "اتصال سریع و خودکار"
                                },
                                color = if (target == ConnectionVisualState.Error) Color(0xFFFFA9B9) else Color(0xFFB9C5EB),
                                style = MaterialTheme.typography.bodySmall,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        GlassMetric(Icons.Rounded.Speed, if (pingBusy) "…" else pingMs?.let { "$it ms" } ?: "تست سرعت", onPing)
                        GlassMetric(Icons.Rounded.Shield, "محافظت خودکار", null)
                    }
                }
                Spacer(Modifier.width(12.dp))
                Box(
                    modifier = Modifier
                        .size(84.dp)
                        .scale(powerScale)
                        .shadow(18.dp, CircleShape, ambientColor = glow.copy(.38f), spotColor = glow.copy(.38f))
                        .background(glow.copy(.15f), CircleShape)
                        .border(1.dp, glow.copy(.68f), CircleShape)
                        .padding(8.dp)
                        .background(
                            Brush.radialGradient(listOf(glow.copy(.74f), Color(0xFF172345))),
                            CircleShape
                        )
                        // Connecting is intentionally clickable: the same control
                        // doubles as an immediate cancel action.
                        .clickable(onClick = onToggle),
                    contentAlignment = Alignment.Center
                ) {
                    AnimatedContent(
                        targetState = visualState,
                        transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(130)) },
                        label = "connection-orb"
                    ) { target ->
                        when (target) {
                            ConnectionVisualState.Connecting -> ConnectingOrbGlyph(Modifier.size(54.dp), glow)
                            ConnectionVisualState.Disconnecting -> ConnectingOrbGlyph(Modifier.size(54.dp), glow)
                            ConnectionVisualState.Connected -> Icon(Icons.Rounded.Check, "قطع اتصال", tint = Color.White, modifier = Modifier.size(36.dp))
                            ConnectionVisualState.Error -> Icon(Icons.Rounded.Refresh, "تلاش دوباره", tint = Color.White, modifier = Modifier.size(34.dp))
                            ConnectionVisualState.Disconnected -> Icon(Icons.Rounded.PowerSettingsNew, "اتصال", tint = Color.White, modifier = Modifier.size(34.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun EmergencyConnectionButton(
    state: String,
    error: String?,
    available: Boolean,
    primaryActive: Boolean,
    onToggle: () -> Unit
) {
    val active = state == "connected"
    val busy = state == "connecting" || state == "disconnecting"
    val failed = state == "error"
    val accent by animateColorAsState(
        when {
            active -> Color(0xFFFFC857)
            busy -> Color(0xFFC79BFF)
            failed -> Color(0xFFFF7B9C)
            else -> Color(0xFF9CAEFF)
        },
        animationSpec = tween(320),
        label = "emergency-accent"
    )
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(
                Brush.linearGradient(
                    listOf(Color(0xB51A2041), Color(0xA8111732), accent.copy(alpha = .10f))
                )
            )
            .border(1.dp, accent.copy(alpha = if (active || busy) .48f else .24f), shape)
            .clickable(enabled = available || active || busy || failed, onClick = onToggle)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp)
    ) {
        Box(
            Modifier.size(42.dp).background(accent.copy(.14f), CircleShape).border(1.dp, accent.copy(.42f), CircleShape),
            contentAlignment = Alignment.Center
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(23.dp), color = accent, strokeWidth = 2.dp)
            else Icon(
                when {
                    active -> Icons.Rounded.StopCircle
                    failed -> Icons.Rounded.Refresh
                    else -> Icons.Rounded.Public
                },
                null,
                tint = accent,
                modifier = Modifier.size(23.dp)
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                when {
                    active -> "قطع اتصال اضطراری"
                    state == "connecting" -> "در حال یافتن مسیر اضطراری…"
                    state == "disconnecting" -> "در حال قطع اتصال اضطراری…"
                    failed -> "تلاش دوباره با اتصال اضطراری"
                    primaryActive -> "جایگزینی با اتصال اضطراری"
                    available -> "اتصال اضطراری"
                    else -> "اتصال اضطراری فعلاً آماده نیست"
                },
                color = Color.White,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold
            )
            Text(
                when {
                    active -> "مسیر عمومی موقت فعال است"
                    failed -> error ?: "مسیر سالمی پیدا نشد"
                    available -> "فقط زمانی که اتصال اصلی پاسخ نمی‌دهد"
                    else -> "پس از آماده‌شدن مسیرهای بررسی‌شده فعال می‌شود"
                },
                color = if (failed) Color(0xFFFFB4C6) else Color(0xFFAEBCE2),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        Icon(Icons.Rounded.ChevronLeft, null, tint = accent.copy(.88f), modifier = Modifier.size(22.dp))
    }
}

private enum class ConnectionVisualState { Disconnected, Connecting, Disconnecting, Connected, Error }

/** The only infinite animation in the hero, and it leaves composition when ready. */
@Composable
private fun ConnectingOrbGlyph(modifier: Modifier = Modifier, color: Color) {
    val transition = rememberInfiniteTransition(label = "connecting-orb")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1150), RepeatMode.Restart),
        label = "connecting-orb-phase"
    )
    Canvas(modifier) {
        val center = Offset(size.width / 2, size.height / 2)
        drawCircle(Color.White.copy(.10f), size.minDimension * .39f, center, style = Stroke(size.minDimension * .055f))
        drawArc(
            color = Color.White.copy(.94f),
            startAngle = phase * 360f - 90f,
            sweepAngle = 112f,
            useCenter = false,
            style = Stroke(width = size.minDimension * .07f, cap = StrokeCap.Round)
        )
        drawCircle(color.copy(.35f), size.minDimension * .20f, center)
        drawCircle(Color.White, size.minDimension * .07f, center)
    }
}

@Composable
private fun GlassMetric(icon: ImageVector, label: String, onClick: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White.copy(.075f))
            .border(1.dp, Color.White.copy(.08f), RoundedCornerShape(12.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Icon(icon, null, tint = Color(0xFF72DFFF), modifier = Modifier.size(16.dp))
        Text(label, color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1)
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
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = .76f))
            .border(
                width = if (selected) 1.2.dp else 1.dp,
                brush = if (selected) Brush.linearGradient(listOf(Color(0xFF667BFF), Color(0xFF45D9FF)))
                else Brush.linearGradient(listOf(MaterialTheme.colorScheme.outline.copy(.38f), MaterialTheme.colorScheme.outline.copy(.16f))),
                shape = shape
            )
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { onSelect(); expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    Modifier.size(42.dp).background(MaterialTheme.colorScheme.primary.copy(.10f), RoundedCornerShape(13.dp)),
                    contentAlignment = Alignment.Center
                ) { Text(countryFlag(subscription.countryCode), fontSize = 21.sp) }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(subscription.planName, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${subscription.locationName ?: "انتخاب خودکار"}  ·  ${if (subscription.startsOnFirstUse) "آماده شروع" else "${faNumber(subscription.remainingDays)} روز باقی‌مانده"}",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        "${faNumber(subscription.usagePercent)}٪",
                        color = if (progress > .85f) NivoraDanger else MaterialTheme.colorScheme.primary,
                        style = MaterialTheme.typography.labelLarge
                    )
                    if (selected) Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(6.dp).background(Color(0xFF45D9FF), CircleShape))
                        Spacer(Modifier.width(4.dp))
                        Text("فعال", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                    }
                }
                Spacer(Modifier.width(5.dp))
                Icon(
                    if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                    if (expanded) "بستن جزئیات" else "نمایش جزئیات",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(21.dp)
                )
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(animationSpec = tween(260)) + fadeIn(tween(210)),
                exit = shrinkVertically(animationSpec = tween(220)) + fadeOut(tween(150))
            ) {
                Column(Modifier.padding(top = 11.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${gb(subscription.usedBytes)} از ${gb(subscription.totalBytes)} گیگ مصرف شده", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("${faNumber(subscription.usagePercent)}٪", style = MaterialTheme.typography.labelMedium, color = if (progress > .85f) NivoraDanger else MaterialTheme.colorScheme.primary)
                    }
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxWidth().height(5.dp).clip(CircleShape),
                        color = if (progress > .85f) NivoraDanger else Color(0xFF5B7CFF),
                        trackColor = MaterialTheme.colorScheme.surfaceVariant.copy(.70f)
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SubscriptionMetric(Icons.Rounded.CalendarMonth, if (subscription.startsOnFirstUse) "شروع نشده" else "${faNumber(subscription.remainingDays)} روز")
                        SubscriptionMetric(Icons.Rounded.Devices, "${faNumber(subscription.deviceLimit)} دستگاه")
                        SubscriptionMetric(Icons.Rounded.DataUsage, "${faNumber(subscription.trafficGb)} گیگ")
                    }
                    if (subscription.routeCount > 1) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                            Text("بهینه‌سازی خودکار برای این اشتراک فعال است", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    Button(onClick = onRenew, modifier = Modifier.fillMaxWidth().height(40.dp)) {
                        Icon(Icons.Rounded.Autorenew, null, Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)); Text("تمدید اشتراک")
                    }
                }
            }
        }
    }
}

@Composable
private fun RowScope.SubscriptionMetric(icon: ImageVector, value: String) {
    Column(
        modifier = Modifier.weight(1f).background(MaterialTheme.colorScheme.surfaceVariant.copy(.68f), RoundedCornerShape(13.dp)).padding(vertical = 9.dp),
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
        Box(Modifier.background(Brush.linearGradient(listOf(NivoraInk, Color(0xFF102A5A))))) {
            Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(45.dp).background(Color.White.copy(.1f), RoundedCornerShape(15.dp)), contentAlignment = Alignment.Center) {
                        Icon(Icons.Rounded.AccountBalanceWallet, null, tint = NivoraGreen)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("موجودی کیف پول", color = Color(0xFFB9CBE8), style = MaterialTheme.typography.bodyMedium)
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
    ) { Text(label, color = if (dark && color == NivoraGreen) Color(0xFFA9EDFF) else color, style = MaterialTheme.typography.labelMedium) }
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
    AuroraBackground(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Spacer(Modifier.height(12.dp))
            Box(
                Modifier.fillMaxWidth(.54f).height(22.dp)
                    .background(MaterialTheme.colorScheme.surface.copy(.72f), RoundedCornerShape(11.dp))
            )
            Box(
                Modifier.fillMaxWidth().height(206.dp)
                    .background(MaterialTheme.colorScheme.surface.copy(.68f), RoundedCornerShape(28.dp))
                    .border(1.dp, MaterialTheme.colorScheme.outline.copy(.20f), RoundedCornerShape(28.dp))
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(2) {
                    Box(
                        Modifier.weight(1f).height(88.dp)
                            .background(MaterialTheme.colorScheme.surface.copy(.58f), RoundedCornerShape(22.dp))
                    )
                }
            }
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(.28f).align(Alignment.CenterHorizontally).clip(CircleShape),
                color = NivoraGreen,
                trackColor = MaterialTheme.colorScheme.surfaceVariant.copy(.45f)
            )
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
