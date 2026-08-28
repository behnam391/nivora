package ir.nivora.app.ui

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import ir.nivora.app.data.PaymentSmsReferenceParser

internal data class PaymentSmsConsentUiState(
    val status: String,
    val listening: Boolean,
    val retry: () -> Unit
)

/**
 * Listens only for the next eligible SMS for five minutes. Android/Google Play
 * services always shows a consent sheet containing that message before its
 * body is exposed to Nivora. No READ_SMS or RECEIVE_SMS permission is used.
 */
@Composable
internal fun rememberPaymentSmsConsent(
    onReference: (String) -> Unit
): PaymentSmsConsentUiState {
    val context = LocalContext.current
    val currentOnReference by rememberUpdatedState(onReference)
    var status by remember { mutableStateOf("منتظر پیامک جدید بانک هستیم؛ برای خواندن همان یک پیامک از شما اجازه گرفته می‌شود.") }
    var listening by remember { mutableStateOf(false) }
    var listenAttempt by remember { mutableIntStateOf(0) }

    val consentLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        listening = false
        if (result.resultCode != Activity.RESULT_OK) {
            status = "خواندن پیامک لغو شد؛ شناسه را دستی وارد کنید یا دوباره تلاش کنید."
            return@rememberLauncherForActivityResult
        }

        val message = result.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE).orEmpty()
        val reference = PaymentSmsReferenceParser.extract(message)
        if (reference == null) {
            status = "پیامک دریافت شد، اما شناسه مشخصی در آن پیدا نشد؛ آن را دستی وارد کنید."
        } else {
            currentOnReference(reference)
            status = "شناسه واریز از پیامک تأییدشده وارد شد."
        }
    }

    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() {
            @Suppress("DEPRECATION")
            override fun onReceive(receiverContext: Context, intent: Intent) {
                if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                val resultStatus = intent.getParcelableExtra<Status>(SmsRetriever.EXTRA_STATUS)
                when (resultStatus?.statusCode) {
                    CommonStatusCodes.SUCCESS -> {
                        listening = false
                        val consentIntent = intent.getParcelableExtra<Intent>(SmsRetriever.EXTRA_CONSENT_INTENT)
                        if (consentIntent == null) {
                            status = "امکان نمایش تأیید پیامک نبود؛ شناسه را دستی وارد کنید."
                        } else {
                            status = "پیامک بانکی رسید؛ متن نمایش‌داده‌شده را برای ورود شناسه تأیید کنید."
                            consentLauncher.launch(consentIntent)
                        }
                    }
                    CommonStatusCodes.TIMEOUT -> {
                        listening = false
                        status = "در پنج دقیقه گذشته پیامک بانکی دریافت نشد؛ برای تلاش دوباره بزنید."
                    }
                }
            }
        }
        val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
        // Google Play services is an external trusted sender, so the receiver
        // must be exported while still being protected by SEND_PERMISSION.
        ContextCompat.registerReceiver(
            context,
            receiver,
            filter,
            SmsRetriever.SEND_PERMISSION,
            null,
            ContextCompat.RECEIVER_EXPORTED
        )
        onDispose { runCatching { context.unregisterReceiver(receiver) } }
    }

    LaunchedEffect(context, listenAttempt) {
        listening = true
        status = "منتظر پیامک جدید بانک هستیم؛ برای خواندن همان یک پیامک از شما اجازه گرفته می‌شود."
        SmsRetriever.getClient(context)
            .startSmsUserConsent(null)
            .addOnFailureListener {
                listening = false
                status = "خواندن امن پیامک روی این گوشی در دسترس نیست؛ شناسه را دستی وارد کنید."
            }
    }

    return PaymentSmsConsentUiState(
        status = status,
        listening = listening,
        retry = { listenAttempt += 1 }
    )
}
