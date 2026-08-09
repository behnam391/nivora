package ir.nivora.app

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import ir.nivora.app.data.*
import ir.nivora.app.vpn.NivoraVpnService
import java.text.NumberFormat
import java.util.Locale

class MainActivity : Activity() {
    private val api = ApiClient(BuildConfig.API_BASE_URL)
    private val main = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("session", 0) }
    private val money = NumberFormat.getNumberInstance(Locale("fa", "IR"))

    override fun onCreate(state: Bundle?) { super.onCreate(state); if (prefs.getString("token", null) == null) showLogin() else loadAccount() }
    private fun root() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(42, 42, 42, 42); gravity = Gravity.CENTER_HORIZONTAL; layoutDirection = View.LAYOUT_DIRECTION_RTL; setBackgroundColor(Color.rgb(245, 247, 246)) }
    private fun input(hint: String, password: Boolean = false) = EditText(this).apply { this.hint = hint; textSize = 17f; if (password) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
    private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setTextColor(Color.rgb(4, 45, 32)); setBackgroundColor(Color.rgb(32, 212, 154)); setOnClickListener { action() } }
    private fun wide() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 8, 0, 8) }
    private fun title(value: String) = TextView(this).apply { text = value; textSize = 27f; setTextColor(Color.rgb(7, 75, 55)); setPadding(0, 18, 0, 18) }
    private fun text(value: String) = TextView(this).apply { text = value; textSize = 16f }

    private fun showLogin(message: String? = null) {
        val box = root(); box.addView(title("Nivora")); box.addView(text("ورود به حساب مشتری"))
        val phone = input("شماره موبایل"); val pass = input("رمز عبور", true); val error = text(message ?: "").apply { setTextColor(Color.RED) }
        box.addView(phone, wide()); box.addView(pass, wide()); box.addView(error, wide())
        box.addView(button("ورود") { error.text = "در حال ورود…"; background(work = { api.login(phone.text.toString(), pass.text.toString()) }, success = { prefs.edit().putString("token", it.token).apply(); loadAccount() }, failure = { error.text = friendly(it) }) }, wide())
        box.addView(button("ساخت حساب جدید") { showRegister() }, wide())
        box.addView(button("رمز عبور را فراموش کرده‌ام") { showRecovery(phone.text.toString()) }, wide())
        setContentView(box)
    }

    private fun showRegister() {
        val box = root(); box.addView(title("ثبت‌نام در Nivora")); val name = input("نام و نام خانوادگی"); val phone = input("شماره موبایل"); val pass = input("رمز عبور (حداقل ۸ کاراکتر)", true); val error = text("").apply { setTextColor(Color.RED) }
        listOf(name, phone, pass, error).forEach { box.addView(it, wide()) }
        box.addView(button("ثبت‌نام") { error.text = "در حال ساخت حساب…"; background(work = { api.register(name.text.toString(), phone.text.toString(), pass.text.toString()) }, success = { prefs.edit().putString("token", it.token).apply(); loadAccount() }, failure = { error.text = friendly(it) }) }, wide())
        box.addView(button("بازگشت به ورود") { showLogin() }, wide()); setContentView(box)
    }

    private fun showRecovery(initialPhone: String) {
        val phone = input("شماره موبایل").apply { setText(initialPhone) }
        AlertDialog.Builder(this).setTitle("بازیابی رمز عبور").setMessage("درخواست برای مدیر ارسال می‌شود و پس از احراز هویت، رمز جدید دریافت می‌کنید.").setView(phone)
            .setPositiveButton("ثبت درخواست") { _, _ -> background(work = { api.requestPasswordReset(phone.text.toString()); true }, success = { toast("درخواست بازیابی ثبت شد") }, failure = { toast(friendly(it)) }) }
            .setNegativeButton("انصراف", null).show()
    }

    private fun loadAccount() {
        val loading = root(); loading.addView(ProgressBar(this)); setContentView(loading); val token = prefs.getString("token", "")!!
        background(work = { api.account(token) to api.plans() }, success = { showHome(it.first, it.second) }, failure = { prefs.edit().clear().apply(); showLogin(friendly(it)) })
    }

    private fun showHome(account: Account, plans: List<Plan>) {
        val scroll = ScrollView(this); val box = root().apply { gravity = Gravity.TOP }; val token = prefs.getString("token", "")!!
        box.addView(title("سلام ${account.name}")); box.addView(text("موجودی کیف پول: ${money.format(account.balanceToman)} تومان"), wide())
        box.addView(button("اتصال امن") { prepareVpn() }, wide()); box.addView(title("اشتراک‌های من"))
        if (account.subscriptions.isEmpty()) box.addView(text("هنوز اشتراکی ندارید.")) else account.subscriptions.forEach { subscription ->
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(Color.WHITE); addView(text("${subscription.planName}\nوضعیت: ${subscription.status}")); if (subscription.url != null) addView(button("کپی لینک اشتراک") { copy(subscription.url); toast("لینک اشتراک کپی شد") }, wide()) }
            box.addView(card, wide())
        }
        box.addView(title("خرید و ساخت اشتراک")); plans.forEach { plan ->
            val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24); setBackgroundColor(Color.WHITE); addView(text("${plan.name}\n${plan.trafficGb} گیگ · ${plan.durationDays} روز · ${plan.deviceLimit} دستگاه\n${money.format(plan.priceToman)} تومان")); addView(button("خرید و ساخت فوری") { confirmPurchase(token, plan) }, wide()) }
            box.addView(card, wide())
        }
        box.addView(button("خروج") { prefs.edit().clear().apply(); showLogin() }, wide()); scroll.addView(box); setContentView(scroll)
    }

    private fun confirmPurchase(token: String, plan: Plan) {
        AlertDialog.Builder(this).setTitle("تأیید خرید ${plan.name}").setMessage("${money.format(plan.priceToman)} تومان از کیف پول کم و اشتراک فوراً ساخته می‌شود.")
            .setPositiveButton("خرید") { _, _ -> background(work = { api.purchase(token, plan.id) }, success = { toast("اشتراک با موفقیت ساخته شد"); loadAccount() }, failure = { toast(friendly(it)) }) }.setNegativeButton("انصراف", null).show()
    }

    private fun friendly(error: Throwable) = when (error.message) { "INVALID_CREDENTIALS" -> "شماره موبایل یا رمز عبور صحیح نیست"; "PHONE_ALREADY_EXISTS" -> "این شماره قبلاً ثبت شده است"; "WEAK_PASSWORD" -> "رمز باید حداقل ۸ کاراکتر باشد"; "INSUFFICIENT_BALANCE" -> "موجودی کیف پول کافی نیست"; "NO_CAPACITY" -> "ظرفیت این پلن تکمیل است"; else -> error.message ?: "خطا در ارتباط" }
    private fun <T> background(work: () -> T, success: (T) -> Unit, failure: (Throwable) -> Unit) = Thread { runCatching(work).onSuccess { main.post { success(it) } }.onFailure { main.post { failure(it) } } }.start()
    private fun toast(value: String) = Toast.makeText(this, value, Toast.LENGTH_LONG).show()
    private fun copy(value: String) { (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Nivora subscription", value)) }
    private fun prepareVpn() { val intent = VpnService.prepare(this); if (intent != null) startActivityForResult(intent, 91) else startVpn() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) { super.onActivityResult(requestCode, resultCode, data); if (requestCode == 91 && resultCode == RESULT_OK) startVpn() }
    private fun startVpn() { startForegroundService(Intent(this, NivoraVpnService::class.java)); toast("پوسته VPN فعال شد؛ موتور Xray در نسخه بعد متصل می‌شود.") }
}
