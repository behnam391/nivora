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

// Legacy variable names are retained to avoid a noisy mechanical rewrite.
// Their values now follow the final Nivora artwork: midnight, cobalt, cyan and silver.
val NivoraGreen = Color(0xFF38D9FF)
val NivoraGreenDark = Color(0xFF2563EB)
val NivoraInk = Color(0xFF050816)
val NivoraInkSoft = Color(0xFF0D1733)
val NivoraMint = Color(0xFFEAF7FF)
val NivoraBackground = Color(0xFFF4F8FF)
val NivoraLine = Color(0xFFCADAF4)
val NivoraMuted = Color(0xFF61708F)
val NivoraDanger = Color(0xFFFF5C78)
val NivoraWarning = Color(0xFFFFB547)

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
    surfaceVariant = Color(0xFFEAF1FB),
    onSurfaceVariant = NivoraMuted,
    outline = NivoraLine,
    error = NivoraDanger
)

private val DarkColors = darkColorScheme(
    primary = NivoraGreen,
    onPrimary = NivoraInk,
    primaryContainer = NivoraInkSoft,
    onPrimaryContainer = Color(0xFFEAF7FF),
    secondary = Color(0xFF62D4FF),
    onSecondary = NivoraInk,
    background = Color(0xFF050816),
    onBackground = Color(0xFFF0F7FF),
    surface = Color(0xFF0D1733),
    onSurface = Color(0xFFF0F7FF),
    surfaceVariant = Color(0xFF16254A),
    onSurfaceVariant = Color(0xFFB5C6E3),
    outline = Color(0xFF31466E),
    error = Color(0xFFFF7C91)
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
