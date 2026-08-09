# Nivora installation

روی Ubuntu 24.04 با دسترسی root اجرا کنید:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/behnam391/nivora/main/install.sh)
```

نصب‌کننده دامنه، آدرس 3X-UI، توکن API، شناسه inbound و آدرس Subscription را دریافت می‌کند؛ سپس Node.js، Caddy، HTTPS، سرویس دائمی و بکاپ روزانه را تنظیم می‌کند.

پس از نصب:

```bash
nivora status
nivora logs
nivora backup
nivora update
nivora restart
```

توکن مدیریت تولیدشده در پایان نصب فقط همان بار نمایش داده می‌شود و باید در محل امن ذخیره شود.
