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

// Kept under the old names so the app stays consistent internally. The visual
// language is now midnight / electric violet rather than the previous green UI.
val NivoraGreen = Color(0xFF8E7CFF)
val NivoraGreenDark = Color(0xFF6754E8)
val NivoraInk = Color(0xFF0C0A1C)
val NivoraInkSoft = Color(0xFF1B1738)
val NivoraMint = Color(0xFFF0EEFF)
val NivoraBackground = Color(0xFFF8F7FF)
val NivoraLine = Color(0xFFE2DFFF)
val NivoraMuted = Color(0xFF6F6A86)
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
    surfaceVariant = Color(0xFFF0EFF8),
    onSurfaceVariant = NivoraMuted,
    outline = NivoraLine,
    error = NivoraDanger
)

private val DarkColors = darkColorScheme(
    primary = NivoraGreen,
    onPrimary = NivoraInk,
    primaryContainer = NivoraInkSoft,
    onPrimaryContainer = Color(0xFFE8E4FF),
    secondary = Color(0xFF62D4FF),
    onSecondary = NivoraInk,
    background = Color(0xFF0A0916),
    onBackground = Color(0xFFF0EFFF),
    surface = Color(0xFF151229),
    onSurface = Color(0xFFF0EFFF),
    surfaceVariant = Color(0xFF211D3D),
    onSurfaceVariant = Color(0xFFB6B0CC),
    outline = Color(0xFF393358),
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
