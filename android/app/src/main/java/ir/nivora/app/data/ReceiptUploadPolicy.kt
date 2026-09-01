package ir.nivora.app.data

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

class ReceiptTooLargeException : IOException("Receipt exceeds the upload limit")
data class PreparedReceipt(val bytes: ByteArray, val mimeType: String = "image/jpeg")

object ReceiptUploadPolicy {
    const val MAX_BYTES: Int = 4 * 1024 * 1024
    private const val MAX_EDGE = 1800
    private const val MAX_SOURCE_BYTES = 30L * 1024 * 1024

    private val allowedMimeTypes = setOf(
        "image/jpeg",
        "image/png",
        "image/webp"
    )

    fun acceptedMimeType(raw: String?): String? {
        val normalized = raw
            ?.substringBefore(';')
            ?.trim()
            ?.lowercase(Locale.US)
            .orEmpty()
        return normalized.takeIf(allowedMimeTypes::contains)
    }

    fun readBounded(input: InputStream, maximumBytes: Int = MAX_BYTES): ByteArray {
        require(maximumBytes > 0)
        val output = ByteArrayOutputStream(minOf(maximumBytes, 64 * 1024))
        val buffer = ByteArray(8 * 1024)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > maximumBytes) throw ReceiptTooLargeException()
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    /** Decode any image Android supports (including HEIC), resize it and emit
     * a small, predictable JPEG. The original gallery/camera file is untouched. */
    fun prepare(resolver: ContentResolver, uri: Uri): PreparedReceipt {
        resolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
            if (descriptor.length > MAX_SOURCE_BYTES) throw ReceiptTooLargeException()
        }
        val decoded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                val width = info.size.width
                val height = info.size.height
                if (width <= 0 || height <= 0 || width.toLong() * height > 120_000_000L) throw IOException("Invalid image dimensions")
                val scale = minOf(1f, MAX_EDGE.toFloat() / maxOf(width, height))
                if (scale < 1f) decoder.setTargetSize((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > 120_000_000L) throw IOException("Invalid image dimensions")
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE * 2) sample *= 2
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
                ?: throw IOException("Image cannot be decoded")
        }
        val flattened = Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.ARGB_8888)
        Canvas(flattened).apply { drawColor(Color.WHITE); drawBitmap(decoded, 0f, 0f, null) }
        if (flattened !== decoded) decoded.recycle()
        var quality = 88
        var bytes: ByteArray
        do {
            val output = ByteArrayOutputStream()
            if (!flattened.compress(Bitmap.CompressFormat.JPEG, quality, output)) throw IOException("Image compression failed")
            bytes = output.toByteArray()
            quality -= 8
        } while (bytes.size > 2_500_000 && quality >= 56)
        flattened.recycle()
        if (bytes.isEmpty() || bytes.size > MAX_BYTES) throw ReceiptTooLargeException()
        return PreparedReceipt(bytes)
    }
}
