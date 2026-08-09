# Nivora Android

اپ اختصاصی مشتری Nivora با رابط فارسی Material 3 و اتصال واقعی Xray است.

## امکانات

- ورود، ثبت‌نام و درخواست بازیابی رمز
- ذخیره رمزگذاری‌شده توکن با Android Keystore
- اتصال و قطع VPN با `VpnService` و `libXray v26.7.28`
- پشتیبانی VLESS + Reality و شروع اعتبار از اولین اتصال
- نمایش مصرف، اعتبار، لوکیشن، تعداد دستگاه و پینگ endpoint واقعی اشتراک
- خرید و تمدید فوری از کیف پول و بررسی کد تخفیف
- کارت بانکی استاندارد، کپی صحیح شماره کارت و ثبت شماره پیگیری واریز
- نمایش گردش کیف پول و وضعیت درخواست‌های شارژ
- اعلان‌های حساب، ایجاد تیکت، مشاهده گفتگو و ارسال پاسخ
- تم روشن/تیره، رابط RTL، آیکون و Splash اختصاصی
- رضایت شفاف حریم خصوصی پیش از اولین اتصال

## ساخت محلی

فایل AAR حجیم داخل مخزن نگهداری نمی‌شود. ابتدا هسته رسمی را دریافت کنید و بعد APK را بسازید:

```bash
bash android/fetch-libxray.sh
cd android
./gradlew app:testDebugUnitTest app:lintDebug app:assembleDebug
```

خروجی‌ها برای معماری‌های رایج جدا می‌شوند:

- `app-arm64-v8a-debug.apk` برای بیشتر گوشی‌های جدید
- `app-armeabi-v7a-debug.apk` برای گوشی‌های قدیمی ۳۲ بیتی
- `app-universal-debug.apk` برای نصب عمومی با حجم بیشتر

API پیش‌فرض `https://b.nivorali.com` است و با Gradle property به نام `NIVORA_API_BASE_URL` قابل تغییر است.

## امضای انتشار

کلید انتشار بیرون از مخزن نگهداری می‌شود. روی رایانه اصلی، ساخت نسخه امضاشده با این دستور انجام می‌شود:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\android\sign-release.ps1
```

انتشار GitHub نیز فقط با Secrets رمزگذاری‌شده `NIVORA_KEYSTORE_BASE64` و `NIVORA_KEYSTORE_PASSWORD` نسخه release می‌سازد. کلید یا رمز نباید در commit، لاگ یا فایل APK عمومی قرار گیرد.

## حریم خصوصی و مجوزها

اپ کانفیگ و محتوای ترافیک را در لاگ ثبت نمی‌کند. توکن حساب با کلید سخت‌افزاری/سیستمی Android Keystore رمزگذاری و همه داده‌های اپ از Cloud Backup و انتقال دستگاه مستثنا شده‌اند. `libXray` تحت MIT و Xray-core تحت MPL-2.0 استفاده می‌شوند.
