package ir.nivora.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ir.nivora.app.data.Subscription
import kotlin.math.cos
import kotlin.math.sin

/** Orbit is rendered only while negotiating; idle and connected screens do not run a clock. */
@Composable
fun ConnectionHero(state:String,error:String?,subscription:Subscription?,pingMs:Long?,pingBusy:Boolean,onToggle:()->Unit,onPing:()->Unit) {
    val busy = state=="connecting" || state=="disconnecting"
    val connected = state=="connected"
    val failed = state=="error"
    val accent by animateColorAsState(if(failed) Color(0xFFFF8094) else if(connected) Color(0xFFA9F0D1) else Color(0xFFB8ACFF),tween(350),label="orbit-color")
    val progress by animateFloatAsState(if(connected) 1f else 0f,tween(650),label="orbit-lock")
    val phase = if(busy) orbitPhase() else 0f
    val title = when(state) { "connected"->"متصل هستید";"connecting"->"در حال اتصال";"disconnecting"->"در حال قطع اتصال";"error"->"دوباره تلاش کنیم";else->"یک لمس تا اتصال" }
    val action = when(state) {"connected"->"قطع اتصال";"connecting"->"لغو اتصال";"disconnecting"->"در حال قطع";"error"->"تلاش دوباره";else->"اتصال"}
    Column(Modifier.fillMaxWidth(),horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Text("PRIVATE CONNECTION",color=MaterialTheme.colorScheme.onSurfaceVariant,style=MaterialTheme.typography.labelSmall,letterSpacing=3.sp)
        Box(Modifier.size(168.dp),contentAlignment=Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val r=size.minDimension*.43f
                drawCircle(Brush.radialGradient(listOf(accent.copy(.13f),Color.Transparent),center,r*1.17f),r*1.17f)
                repeat(60) { index ->
                    val angle=(index*6-90)*Math.PI/180
                    val lit=connected && index < (progress*60).toInt()
                    val outer=r*(if(index%5==0)1.02f else 1f)
                    drawLine(if(lit)accent.copy(.65f) else accent.copy(.18f),
                        center+Offset((cos(angle)*r*.94).toFloat(),(sin(angle)*r*.94).toFloat()),
                        center+Offset((cos(angle)*outer).toFloat(),(sin(angle)*outer).toFloat()),1.6.dp.toPx(),StrokeCap.Round)
                }
                drawCircle(accent.copy(.12f),r*.81f,style=Stroke(1.dp.toPx()))
                if(busy) {
                    rotate(phase*360) {
                        drawArc(Brush.sweepGradient(listOf(Color.Transparent,accent.copy(.15f),accent)),0f,285f,false,
                            topLeft=center-Offset(r*.82f,r*.82f),size=androidx.compose.ui.geometry.Size(r*1.64f,r*1.64f),style=Stroke(2.5.dp.toPx(),cap=StrokeCap.Round))
                        drawCircle(accent,3.dp.toPx(),center+Offset(r*.82f,0f))
                    }
                    rotate(-phase*360) {
                        drawArc(accent.copy(.4f),25f,90f,false,topLeft=center-Offset(r*1.1f,r*1.1f),size=androidx.compose.ui.geometry.Size(r*2.2f,r*2.2f),style=Stroke(1.dp.toPx(),cap=StrokeCap.Round))
                    }
                }
            }
            Column(Modifier.size(104.dp).clip(CircleShape)
                .background(Brush.verticalGradient(listOf(Color(0xFF302D45),Color(0xFF191923))))
                .border(1.dp,accent.copy(.35f),CircleShape)
                .clickable(role=Role.Button,onClickLabel=action,onClick=onToggle),
                horizontalAlignment=Alignment.CenterHorizontally,verticalArrangement=Arrangement.Center) {
                Icon(when {connected->Icons.Rounded.Check;busy->Icons.Rounded.Close;failed->Icons.Rounded.Refresh;else->Icons.Rounded.PowerSettingsNew},action,tint=accent,modifier=Modifier.size(38.dp))
                Spacer(Modifier.height(8.dp))
                Text(action,color=accent,style=MaterialTheme.typography.labelMedium)
            }
        }
        Text(title,style=MaterialTheme.typography.headlineMedium,fontWeight=FontWeight.Bold)
        Text(when {failed->error?:"اتصال برقرار نشد؛ دوباره امتحان کنید";busy->"با لمس مرکز می‌توانید اتصال را لغو کنید";connected->"برای پایان، مرکز حلقه را لمس کنید";else->"مسیر مناسب، به‌صورت خودکار"},
            color=MaterialTheme.colorScheme.onSurfaceVariant,style=MaterialTheme.typography.bodySmall,textAlign=TextAlign.Center,maxLines=2,overflow=TextOverflow.Ellipsis)
        Spacer(Modifier.height(2.dp))
        Surface(shape=RoundedCornerShape(18.dp),color=MaterialTheme.colorScheme.surface, border=androidx.compose.foundation.BorderStroke(1.dp,MaterialTheme.colorScheme.outline.copy(.35f))) {
            Row(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=11.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                Text(subscription?.let{countryFlag(it.countryCode)}?:"◎",fontSize=22.sp)
                Column(Modifier.weight(1f)) {
                    Text(subscription?.locationName?:subscription?.planName?:"اشتراک انتخاب نشده",style=MaterialTheme.typography.labelLarge,maxLines=1,overflow=TextOverflow.Ellipsis)
                    Text(if(connected)"اتصال فعال" else "مقصد انتخاب‌شده",style=MaterialTheme.typography.labelSmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick=onPing,enabled=!pingBusy) {
                    Icon(Icons.Rounded.Speed,null,Modifier.size(17.dp));Spacer(Modifier.width(4.dp))
                    Text(if(pingBusy)"…" else pingMs?.let{"$it ms"}?:"پینگ",maxLines=1)
                }
            }
        }
    }
}

@Composable
private fun orbitPhase():Float {
    val motion=rememberInfiniteTransition(label="orbit")
    val phase by motion.animateFloat(0f,1f,infiniteRepeatable(tween(1900,easing=LinearEasing)),label="orbit-phase")
    return phase
}
