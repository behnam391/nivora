using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
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
        readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        Process xray;
        public DesktopForm() {
            Text = "Nivora"; Width = 1160; Height = 760; MinimumSize = new System.Drawing.Size(960, 660); StartPosition = FormStartPosition.CenterScreen;
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
            } catch { Reply("error", new { message = "خطا در پردازش درخواست" }); }
        }
        async System.Threading.Tasks.Task Login(string phone, string password) {
            var body = "{\"phone\":\"" + Escape(phone) + "\",\"password\":\"" + Escape(password) + "\"}";
            var res = await http.PostAsync(Api + "/api/customer/login", new StringContent(body, Encoding.UTF8,"application/json"));
            if (!res.IsSuccessStatusCode) { Reply("error", new { message = "شماره یا رمز عبور نادرست است" }); return; }
            var data = json.Deserialize<Dictionary<string,object>>(await res.Content.ReadAsStringAsync()); var token = Get(data,"token"); Reply("session", new { token = token }); await LoadAccount(token);
        }
        async System.Threading.Tasks.Task LoadAccount(string token) {
            if (String.IsNullOrWhiteSpace(token)) return;
            var r = new HttpRequestMessage(HttpMethod.Get, Api + "/api/customer/me"); r.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",token);
            var res = await http.SendAsync(r); if (!res.IsSuccessStatusCode) { Reply("expired", new { }); return; }
            Reply("account", json.DeserializeObject(await res.Content.ReadAsStringAsync()));
        }
        async System.Threading.Tasks.Task Connect(string url) {
            try {
                var raw = await http.GetStringAsync(url); var link = FindVless(raw); if (link == null) throw new Exception("مسیر سازگار پیدا نشد");
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Nivora Desktop"); Directory.CreateDirectory(folder);
                File.WriteAllText(Path.Combine(folder,"xray.json"), BuildConfig(link), new UTF8Encoding(false));
                var exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"core","xray.exe"); if (!File.Exists(exe)) throw new Exception("هسته اتصال پیدا نشد");
                Stop(); xray = Process.Start(new ProcessStartInfo(exe,"run -c \"" + Path.Combine(folder,"xray.json") + "\"") { UseShellExecute=false, CreateNoWindow=true });
                await System.Threading.Tasks.Task.Delay(1100); if (xray == null || xray.HasExited) throw new Exception("اجرای مسیر ناموفق بود"); Proxy(true); Reply("state", new { connected = true, message = "متصل شد · مسیر امن فعال است" });
            } catch (Exception ex) { Stop(); Reply("error", new { message = ex.Message }); }
        }
        void Stop() { Proxy(false); try { if (xray != null && !xray.HasExited) xray.Kill(); } catch {} xray = null; }
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
        static string Val(Dictionary<string,string>d,string k,string f){return d.ContainsKey(k)?d[k]:f;} static string Get(Dictionary<string,object>d,string k){return d!=null&&d.ContainsKey(k)&&d[k]!=null?d[k].ToString():"";} static string Escape(string s){return(s??"").Replace("\\","\\\\").Replace("\"","\\\"");}
        const int CHANGED=39, REFRESH=37; [DllImport("wininet.dll")] static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);
        static void Proxy(bool on) { using(var k=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings")){k.SetValue("ProxyEnable",on?1:0,RegistryValueKind.DWord);if(on)k.SetValue("ProxyServer","127.0.0.1:"+HttpPort);}InternetSetOption(IntPtr.Zero,CHANGED,IntPtr.Zero,0);InternetSetOption(IntPtr.Zero,REFRESH,IntPtr.Zero,0); }
    }
}
