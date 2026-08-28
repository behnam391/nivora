package ir.nivora.app.data

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

class ReceiptTooLargeException : IOException("Receipt exceeds the upload limit")

object ReceiptUploadPolicy {
    const val MAX_BYTES: Int = 4 * 1024 * 1024

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
}
