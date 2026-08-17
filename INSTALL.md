# Nivora installation

روی Ubuntu 24.04 با دسترسی root اجرا کنید:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/behnam391/nivora/main/install.sh)
```

نصب‌کننده دامنه، آدرس 3X-UI، توکن API، شناسه inbound و آدرس Subscription را دریافت می‌کند؛ سپس Node.js، Caddy، HTTPS، سرویس دائمی و بکاپ روزانه را تنظیم می‌کند.

## بازیابی کامل روی سرور جدید

روی سرور فعال، یک بسته‌ی بازیابی کامل بسازید؛ این بسته دیتابیس، تنظیمات محرمانه و رسیدهای پرداخت را دارد و باید خارج از سرور نگهداری شود:

```bash
sudo nivora recovery-export
```

فایل ساخته‌شده در `/opt/nivora/backups/` را با روش امنی مانند SCP به سیستم خودتان نگه دارید. روی سرور جدید فایل را آپلود کنید و سپس فقط این دستور را اجرا کنید:

```bash
sudo NIVORA_RECOVERY_FILE=/root/nivora-recovery-YYYYMMDDTHHMMSSZ.tar.gz bash <(curl -fsSL https://raw.githubusercontent.com/behnam391/nivora/main/install.sh)
```

نصب‌کننده تنظیمات، کاربران، پلن‌ها، کارت‌ها، همکاران، سفارش‌ها، توکن‌های پنل و ربات و رسیدها را برمی‌گرداند. اگر همان سرور 3x-ui/ثنایی پاک شده باشد، دیتابیس پنل و تنظیمات محلی آن نیز داخل بسته بازیابی می‌شود و نصب‌کننده 3x-ui را نصب و داده‌هایش را برمی‌گرداند. فقط رکورد DNS دامنه را به IP سرور جدید تغییر دهید.

پس از نصب:

```bash
nivora status
nivora logs
nivora backup
nivora recovery-export
nivora recovery-import /root/nivora-recovery-YYYYMMDDTHHMMSSZ.tar.gz
nivora update
nivora restart
```

توکن مدیریت تولیدشده در پایان نصب فقط همان بار نمایش داده می‌شود و باید در محل امن ذخیره شود.
