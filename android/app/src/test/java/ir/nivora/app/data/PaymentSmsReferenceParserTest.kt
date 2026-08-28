package ir.nivora.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PaymentSmsReferenceParserTest {
    @Test
    fun extractsPersianTrackingNumberAndNormalizesDigits() {
        val message = "واریز موفق مبلغ ۱٬۵۰۰٬۰۰۰ ریال\nشماره پیگیری: ۱۲۳۴۵۶۷۸۹"

        assertEquals("123456789", PaymentSmsReferenceParser.extract(message))
    }

    @Test
    fun rejectsAlphanumericReferenceThatBackendCannotCanonicalize() {
        val message = "Payment completed. Reference ID: AB12-XY90"

        assertNull(PaymentSmsReferenceParser.extract(message))
    }

    @Test
    fun doesNotGuessFromAmountCardOrPhoneNumbers() {
        val message = "برداشت 250000 ریال از کارت 6219861915944697 مانده 980000 تماس 09121234567"

        assertNull(PaymentSmsReferenceParser.extract(message))
    }

    @Test
    fun rejectsReferenceOutsideBackendLengthBounds() {
        assertNull(PaymentSmsReferenceParser.extract("شماره پیگیری: 123"))
        assertNull(PaymentSmsReferenceParser.extract("شناسه واریز: 12345"))
        assertNull(PaymentSmsReferenceParser.extract("شناسه واریز: 123456789012345678901"))
    }

    @Test
    fun acceptsSixDigitBankTraceWhileRejectingGuessableShortValues() {
        assertEquals("554433", PaymentSmsReferenceParser.extract("کد رهگیری ۵۵۴۴۳۳"))
        assertNull(PaymentSmsReferenceParser.extract("کد پیگیری 7788"))
    }
}
