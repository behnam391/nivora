package ir.nivora.app
import android.app.Activity
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
import ir.nivora.app.data.Account
import ir.nivora.app.data.ApiClient
import ir.nivora.app.data.Plan
import ir.nivora.app.vpn.NivoraVpnService

class MainActivity:Activity(){
    private val api=ApiClient(BuildConfig.API_BASE_URL);private val main=Handler(Looper.getMainLooper());private val prefs by lazy{getSharedPreferences("session",0)}
    override fun onCreate(state:Bundle?){super.onCreate(state);window.statusBarColor=Color.rgb(7,25,20);if(prefs.getString("token",null)==null)showLogin()else loadAccount()}
    private fun root()=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;setPadding(42,42,42,42);gravity=Gravity.CENTER_HORIZONTAL;layoutDirection=View.LAYOUT_DIRECTION_RTL;setBackgroundColor(Color.rgb(245,247,246))}
    private fun title(text:String)=TextView(this).apply{this.text=text;textSize=27f;setTextColor(Color.rgb(7,75,55));setPadding(0,18,0,18)}
    private fun input(hint:String,password:Boolean=false)=EditText(this).apply{this.hint=hint;textSize=17f;if(password)inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD}
    private fun button(text:String,click:()->Unit)=Button(this).apply{this.text=text;setTextColor(Color.rgb(4,45,32));setBackgroundColor(Color.rgb(32,212,154));setOnClickListener{click()}}
    private fun showLogin(message:String?=null){
        val box=root();box.addView(title("Nivora"));box.addView(TextView(this).apply{text="ورود به حساب مشتری";textSize=18f})
        val phone=input("شماره موبایل");val pass=input("رمز عبور",true);val error=TextView(this).apply{setTextColor(Color.RED);text=message?:""}
        box.addView(phone,wide());box.addView(pass,wide());box.addView(error,wide());box.addView(button("ورود"){error.text="در حال ورود…";Thread{runCatching{api.login(phone.text.toString(),pass.text.toString())}.onSuccess{prefs.edit().putString("token",it.token).apply();main.post{loadAccount()}}.onFailure{main.post{error.text=it.message}}}.start()},wide());setContentView(box)
    }
    private fun loadAccount(){val box=root();box.addView(ProgressBar(this));setContentView(box);val token=prefs.getString("token","")!!;Thread{runCatching{api.account(token) to api.plans()}.onSuccess{main.post{showHome(it.first,it.second)}}.onFailure{prefs.edit().clear().apply();main.post{showLogin(it.message)}}}.start()}
    private fun showHome(account:Account,plans:List<Plan>){val scroll=ScrollView(this);val box=root();box.gravity=Gravity.TOP;box.addView(title("سلام ${account.name}"));box.addView(TextView(this).apply{text="موجودی کیف پول: ${account.balanceToman} تومان";textSize=18f;setPadding(0,0,0,20)});box.addView(button("اتصال امن"){prepareVpn()},wide());box.addView(section("اشتراک‌های من"));if(account.subscriptions.isEmpty())box.addView(text("هنوز اشتراکی ندارید.")) else account.subscriptions.forEach{box.addView(card("${it.planName}\nوضعیت: ${it.status}"))};box.addView(section("پلن‌های قابل خرید"));plans.forEach{box.addView(card("${it.name}\n${it.trafficGb} گیگ · ${it.durationDays} روز · ${it.priceToman} تومان"))};box.addView(button("خروج"){prefs.edit().clear().apply();showLogin()},wide());scroll.addView(box);setContentView(scroll)}
    private fun prepareVpn(){val intent=VpnService.prepare(this);if(intent!=null)startActivityForResult(intent,91)else startVpn()}
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){super.onActivityResult(requestCode,resultCode,data);if(requestCode==91&&resultCode==RESULT_OK)startVpn()}
    private fun startVpn(){startForegroundService(Intent(this,NivoraVpnService::class.java));Toast.makeText(this,"پوسته VPN فعال شد؛ موتور Xray در مرحله بعد متصل می‌شود.",Toast.LENGTH_LONG).show()}
    private fun section(s:String)=TextView(this).apply{text=s;textSize=21f;setTextColor(Color.rgb(9,93,68));setPadding(0,28,0,10)}
    private fun text(s:String)=TextView(this).apply{text=s;textSize=16f}
    private fun card(s:String)=TextView(this).apply{text=s;textSize=17f;setTextColor(Color.DKGRAY);setBackgroundColor(Color.WHITE);setPadding(24,24,24,24)}
    private fun wide()=LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT).apply{setMargins(0,8,0,8)}
}
