package ir.nivora.bankagent

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.*

class MainActivity : Activity() {
    private lateinit var status: TextView
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val pad = (20 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply { orientation=LinearLayout.VERTICAL;setPadding(pad,pad,pad,pad);setBackgroundColor(Color.rgb(7,17,38));gravity=Gravity.CENTER_HORIZONTAL }
        fun field(label:String,value:String="")=EditText(this).apply{hint=label;setText(value);setTextColor(Color.WHITE);setHintTextColor(Color.GRAY)}
        root.addView(TextView(this).apply{text="NIVORA\nBANK AGENT";textSize=27f;setTextColor(Color.rgb(71,214,255));gravity=Gravity.CENTER})
        root.addView(TextView(this).apply{text="این برنامه فقط روی گوشی دریافت‌کننده پیامک بانک نصب می‌شود. متن خام پیامک روی سرور ذخیره نمی‌شود.";setTextColor(Color.LTGRAY);gravity=Gravity.CENTER;setPadding(0,pad/2,0,pad)})
        val url=field("نشانی وبهوک",AgentStore.endpoint(this));val id=field("شناسه Agent",AgentStore.agentId(this));val secret=field(if(AgentStore.secret(this).isBlank())"کلید اتصال" else "کلید اتصال (برای حفظ خالی بگذارید)");val senders=field("فرستنده‌های مجاز، هر کدام یک خط",AgentStore.senders(this).joinToString("\n"))
        listOf(url,id,secret,senders).forEach{root.addView(it,LinearLayout.LayoutParams(-1,-2))}
        val enabled=CheckBox(this).apply{text="دریافت و ارسال امن پیامک فعال باشد";isChecked=AgentStore.enabled(this@MainActivity);setTextColor(Color.WHITE)}
        root.addView(enabled);status=TextView(this).apply{setTextColor(Color.LTGRAY);setPadding(0,pad/2,0,pad/2)};root.addView(status)
        root.addView(Button(this).apply{text="ذخیره و فعال‌سازی";setOnClickListener{
            if(url.text.isBlank()||id.text.isBlank()||(AgentStore.secret(this@MainActivity).isBlank()&&secret.text.isBlank())||senders.text.isBlank()){status.text="همه اطلاعات اتصال و حداقل یک فرستنده را وارد کنید";return@setOnClickListener}
            AgentStore.save(this@MainActivity,url.text.toString(),id.text.toString(),secret.text.toString(),senders.text.toString(),enabled.isChecked)
            if(checkSelfPermission(Manifest.permission.RECEIVE_SMS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS),20)else status.text="فعال است؛ منتظر پیامک بانکی"
        }},LinearLayout.LayoutParams(-1,-2));setContentView(ScrollView(this).apply{addView(root)})
    }
    override fun onRequestPermissionsResult(r:Int,p:Array<out String>,g:IntArray){super.onRequestPermissionsResult(r,p,g);if(r==20)status.text=if(g.firstOrNull()==PackageManager.PERMISSION_GRANTED)"فعال است؛ منتظر پیامک بانکی" else "اجازه پیامک داده نشد؛ از تنظیمات گوشی فعال کنید"}
}
