package ir.nivora.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val NivoraGreen = Color(0xFF22D49B)
val NivoraGreenDark = Color(0xFF0BA579)
val NivoraInk = Color(0xFF071C16)
val NivoraInkSoft = Color(0xFF12372C)
val NivoraMint = Color(0xFFE9FAF4)
val NivoraBackground = Color(0xFFF5F8F7)
val NivoraLine = Color(0xFFDCE8E4)
val NivoraMuted = Color(0xFF667C74)
val NivoraDanger = Color(0xFFE44F5A)
val NivoraWarning = Color(0xFFF0A836)

private val LightColors = lightColorScheme(
    primary = NivoraGreenDark,
    onPrimary = Color.White,
    primaryContainer = NivoraMint,
    onPrimaryContainer = NivoraInk,
    secondary = NivoraGreen,
    onSecondary = NivoraInk,
    background = NivoraBackground,
    onBackground = NivoraInk,
    surface = Color.White,
    onSurface = NivoraInk,
    surfaceVariant = Color(0xFFEDF3F1),
    onSurfaceVariant = NivoraMuted,
    outline = NivoraLine,
    error = NivoraDanger
)

private val DarkColors = darkColorScheme(
    primary = NivoraGreen,
    onPrimary = NivoraInk,
    primaryContainer = NivoraInkSoft,
    onPrimaryContainer = Color(0xFFD9FFF1),
    secondary = Color(0xFF68E6BC),
    onSecondary = NivoraInk,
    background = Color(0xFF06120F),
    onBackground = Color(0xFFE5F2ED),
    surface = Color(0xFF0D211B),
    onSurface = Color(0xFFE5F2ED),
    surfaceVariant = Color(0xFF173129),
    onSurfaceVariant = Color(0xFFA8BDB5),
    outline = Color(0xFF29483E),
    error = Color(0xFFFF7C84)
)

private val NivoraTypography = Typography(
    displaySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Black, fontSize = 34.sp),
    headlineLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 28.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 23.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 20.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
)

val NivoraShapes = androidx.compose.material3.Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(28.dp),
    extraLarge = RoundedCornerShape(34.dp)
)

@Composable
fun NivoraTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = NivoraTypography,
        shapes = NivoraShapes,
        content = content
    )
}
