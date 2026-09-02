using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NivoraDesktop {
    static class Program { [STAThread] static void Main() { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new DesktopForm()); } }

    sealed class DesktopForm : Form {
        const string Api = "https://b.nivorali.com", CorePort = "13808", HttpPort = "13809";
        readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
        readonly HttpClient http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(25) };
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly string deviceId = LoadDeviceId();
        Process xray;
        string sessionToken = "";
        bool proxyCaptured;
        object previousProxyEnabled, previousProxyServer;
        public DesktopForm() {
            // Keep the desktop client intentionally phone-like: the same compact flow
            // and responsive layout is used on Windows instead of a stretched dashboard.
            Text = "Nivora"; Width = 500; Height = 790; MinimumSize = new System.Drawing.Size(430, 650); MaximumSize = new System.Drawing.Size(620, 920); StartPosition = FormStartPosition.CenterScreen;
            Controls.Add(view); this.Load += async (s,e) => await Start(); FormClosing += (s,e) => Stop();
        }
        async System.Threading.Tasks.Task Start() {
            try {
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nivora", "WebView"));
                await view.EnsureCoreWebView2Async(env);
                view.CoreWebView2.Settings.IsScriptEnabled = true;
                view.CoreWebView2.Settings.IsWebMessageEnabled = true;
                view.CoreWebView2.WebMessageReceived += async (s,e) => await Message(e.TryGetWebMessageAsString());
                // The interface is fully self-contained. NavigateToString avoids a blank
                // page on older WebView2 runtimes that fail virtual-host mappings.
                view.CoreWebView2.NavigateToString(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui", "index.html"), Encoding.UTF8));
            } catch (Exception ex) { MessageBox.Show("مرورگر داخلی ویندوز در دسترس نیست. Microsoft Edge WebView2 Runtime را نصب کنید.\n\n" + ex.Message, "Nivora"); }
        }
        async System.Threading.Tasks.Task Message(string raw) {
            try {
                var msg = json.Deserialize<Dictionary<string, object>>(raw); var action = Get(msg,"action");
                if (action == "login") await Login(Get(msg,"phone"), Get(msg,"password"));
                else if (action == "refresh") await LoadAccount(Get(msg,"token"));
                else if (action == "connect") await Connect(Get(msg,"url"));
                else if (action == "disconnect") { Stop(); Reply("state", new { connected = false, message = "اتصال قطع شد" }); }
                else if (action == "openAccount") OpenAccount(Get(msg,"section"));
            } catch { Reply("error", new { message = "خطا در پردازش درخواست" }); }
        }
        async System.Threading.Tasks.Task Login(string phone, string password) {
            var body = "{\"phone\":\"" + Escape(phone) + "\",\"password\":\"" + Escape(password) + "\"}";
            var request = Request(HttpMethod.Post, Api + "/api/customer/login", ""); request.Content = new StringContent(body, Encoding.UTF8,"application/json");
            var res = await http.SendAsync(request); var raw = await res.Content.ReadAsStringAsync();
            if (!res.IsSuccessStatusCode) { Reply("error", new { message = ApiError(raw) }); return; }
            var data = json.Deserialize<Dictionary<string,object>>(raw); var token = Get(data,"token"); sessionToken = token; Reply("session", new { token = token }); await LoadAccount(token);
        }
        async System.Threading.Tasks.Task LoadAccount(string token) {
            if (String.IsNullOrWhiteSpace(token)) return;
            sessionToken = token; var r = Request(HttpMethod.Get, Api + "/api/customer/me", token);
            var res = await http.SendAsync(r); if (!res.IsSuccessStatusCode) { Reply("expired", new { }); return; }
            Reply("account", json.DeserializeObject(await res.Content.ReadAsStringAsync()));
        }
        async System.Threading.Tasks.Task Connect(string url) {
            try {
                if (String.IsNullOrWhiteSpace(sessionToken)) throw new Exception("نشست حساب منقضی شده است");
                Uri target; if(!Uri.TryCreate(url,UriKind.Absolute,out target)||target.Scheme!="https"||!String.Equals(target.Host,new Uri(Api).Host,StringComparison.OrdinalIgnoreCase))throw new Exception("نشانی اشتراک معتبر نیست");
                var response = await http.SendAsync(Request(HttpMethod.Get, url, sessionToken));
                if (!response.IsSuccessStatusCode) throw new Exception(response.StatusCode == HttpStatusCode.Unauthorized ? "این دستگاه برای اشتراک مجاز نیست" : "دریافت مسیر اتصال ناموفق بود");
                var raw = await response.Content.ReadAsStringAsync(); var link = FindVless(raw); if (link == null) throw new Exception("مسیر سازگار پیدا نشد");
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Nivora Desktop"); Directory.CreateDirectory(folder);
                File.WriteAllText(Path.Combine(folder,"xray.json"), BuildConfig(link), new UTF8Encoding(false));
                var exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"core","xray.exe"); if (!File.Exists(exe)) throw new Exception("هسته اتصال پیدا نشد");
                Stop(); xray = Process.Start(new ProcessStartInfo(exe,"run -c \"" + Path.Combine(folder,"xray.json") + "\"") { UseShellExecute=false, CreateNoWindow=true });
                await System.Threading.Tasks.Task.Delay(1100); if (xray == null || xray.HasExited) throw new Exception("اجرای مسیر ناموفق بود"); Proxy(true); Reply("state", new { connected = true, message = "متصل شد · مسیر امن فعال است" });
            } catch (Exception ex) { Stop(); Reply("error", new { message = ex.Message }); }
        }
        void Stop() { Proxy(false); try { if (xray != null && !xray.HasExited) xray.Kill(); } catch {} xray = null; }
        void OpenAccount(string section) { var anchor=section=="wallet"?"#wallet-center":section=="support"?"#support-center":""; try{Process.Start(Api+"/account"+anchor);}catch{Reply("error",new{message="بازکردن حساب در مرورگر ممکن نشد"});} }
        void Reply(string type, object payload) { if (view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = type, payload = payload })); }
        string BuildConfig(string link) {
            string value=link.Substring(8); int at=value.IndexOf('@'); if(at<1) throw new Exception("لینک نامعتبر است"); string id=value.Substring(0,at); string rest=value.Substring(at+1); int h=rest.IndexOf('#'); if(h>=0) rest=rest.Substring(0,h); int q=rest.IndexOf('?'); string hp=q>=0?rest.Substring(0,q):rest; Dictionary<string,string> query=q>=0?Query(rest.Substring(q+1)):new Dictionary<string,string>(); int colon=hp.LastIndexOf(':'); int port; if(colon<1||!Int32.TryParse(hp.Substring(colon+1),out port))throw new Exception("لینک نامعتبر است");
            var stream=new Dictionary<string,object>{{"network",Val(query,"type","tcp")},{"security",Val(query,"security","none")}};
            if(Val(query,"security","")=="reality") stream["realitySettings"]=new Dictionary<string,object>{{"show",false},{"fingerprint",Val(query,"fp","chrome")},{"serverName",Val(query,"sni","")},{"publicKey",Val(query,"pbk","")},{"shortId",Val(query,"sid","")},{"spiderX",Val(query,"spx","")}};
            if(Val(query,"type","")=="grpc") stream["grpcSettings"]=new Dictionary<string,object>{{"serviceName",Val(query,"serviceName","")}};
            if(Val(query,"type","")=="ws") stream["wsSettings"]=new Dictionary<string,object>{{"path",Val(query,"path","")}};
            var user=new Dictionary<string,object>{{"id",id},{"encryption",Val(query,"encryption","none")}}; if(query.ContainsKey("flow"))user["flow"]=query["flow"];
            return json.Serialize(new Dictionary<string,object>{{"log",new Dictionary<string,object>{{"loglevel","warning"}}},{"inbounds",new object[]{new Dictionary<string,object>{{"listen","127.0.0.1"},{"port",Int32.Parse(CorePort)},{"protocol","socks"},{"settings",new Dictionary<string,object>{{"udp",true}}}},new Dictionary<string,object>{{"listen","127.0.0.1"},{"port",Int32.Parse(HttpPort)},{"protocol","http"}}}},{"outbounds",new object[]{new Dictionary<string,object>{{"protocol","vless"},{"settings",new Dictionary<string,object>{{"vnext",new object[]{new Dictionary<string,object>{{"address",hp.Substring(0,colon)},{"port",port},{"users",new object[]{user}}}}}}},{"streamSettings",stream}}}}});
        }
        static string FindVless(string raw) { raw=raw.Trim(); if(!raw.Contains("://"))try{raw=Encoding.UTF8.GetString(Convert.FromBase64String(raw));}catch{} foreach(var l in raw.Replace("\r","").Split('\n'))if(l.TrimStart().StartsWith("vless://",StringComparison.OrdinalIgnoreCase))return l.Trim(); return null; }
        static Dictionary<string,string> Query(string s) { var d=new Dictionary<string,string>(); foreach(var p in s.Split('&')){var i=p.IndexOf('=');if(i>0)d[Uri.UnescapeDataString(p.Substring(0,i))]=Uri.UnescapeDataString(p.Substring(i+1));}return d; }
        HttpRequestMessage Request(HttpMethod method, string url, string bearer) { var request = new HttpRequestMessage(method,url); request.Headers.TryAddWithoutValidation("X-Nivora-Device",deviceId); request.Headers.TryAddWithoutValidation("X-Nivora-Platform","Windows"); if(!String.IsNullOrWhiteSpace(bearer))request.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",bearer); return request; }
        string ApiError(string raw) { try { var data=json.Deserialize<Dictionary<string,object>>(raw); var code=Get(data,"error"); if(code=="DEVICE_ALREADY_BOUND")return "این حساب روی دستگاه دیگری فعال است؛ از پشتیبانی بخواهید دستگاه قبلی را آزاد کند"; if(code=="DEVICE_LIMIT_REACHED")return "ظرفیت دستگاه‌های این حساب تکمیل است"; if(code=="RATE_LIMITED")return "تلاش‌ها زیاد بود؛ کمی بعد دوباره امتحان کنید"; if(code=="INVALID_CREDENTIALS")return "شماره یا رمز عبور نادرست است"; } catch {} return "ارتباط با حساب انجام نشد"; }
        static string LoadDeviceId() { var folder=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Nivora"); Directory.CreateDirectory(folder); var path=Path.Combine(folder,"device.id"); try { var saved=File.Exists(path)?File.ReadAllText(path).Trim():""; if(saved.Length>=20)return saved; } catch {} var bytes=new byte[24]; using(var rng=RandomNumberGenerator.Create())rng.GetBytes(bytes); var value="win_"+Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_'); try{File.WriteAllText(path,value,Encoding.ASCII);}catch{} return value; }
        static string Val(Dictionary<string,string>d,string k,string f){return d.ContainsKey(k)?d[k]:f;} static string Get(Dictionary<string,object>d,string k){return d!=null&&d.ContainsKey(k)&&d[k]!=null?d[k].ToString():"";} static string Escape(string s){return(s??"").Replace("\\","\\\\").Replace("\"","\\\"");}
        const int CHANGED=39, REFRESH=37; [DllImport("wininet.dll")] static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);
        void Proxy(bool on) { using(var k=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings")){if(on){if(!proxyCaptured){previousProxyEnabled=k.GetValue("ProxyEnable",0);previousProxyServer=k.GetValue("ProxyServer",null);proxyCaptured=true;}k.SetValue("ProxyEnable",1,RegistryValueKind.DWord);k.SetValue("ProxyServer","127.0.0.1:"+HttpPort);}else if(proxyCaptured){k.SetValue("ProxyEnable",previousProxyEnabled??0,RegistryValueKind.DWord);if(previousProxyServer==null)k.DeleteValue("ProxyServer",false);else k.SetValue("ProxyServer",previousProxyServer);proxyCaptured=false;}}InternetSetOption(IntPtr.Zero,CHANGED,IntPtr.Zero,0);InternetSetOption(IntPtr.Zero,REFRESH,IntPtr.Zero,0); }
    }
}
