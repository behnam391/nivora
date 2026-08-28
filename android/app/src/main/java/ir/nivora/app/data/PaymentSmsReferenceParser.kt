package ir.nivora.app.data

/**
 * Extracts a bank-provided payment reference from the one SMS message that the
 * customer explicitly shares through Android's SMS User Consent dialog.
 *
 * Deliberately do not guess from unrelated long numbers: an amount, card
 * number, balance, or phone number must never silently become a payment
 * reference. The manual field remains available for bank message formats that
 * do not label their reference.
 */
object PaymentSmsReferenceParser {
    private val labeledReference = Regex(
        pattern = """(?:شماره|کد)?\s*(?:پیگیری|رهگیری|شناسه|مرجع|سند)(?:\s*(?:واریز|تراکنش|پرداخت))?\s*[:：#=\-]?\s*([0-9]{6,20})(?![0-9])|(?:reference|ref|trace|tracking)(?:\s*(?:number|no|id))?\s*[:#=\-]?\s*([0-9]{6,20})(?![0-9])""",
        option = RegexOption.IGNORE_CASE
    )

    fun extract(message: String): String? {
        val normalized = normalizeDigits(message)
            .replace('\u200c', ' ')
            .replace('\u200f', ' ')
            .replace('\u202b', ' ')

        return labeledReference.findAll(normalized)
            .mapNotNull { match ->
                match.groupValues.drop(1)
                    .firstOrNull(String::isNotBlank)
                    ?.takeIf { value -> value.length in 6..20 && value.all(Char::isDigit) }
            }
            .firstOrNull()
    }

    internal fun normalizeDigits(value: String): String = buildString(value.length) {
        value.forEach { character ->
            append(
                when (character) {
                    in '۰'..'۹' -> '0' + (character - '۰')
                    in '٠'..'٩' -> '0' + (character - '٠')
                    else -> character
                }
            )
        }
    }
}
