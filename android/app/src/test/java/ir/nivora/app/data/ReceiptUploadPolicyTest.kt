package ir.nivora.app.data

import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReceiptUploadPolicyTest {
    @Test
    fun acceptsOnlySupportedImageMimeTypes() {
        assertEquals("image/jpeg", ReceiptUploadPolicy.acceptedMimeType("IMAGE/JPEG; charset=binary"))
        assertEquals("image/png", ReceiptUploadPolicy.acceptedMimeType("image/png"))
        assertEquals("image/webp", ReceiptUploadPolicy.acceptedMimeType("image/webp"))
        assertNull(ReceiptUploadPolicy.acceptedMimeType("image/svg+xml"))
        assertNull(ReceiptUploadPolicy.acceptedMimeType("application/pdf"))
    }

    @Test
    fun boundedReaderReturnsInputWithinLimit() {
        val source = ByteArray(128) { it.toByte() }

        assertArrayEquals(source, ReceiptUploadPolicy.readBounded(ByteArrayInputStream(source), 128))
    }

    @Test(expected = ReceiptTooLargeException::class)
    fun boundedReaderStopsAfterLimit() {
        ReceiptUploadPolicy.readBounded(ByteArrayInputStream(ByteArray(129)), 128)
    }
}
