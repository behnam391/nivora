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
        readonly List<string> transactions = new List<string>();
        readonly Panel dashboard = new Panel(), content = new Panel();
        int balanceToman;
        Process xray;
        string token;

        public MainForm() {
            Text = "Nivora for Windows"; ClientSize = new Size(510, 420);
            MinimumSize = new Size(510, 420); MaximumSize = new Size(1000, 760);
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
            balanceToman = root.ContainsKey("balanceToman") ? Convert.ToInt32(root["balanceToman"]) : 0;
            transactions.Clear(); var ledger = root.ContainsKey("transactions") ? root["transactions"] as ArrayList : null;
            if (ledger != null) foreach (var rawTransaction in ledger) {
                var transaction = rawTransaction as Dictionary<string, object>; if (transaction == null) continue;
                var amount = transaction.ContainsKey("amount_toman") ? Convert.ToInt32(transaction["amount_toman"]) : 0;
                transactions.Add((amount >= 0 ? "+" : "") + amount.ToString("N0") + " تومان · " + Value(transaction, "note"));
            }
            if (orders != null) foreach (var raw in orders) {
                var order = raw as Dictionary<string, object>; if (order == null) continue;
                var url = Value(order, "subscription_url"); var state = Value(order, "subscription_status");
                if (!String.IsNullOrWhiteSpace(url) && state == "active") {
                    var label = Value(order, "location_name"); if (String.IsNullOrWhiteSpace(label) || label == "null") label = Value(order, "plan_name");
                    var country = Value(order, "country_code"); if (String.IsNullOrWhiteSpace(country) || country == "null") country = CountryFor(label);
                    items.Add(new Subscription { Label = label, Url = url, Country = country }); subscriptions.Items.Add(FlagFor(country) + "  " + label);
                }
            }
            if (items.Count == 0) throw new Exception("NO_ACTIVE_SUBSCRIPTION"); subscriptions.SelectedIndex = 0;
        }

        void ShowSubscriptions() { BuildDashboard(); }

        void BuildDashboard() {
            Controls.Clear(); ClientSize = new Size(930, 650); MinimumSize = new Size(930, 650);
            dashboard.Dock = DockStyle.Fill; dashboard.BackColor = Color.FromArgb(6, 29, 24); dashboard.Controls.Clear(); Controls.Add(dashboard);
            var header = new Panel { Dock = DockStyle.Top, Height = 86, BackColor = Color.FromArgb(10, 52, 43) };
            var brand = new Label { Text = "NIVORA", ForeColor = Color.FromArgb(53, 225, 172), Font = new Font("Segoe UI", 23, FontStyle.Bold), AutoSize = true, Location = new Point(34, 21) }; header.Controls.Add(brand);
            var subtitle = new Label { Text = "داشبورد مشتری · ویندوز", ForeColor = Color.FromArgb(176, 210, 199), Font = new Font("Segoe UI", 9), AutoSize = true, Location = new Point(38, 55) }; header.Controls.Add(subtitle);
            var refresh = NavButton("↻  تازه‌سازی"); refresh.Location = new Point(678, 25); refresh.Click += async (s, e) => { try { SetStatus("در حال تازه‌سازی…"); await LoadSubscriptions(); ShowHome(); SetStatus("اطلاعات به‌روز شد."); } catch { SetStatus("به‌روزرسانی ناموفق بود.", true); } }; header.Controls.Add(refresh);
            var exit = NavButton("خروج"); exit.Location = new Point(812, 25); exit.Width = 82; exit.Click += (s, e) => { StopConnection(false); DeleteToken(); Application.Restart(); }; header.Controls.Add(exit);
            var side = new Panel { Dock = DockStyle.Left, Width = 184, BackColor = Color.FromArgb(9, 42, 35), Padding = new Padding(16, 24, 16, 16) };
            var home = MenuButton("خانه و اتصال"); home.Click += (s, e) => ShowHome(); side.Controls.Add(home);
            var wallet = MenuButton("کیف پول"); wallet.Top = 70; wallet.Click += (s, e) => ShowWallet(); side.Controls.Add(wallet);
            var support = MenuButton("پشتیبانی"); support.Top = 124; support.Click += (s, e) => ShowSupport(); side.Controls.Add(support);
            var account = new Label { Text = "حساب مشتری\n" + (items.Count.ToString() + " اشتراک فعال"), ForeColor = Color.FromArgb(177, 211, 201), TextAlign = ContentAlignment.MiddleCenter, Dock = DockStyle.Bottom, Height = 64, Font = new Font("Segoe UI", 9) }; side.Controls.Add(account);
            // Dock order is reverse z-order in WinForms: add fill first so it occupies
            // only the space remaining after the side menu and header.
            content.Dock = DockStyle.Fill; content.BackColor = Color.FromArgb(6, 29, 24);
            dashboard.Controls.Add(content); dashboard.Controls.Add(side); dashboard.Controls.Add(header); ShowHome();
        }

        Button NavButton(string text) { return new Button { Text = text, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 }, BackColor = Color.FromArgb(20, 71, 60), ForeColor = Color.White, Font = new Font("Segoe UI", 10, FontStyle.Bold), Width = 152, Height = 44, TextAlign = ContentAlignment.MiddleRight }; }
        Button MenuButton(string text) { return new Button { Text = text, FlatStyle = FlatStyle.Flat, FlatAppearance = { BorderSize = 0 }, BackColor = Color.Transparent, ForeColor = Color.FromArgb(220, 237, 231), Font = new Font("Segoe UI", 11), Width = 152, Height = 46, TextAlign = ContentAlignment.MiddleRight, Location = new Point(16, 16) }; }
        Label DashText(string text, int size, Color color) { return new Label { Text = text, ForeColor = color, Font = new Font("Segoe UI", size, FontStyle.Regular), AutoSize = true, RightToLeft = RightToLeft.Yes }; }
        Panel Card(int x, int y, int width, int height) { var card = new Panel { Location = new Point(x, y), Size = new Size(width, height), BackColor = Color.FromArgb(13, 53, 44), Padding = new Padding(20) }; content.Controls.Add(card); return card; }

        void ShowHome() {
            content.Controls.Clear(); var hello = DashText("سلام، اتصال امن شما آماده است", 19, Color.White); hello.Location = new Point(38, 30); content.Controls.Add(hello);
            var wallet = Card(38, 80, 660, 84); var walletTitle = DashText("کیف پول Nivora", 10, Color.FromArgb(164, 205, 193)); walletTitle.Location = new Point(22, 17); wallet.Controls.Add(walletTitle); var amount = DashText(balanceToman.ToString("N0") + " تومان", 20, Color.FromArgb(55, 225, 172)); amount.Font = new Font("Segoe UI", 20, FontStyle.Bold); amount.Location = new Point(22, 39); wallet.Controls.Add(amount); var seeWallet = NavButton("مشاهده کیف پول"); seeWallet.Location = new Point(480, 22); seeWallet.Click += (s, e) => ShowWallet(); wallet.Controls.Add(seeWallet);
            var location = Card(38, 188, 660, 175); var headline = DashText("مسیر اتصال", 14, Color.White); headline.Location = new Point(20, 17); location.Controls.Add(headline);
            subscriptions.Visible = true; subscriptions.RightToLeft = RightToLeft.Yes; subscriptions.SetBounds(22, 56, 610, 32); subscriptions.Font = new Font("Segoe UI", 11); location.Controls.Add(subscriptions);
            var route = DashText(items.Count > 0 ? "مسیر انتخاب‌شده با Reality و Xray اجرا می‌شود." : "اشتراک فعالی پیدا نشد.", 10, Color.FromArgb(174, 207, 197)); route.Location = new Point(22, 101); location.Controls.Add(route);
            connect.Visible = true; connect.Text = "اتصال امن"; connect.SetBounds(22, 126, 293, 35); location.Controls.Add(connect);
            disconnect.Visible = true; disconnect.SetBounds(339, 126, 293, 35); location.Controls.Add(disconnect);
            var listTitle = DashText("اشتراک‌های من", 15, Color.White); listTitle.Location = new Point(38, 392); content.Controls.Add(listTitle);
            int y = 430; foreach (var item in items.Take(2)) { var sub = Card(38, y, 660, 66); var flag = DashText(FlagFor(item.Country), 24, Color.White); flag.Location = new Point(20, 17); sub.Controls.Add(flag); var name = DashText(item.Label, 12, Color.White); name.Location = new Point(73, 13); sub.Controls.Add(name); var type = DashText("فعال · مسیر هوشمند", 9, Color.FromArgb(159, 208, 192)); type.Location = new Point(73, 38); sub.Controls.Add(type); y += 78; }
        }

        void ShowWallet() {
            content.Controls.Clear(); var heading = DashText("کیف پول", 20, Color.White); heading.Location = new Point(38, 30); content.Controls.Add(heading);
            var balance = Card(38, 82, 660, 125); var label = DashText("موجودی قابل استفاده", 11, Color.FromArgb(170, 210, 198)); label.Location = new Point(22, 21); balance.Controls.Add(label); var total = DashText(balanceToman.ToString("N0") + " تومان", 26, Color.FromArgb(55, 225, 172)); total.Font = new Font("Segoe UI", 26, FontStyle.Bold); total.Location = new Point(22, 53); balance.Controls.Add(total);
            var info = DashText("افزایش موجودی و ارسال رسید از پنل وب یا اپ اندروید قابل انجام است.", 10, Color.FromArgb(185, 207, 199)); info.Location = new Point(38, 236); content.Controls.Add(info);
            var history = DashText("گردش‌های اخیر", 15, Color.White); history.Location = new Point(38, 280); content.Controls.Add(history);
            var list = new ListBox { Location = new Point(38, 320), Size = new Size(660, 200), BackColor = Color.FromArgb(13, 53, 44), ForeColor = Color.White, BorderStyle = BorderStyle.None, Font = new Font("Segoe UI", 10), RightToLeft = RightToLeft.Yes, HorizontalScrollbar = true }; foreach (var item in transactions.Take(12)) list.Items.Add(item); if (list.Items.Count == 0) list.Items.Add("هنوز گردشی ثبت نشده است."); content.Controls.Add(list);
        }

        void ShowSupport() {
            content.Controls.Clear(); var heading = DashText("پشتیبانی", 20, Color.White); heading.Location = new Point(38, 30); content.Controls.Add(heading);
            var card = Card(38, 86, 660, 190); var text = DashText("برای ثبت و پیگیری تیکت، از بخش پشتیبانی در پنل Nivora استفاده کنید. پیام‌ها و اعلان‌ها در اپ اندروید نیز نمایش داده می‌شوند.", 12, Color.FromArgb(213, 231, 224)); text.MaximumSize = new Size(600, 100); text.Location = new Point(22, 26); card.Controls.Add(text);
            var open = NavButton("باز کردن پنل Nivora"); open.Location = new Point(22, 125); open.Click += (s, e) => Process.Start(ApiBase); card.Controls.Add(open);
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
        static string CountryFor(string label) {
            var text = (label ?? "").ToLowerInvariant();
            if (text.Contains("فنلاند") || text.Contains("finland") || text.Contains("هلسینکی")) return "FI";
            if (text.Contains("آلمان") || text.Contains("germany") || text.Contains("نورمبرگ")) return "DE";
            if (text.Contains("هلند") || text.Contains("netherlands")) return "NL";
            if (text.Contains("فرانسه") || text.Contains("france")) return "FR";
            if (text.Contains("ترکیه") || text.Contains("turkey")) return "TR";
            if (text.Contains("امارات") || text.Contains("uae")) return "AE";
            if (text.Contains("آمریکا") || text.Contains("united states")) return "US";
            if (text.Contains("انگلیس") || text.Contains("بریتانیا")) return "GB";
            if (text.Contains("کانادا") || text.Contains("canada")) return "CA";
            if (text.Contains("ژاپن") || text.Contains("japan")) return "JP";
            return "";
        }
        static string FlagFor(string country) {
            if (country == "FI") return "🇫🇮"; if (country == "DE") return "🇩🇪"; if (country == "NL") return "🇳🇱"; if (country == "FR") return "🇫🇷";
            if (country == "TR") return "🇹🇷"; if (country == "AE") return "🇦🇪"; if (country == "US") return "🇺🇸"; if (country == "GB") return "🇬🇧";
            if (country == "CA") return "🇨🇦"; if (country == "JP") return "🇯🇵"; return "🌐";
        }
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
        sealed class Subscription { public string Label; public string Url; public string Country; }
    }
}
