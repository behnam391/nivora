package ir.nivora.app.data
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
class ApiClient(private val baseUrl:String){
    private fun request(path:String,method:String="GET",token:String?=null,body:JSONObject?=null):JSONObject{val c=(URL(baseUrl.trimEnd('/')+path).openConnection() as HttpURLConnection).apply{requestMethod=method;connectTimeout=12_000;readTimeout=18_000;setRequestProperty("Accept","application/json");if(token!=null)setRequestProperty("Authorization","Bearer $token");if(body!=null){doOutput=true;setRequestProperty("Content-Type","application/json");outputStream.use{it.write(body.toString().toByteArray())}}};val raw=(if(c.responseCode in 200..299)c.inputStream else c.errorStream).bufferedReader().use{it.readText()};val json=JSONObject(raw);if(c.responseCode !in 200..299)throw IllegalStateException(json.optString("error","خطای سرور"));return json}
    fun login(phone:String,password:String):Session{val j=request("/api/customer/login","POST",body=JSONObject().put("phone",phone).put("password",password));return Session(j.getString("token"),j.getJSONObject("account").getString("name"))}
    fun account(token:String):Account{val j=request("/api/customer/me",token=token);val list=buildList{val a=j.getJSONArray("orders");for(i in 0 until a.length()){val o=a.getJSONObject(i);add(Subscription(o.getString("id"),o.getString("plan_name"),o.optString("subscription_status",o.getString("status")),o.optString("subscription_url").takeIf{it.isNotBlank()}))}};return Account(j.getString("name"),j.getString("phone"),j.getInt("balanceToman"),list)}
    fun plans():List<Plan>{val a=org.json.JSONArray((URL(baseUrl.trimEnd('/')+"/api/plans").readText()));return buildList{for(i in 0 until a.length()){val p=a.getJSONObject(i);add(Plan(p.getString("id"),p.getString("name"),p.getInt("priceIrr"),p.getInt("trafficGb"),p.getInt("durationDays"),p.getInt("deviceLimit")))}}}
}
