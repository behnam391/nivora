using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace NivoraWindows {
    static class Program {
        [STAThread] static void Main() {
            // .NET Framework defaults can still negotiate legacy TLS on some Windows installations.
            // The Nivora API requires modern TLS.
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    sealed class MainForm : Form {
        const string ApiBase = "https://b.nivorali.com";
        const int SocksProxyPort = 13808;
        const int HttpProxyPort = 13809;
        readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly TextBox phone = new TextBox(), password = new TextBox();
        Button login = new Button(), connect = new Button(), disconnect = new Button();
        readonly ComboBox subscriptions = new ComboBox();
        readonly Label status = new Label(), title = new Label(), help = new Label();
        readonly List<Subscription> items = new List<Subscription>();
        Process xray;
        string token;

        public MainForm() {
            Text = "Nivora for Windows"; ClientSize = new Size(510, 420);
            MinimumSize = new Size(510, 420); MaximumSize = new Size(510, 420);
            BackColor = Color.FromArgb(7, 32, 27); ForeColor = Color.White; Font = new Font("Segoe UI", 10F);
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
            BuildUi(); Load += async (s, e) => await RestoreSession(); FormClosing += (s, e) => StopConnection();
        }

        Control Add(Control control, int x, int y, int width, int height) { control.SetBounds(x, y, width, height); Controls.Add(control); return control; }
        Label Label(string text, int size = 10) { return new Label { Text = text, AutoSize = false, ForeColor = Color.FromArgb(206, 230, 222), Font = new Font("Segoe UI", size, FontStyle.Regular), TextAlign = ContentAlignment.MiddleRight }; }
        Button Button(string text) { return new Button { Text = text, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(35, 207, 159), ForeColor = Color.FromArgb(6, 30, 25), Font = new Font("Segoe UI", 10, FontStyle.Bold), Cursor = Cursors.Hand }; }

        void BuildUi() {
            title.Text = "NIVORA"; title.Font = new Font("Segoe UI", 24, FontStyle.Bold); title.ForeColor = Color.FromArgb(56, 224, 172); title.TextAlign = ContentAlignment.MiddleCenter;
            Add(title, 35, 23, 440, 48);
            var subtitle = Label("اتصال امن، ساده و سریع · ویندوز", 10); subtitle.TextAlign = ContentAlignment.MiddleCenter; Add(subtitle, 35, 68, 440, 27);
            Add(Label("شماره موبایل", 10), 275, 111, 195, 25); phone.TextAlign = HorizontalAlignment.Right; Add(phone, 40, 137, 430, 31);
            Add(Label("رمز عبور", 10), 275, 174, 195, 25); password.TextAlign = HorizontalAlignment.Right; password.UseSystemPasswordChar = true; Add(password, 40, 200, 430, 31);
            login = Button("ورود و دریافت اشتراک‌ها"); Add(login, 40, 245, 430, 37); login.Click += async (s, e) => await Login();
            subscriptions.DropDownStyle = ComboBoxStyle.DropDownList; subscriptions.RightToLeft = RightToLeft.Yes; subscriptions.Visible = false; Add(subscriptions, 40, 137, 430, 32);
            connect = Button("اتصال"); connect.Visible = false; Add(connect, 40, 185, 210, 42); connect.Click += async (s, e) => await Connect();
            disconnect = new Button { Text = "قطع اتصال", FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(41, 67, 61), ForeColor = Color.White, Font = new Font("Segoe UI", 10, FontStyle.Bold) }; disconnect.Visible = false; Add(disconnect, 260, 185, 210, 42); disconnect.Click += (s, e) => StopConnection();
            status.Text = "آمادهٔ ورود"; status.TextAlign = ContentAlignment.MiddleCenter; status.ForeColor = Color.FromArgb(160, 197, 185); Add(status, 40, 302, 430, 29);
            help.Text = "اتصال از طریق پراکسی سیستم ویندوز انجام می‌شود. برای قطع کامل، «قطع اتصال» را بزنید."; help.TextAlign = ContentAlignment.MiddleCenter; help.ForeColor = Color.FromArgb(145, 176, 166); help.Font = new Font("Segoe UI", 8.5F); Add(help, 52, 341, 406, 42);
        }

        async System.Threading.Tasks.Task RestoreSession() {
            token = ReadToken(); if (String.IsNullOrWhiteSpace(token)) return;
            status.Text = "در حال بازیابی حساب…"; try { await LoadSubscriptions(); ShowSubscriptions(); } catch { DeleteToken(); token = null; status.Text = "نشست قبلی منقضی شده؛ دوباره وارد شوید."; }
        }

        async System.Threading.Tasks.Task Login() {
            var number = phone.Text.Trim(); if (number.Length < 10 || password.Text.Length < 8) { SetStatus("شماره یا رمز معتبر نیست.", true); return; }
            login.Enabled = false; SetStatus("در حال ورود…");
            try {
                var body = "{\"phone\":\"" + Escape(number) + "\",\"password\":\"" + Escape(password.Text) + "\"}";
                var response = await http.PostAsync(ApiBase + "/api/customer/login", new StringContent(body, Encoding.UTF8, "application/json"));
                response.EnsureSuccessStatusCode(); var data = ObjectOf(await response.Content.ReadAsStringAsync());
                token = Value(data, "token"); if (String.IsNullOrWhiteSpace(token)) throw new Exception(); SaveToken(token); password.Clear();
                await LoadSubscriptions(); ShowSubscriptions(); SetStatus("ورود انجام شد؛ یک اشتراک را انتخاب کنید.");
            } catch (Exception ex) {
                var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Nivora Windows");
                Directory.CreateDirectory(folder); File.WriteAllText(Path.Combine(folder, "last-login-error.txt"), ex.ToString(), Encoding.UTF8);
                SetStatus("ورود ناموفق بود. شماره و رمز را بررسی کنید.", true);
            } finally { login.Enabled = true; }
        }

        async System.Threading.Tasks.Task LoadSubscriptions() {
            var request = new HttpRequestMessage(HttpMethod.Get, ApiBase + "/api/customer/me"); request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            var response = await http.SendAsync(request); response.EnsureSuccessStatusCode(); var root = ObjectOf(await response.Content.ReadAsStringAsync());
            items.Clear(); subscriptions.Items.Clear(); var orders = root.ContainsKey("orders") ? root["orders"] as ArrayList : null;
            if (orders != null) foreach (var raw in orders) {
                var order = raw as Dictionary<string, object>; if (order == null) continue;
                var url = Value(order, "subscription_url"); var state = Value(order, "subscription_status");
                if (!String.IsNullOrWhiteSpace(url) && state == "active") {
                    var label = Value(order, "location_name"); if (String.IsNullOrWhiteSpace(label) || label == "null") label = Value(order, "plan_name");
                    items.Add(new Subscription { Label = label, Url = url }); subscriptions.Items.Add(label);
                }
            }
            if (items.Count == 0) throw new Exception("NO_ACTIVE_SUBSCRIPTION"); subscriptions.SelectedIndex = 0;
        }

        void ShowSubscriptions() {
            phone.Visible = password.Visible = login.Visible = false; foreach (Control c in Controls) if (c is Label && (c.Text == "شماره موبایل" || c.Text == "رمز عبور")) c.Visible = false;
            subscriptions.Visible = connect.Visible = disconnect.Visible = true; status.Top = 252; help.Top = 297;
        }

        async System.Threading.Tasks.Task Connect() {
            if (subscriptions.SelectedIndex < 0) return; connect.Enabled = false; SetStatus("در حال دریافت و اجرای مسیر امن…");
            try {
                var raw = await http.GetStringAsync(items[subscriptions.SelectedIndex].Url); var link = FindVless(raw);
                if (String.IsNullOrWhiteSpace(link)) throw new Exception("NO_VLESS_ROUTE");
                var config = BuildXrayConfig(link); var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Nivora Windows"); Directory.CreateDirectory(root);
                // Xray rejects a UTF-8 BOM at the beginning of JSON configuration files.
                File.WriteAllText(Path.Combine(root, "xray.json"), config, new UTF8Encoding(false));
                var exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "core", "xray.exe"); if (!File.Exists(exe)) throw new Exception("XRAY_NOT_FOUND");
                StopConnection(false); xray = Process.Start(new ProcessStartInfo(exe, "run -c \"" + Path.Combine(root, "xray.json") + "\"") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(exe) });
                await System.Threading.Tasks.Task.Delay(1300); if (xray == null || xray.HasExited) throw new Exception("XRAY_START_FAILED");
                SystemProxy(true); SetStatus("متصل شد · پراکسی سیستم فعال است."); disconnect.Enabled = true;
            } catch (Exception ex) { StopConnection(); SetStatus("اتصال برقرار نشد: " + Friendly(ex.Message), true); } finally { connect.Enabled = true; }
        }

        void StopConnection(bool announce = true) { SystemProxy(false); try { if (xray != null && !xray.HasExited) xray.Kill(); } catch { } xray = null; if (announce) SetStatus("اتصال قطع شد؛ پراکسی سیستم غیرفعال است."); }

        static string FindVless(string raw) {
            raw = raw.Trim(); if (!raw.Contains("://")) { try { raw = Encoding.UTF8.GetString(Convert.FromBase64String(raw)); } catch { } }
            var result = raw.Replace("\r", "").Split('\n').FirstOrDefault(x => x.TrimStart().StartsWith("vless://", StringComparison.OrdinalIgnoreCase)); return result == null ? null : result.Trim();
        }

        string BuildXrayConfig(string link) {
            var value = link.Substring(8); var at = value.IndexOf('@'); if (at < 1) throw new Exception("BAD_LINK"); var id = value.Substring(0, at); var rest = value.Substring(at + 1); var hash = rest.IndexOf('#'); if (hash >= 0) rest = rest.Substring(0, hash);
            var queryAt = rest.IndexOf('?'); var hostPort = queryAt >= 0 ? rest.Substring(0, queryAt) : rest; var query = queryAt >= 0 ? ParseQuery(rest.Substring(queryAt + 1)) : new Dictionary<string, string>();
            var colon = hostPort.LastIndexOf(':'); int port; if (colon < 1 || !Int32.TryParse(hostPort.Substring(colon + 1), out port)) throw new Exception("BAD_LINK"); var host = hostPort.Substring(0, colon);
            var stream = new Dictionary<string, object> { { "network", query.ContainsKey("type") ? query["type"] : "tcp" }, { "security", query.ContainsKey("security") ? query["security"] : "none" } };
            if (stream["security"].ToString() == "reality") stream["realitySettings"] = new Dictionary<string, object> { { "show", false }, { "fingerprint", Get(query, "fp", "chrome") }, { "serverName", Get(query, "sni", "") }, { "publicKey", Get(query, "pbk", "") }, { "shortId", Get(query, "sid", "") }, { "spiderX", Get(query, "spx", "") } };
            if (stream["network"].ToString() == "grpc") stream["grpcSettings"] = new Dictionary<string, object> { { "serviceName", Get(query, "serviceName", "") } };
            if (stream["network"].ToString() == "ws") stream["wsSettings"] = new Dictionary<string, object> { { "path", Get(query, "path", "/") } };
            var user = new Dictionary<string, object> { { "id", id }, { "encryption", Get(query, "encryption", "none") } }; if (query.ContainsKey("flow")) user["flow"] = query["flow"];
            var root = new Dictionary<string, object> {
                { "log", new Dictionary<string, object> { { "loglevel", "warning" } } },
                { "inbounds", new object[] { new Dictionary<string, object> { { "tag", "socks" }, { "listen", "127.0.0.1" }, { "port", SocksProxyPort }, { "protocol", "socks" }, { "settings", new Dictionary<string, object> { { "udp", true } } } }, new Dictionary<string, object> { { "tag", "http" }, { "listen", "127.0.0.1" }, { "port", HttpProxyPort }, { "protocol", "http" } } } },
                { "outbounds", new object[] { new Dictionary<string, object> { { "protocol", "vless" }, { "settings", new Dictionary<string, object> { { "vnext", new object[] { new Dictionary<string, object> { { "address", host }, { "port", port }, { "users", new object[] { user } } } } } } }, { "streamSettings", stream } } } }
            };
            return json.Serialize(root);
        }

        static Dictionary<string, string> ParseQuery(string query) { return query.Split('&').Where(x => x.Contains("=")).ToDictionary(x => Uri.UnescapeDataString(x.Substring(0, x.IndexOf('='))), x => Uri.UnescapeDataString(x.Substring(x.IndexOf('=') + 1))); }
        static string Get(Dictionary<string, string> map, string key, string fallback) { return map.ContainsKey(key) ? map[key] : fallback; }
        static string Escape(string text) { return text.Replace("\\", "\\\\").Replace("\"", "\\\""); }
        static Dictionary<string, object> ObjectOf(string text) { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text); }
        static string Value(Dictionary<string, object> item, string key) { return item != null && item.ContainsKey(key) && item[key] != null ? item[key].ToString() : ""; }
        void SetStatus(string text, bool error = false) { status.Text = text; status.ForeColor = error ? Color.FromArgb(255, 150, 150) : Color.FromArgb(120, 230, 185); }
        static string Friendly(string code) { return code == "NO_VLESS_ROUTE" ? "مسیر سازگار پیدا نشد" : code == "XRAY_NOT_FOUND" ? "هستهٔ اتصال پیدا نشد" : "تنظیمات یا مسیر اتصال را بررسی کنید"; }

        const int INTERNET_OPTION_SETTINGS_CHANGED = 39, INTERNET_OPTION_REFRESH = 37;
        [DllImport("wininet.dll", SetLastError = true)] static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length);
        static void SystemProxy(bool enabled) {
            using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings")) { key.SetValue("ProxyEnable", enabled ? 1 : 0, RegistryValueKind.DWord); if (enabled) key.SetValue("ProxyServer", "127.0.0.1:" + HttpProxyPort); }
            InternetSetOption(IntPtr.Zero, INTERNET_OPTION_SETTINGS_CHANGED, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, INTERNET_OPTION_REFRESH, IntPtr.Zero, 0);
        }
        static string TokenPath { get { var p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Nivora Windows"); Directory.CreateDirectory(p); return Path.Combine(p, "session.bin"); } }
        static void SaveToken(string value) { File.WriteAllBytes(TokenPath, ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser)); }
        static string ReadToken() { try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(TokenPath), null, DataProtectionScope.CurrentUser)); } catch { return null; } }
        static void DeleteToken() { try { File.Delete(TokenPath); } catch { } }
        sealed class Subscription { public string Label; public string Url; }
    }
}
