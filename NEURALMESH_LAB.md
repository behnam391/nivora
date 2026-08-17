# NeuralMesh Lab v1 — گزارش اجرا و Runbook

تاریخ اجرا: ۱۴ اوت ۲۰۲۶

این نسخه یک آزمایشگاه سه‌مسیره روی زیرساخت فعلی Nivora/3x-ui است. هیچ پنل یا Xray دوم ساخته نشده و مسیرهای موجود کاربران قبلی حذف یا ویرایش نشده‌اند.

## وضعیت نهایی

- سرویس‌های `x-ui`، `caddy`، `nivora` و `warp-svc` فعال هستند.
- ۲۳ Client قبلی و تمام ۱۶۱ اتصال قبلی آن‌ها به Inboundها حفظ شده‌اند.
- Client آزمایشی `neuralmesh-lab` فقط به سه Inbound آزمایش متصل است.
- سه Profile آزمایش:
  1. VLESS + REALITY + Vision روی TCP مستقیم
  2. VLESS + XHTTP + REALITY مستقیم
  3. VLESS + XHTTP stream-up + TLS از طریق Edge روی 443
- Meta برای کاربر آزمایشی به `warp-meta-test` می‌رود؛ YouTube/Google مستقیم می‌ماند؛ BitTorrent همچنان Block است.
- یک کاربر قبلی در Route Test برای Meta هیچ Rule آزمایشی را Match نکرد؛ پس مسیر پیش‌فرض قبلی‌اش حفظ شده است.

## بکاپ‌ها

مسیر سرور:

`/root/nivora-backups/neuralmesh-v1-20260814T131744Z`

| فایل | SHA-256 |
|---|---|
| `x-ui.db` | `b36336aba3843f0ada4336986b65c5020bde5249870beeb19052fcb78fea3d04` |
| `nivora.db` | `4a84d08a348a45a8c44c1cbe834b75dd94785ad3902b9b9e979fac13a75cc76f` |
| `Caddyfile` | `d4884f3b3dc9c1952e9be2e8fc2b3d2f3deaa6603f9fbc2c7588fbfa8ba17196` |
| `xray-runtime.json` | `d7a125647586fed7610ed2bdd60934ff61781619f5efd6fc78de06b4541c252d` |
| `nivora-source.tgz` | `410fe6345e8df9b28d76eeb0c9c1d1619a80cd51f38d44d3f4ade8474e83547a` |
| `xray-template-before-lab.json` | `d65117c5ae9c97b7cc67719dae562fe3dc92279cc430930baf5197b64210eb93` |

فایل `SHA256SUMS` در همان پوشه قرار دارد. Permission پوشه بکاپ `700` و فایل Checksum برابر `600` است.

## Manifest امن

Endpoint:

`GET /api/neuralmesh/manifest`

Header لازم:

```http
Authorization: Bearer <test-token>
```

رفتار:

- بدون توکن یا توکن اشتباه: `401`
- Manifest منقضی: `410`
- تنظیمات/فایل نامعتبر: `503`
- پاسخ معتبر: `200` با `Cache-Control: no-store`

Envelope پاسخ:

```json
{
  "algorithm": "Ed25519",
  "keyId": "neuralmesh-lab-v1",
  "payload": "base64url(json-bytes)",
  "signature": "base64url(ed25519-signature)"
}
```

کلید خصوصی خارج از Web Root و با Permission `600` نگهداری می‌شود. فایل Manifest نیز `600` است و فقط User سرویس Nivora به آن‌ها دسترسی دارد. فقط SHA-256 توکن در `.env` سرور ذخیره شده و خود توکن در Git، Log، APK یا Manifest قرار ندارد. Caddy نیز Header احراز هویت را در Access Log ثبت نمی‌کند.

اثر انگشت SHA-256 کلید عمومی Pin‌شده:

`acbed8cc79f62f566f04ea4e65eaf5fb4cb97578a43f22a3dd2d82052176f156`

Manifest فعلی تا `2026-09-13T14:05:09.130Z` اعتبار دارد. برای صدور مجدد با همان Identity و Signing Key:

```bash
set -a
. /opt/nivora/.env
NEURALMESH_MANIFEST_TOKEN_HASH='<sha256-of-current-or-new-test-token>' \
  node /opt/nivora/scripts/provision-neuralmesh-manifest.mjs
systemctl restart nivora
```

توکن خام نباید در History شل وارد شود؛ Hash را از Secret Store/فایل Permission محدود تزریق کنید.

## Android Network Lab

نسخه Research با Package مستقل `ir.nivora.app.research` ساخته شده است تا کنار نسخه اصلی نصب شود. مسیر ورود:

`ورود مشتری ← پشتیبانی ← آزمایشگاه هوشمند شبکه`

امکانات:

- دریافت Manifest با Bearer Token اختصاصی
- بررسی امضای Ed25519 با Public Key Pin‌شده، قبل از خواندن Profileها
- نگهداری رمزگذاری‌شده توکن در Android Keystore
- قطع کامل مسیر قبلی پیش از هر دور
- سه دور برای هر یک از سه Profile
- Tunnel connect time، HTTP 204، دانلود ۵MB و Mbps، Instagram TTFB و YouTube 204
- شمارش Reset، Timeout و Disconnect
- برچسب دستی مخابرات/ایرانسل/همراه اول و تشخیص Wi-Fi/Cellular
- Median/P50 و رد Profile با کمتر از دو دور موفق
- جریمه سنگین Reset/Timeout/Disconnect
- ذخیره محلی Winner و Runner-up برای هر ترکیب اپراتور/نوع شبکه
- امکان خاموش‌کردن Auto Select
- عدم ذخیره Payload، دامنه مرورشده، Device ID، شماره سیم‌کارت یا داده شخصی

هر Run کامل حدود ۴۵MB مصرف دارد و قبل از شروع به کاربر نمایش داده می‌شود.

## APKها

| نسخه | SHA-256 |
|---|---|
| `release/Nivora-0.14.0-NeuralMesh-Lab-arm64.apk` | `406968eb525ca8129c163e69bf55bb4411ce0051e359f1a5a56ffd57640072d4` |
| `release/Nivora-0.14.0-NeuralMesh-Lab-universal.apk` | `84d8c2069cf1d941ad727f47f6b82b3f908c870beff77a8856ec619149718bd6` |

نسخه Research با Android Debug Certificate و APK Signature Scheme v2 امضا شده است. برای انتشار عمومی باید با Keystore انتشار Nivora امضا شود؛ این نسخه فقط برای آزمایش کنترل‌شده است.

## نتایج خودکار

- Nivora محلی: ۴۴ تست، صفر خطا
- Nivora روی سرور: ۴۲ تست، صفر خطا
- Android Research: ۸ تست، صفر خطا
- Android Lint: بدون Error یا Warning
- امضا، Package، ABI و Activity آزمایشگاه داخل APK تأیید شدند.
- Auth، Expiry، Tamper Detection و Signature Verification پوشش تست دارند.
- Web، Account، Reseller، Health و Edge همگی پاسخ `200` می‌دهند.
- Xray config و Caddy config معتبرند.

## جدول تست واقعی

اولین Run واقعی در ۱۴ اوت ۲۰۲۶ روی گوشی SM-A155F، Android 16 و اینترنت Cellular ایرانسل انجام شد. Run دوم در ۱۷ اوت روی Wi-Fi مخابرات، پس از افزودن DNS سازگار با شبکه، اجرا شد. امتیاز کمتر بهتر است.

| شبکه | Reality Vision | XHTTP Reality | XHTTP TLS Edge | Winner |
|---|---|---|---|---|
| مخابرات Wi-Fi | مردود؛ ۰/۳، Disconnect=3 | قبول؛ ۲/۳، ۴٫۸Mbps، Score=19914 | قبول؛ ۳/۳، ۹٫۷Mbps، Score=2686 | XHTTP TLS Edge |
| ایرانسل Cellular | مردود؛ ۰/۳، Disconnect=12 | قبول؛ ۲/۳، ۱٫۰Mbps، Score=127773 | قبول؛ ۳/۳، ۳٫۹Mbps، Score=45102 | XHTTP TLS Edge |
| همراه اول Cellular | پس از VALIDATED شدن شبکه | پس از VALIDATED شدن شبکه | پس از VALIDATED شدن شبکه | — |

## Rollback کمتر از پنج دقیقه

Rollback فقط در صورت خطای واقعی انجام شود. ابتدا یک کپی اضطراری از وضعیت لحظه‌ای بگیرید.

### فقط Nivora/Manifest

```bash
systemctl stop nivora
cp -a /opt/nivora/.env /root/nivora-backups/nivora.env.pre-rollback
sed -i '/^NEURALMESH_/d' /opt/nivora/.env
tar -xzf /root/nivora-backups/neuralmesh-v1-20260814T131744Z/nivora-source.tgz -C /opt/nivora
systemctl start nivora
systemctl is-active nivora
```

این Rollback اصلاح امن TLS پنل را نگه می‌دارد و فقط قابلیت Manifest را برمی‌گرداند.

### Rollback کامل Xray/Test Identity

```bash
systemctl stop x-ui
cp -a /etc/x-ui/x-ui.db /root/nivora-backups/x-ui.db.pre-rollback
install -o root -g root -m 600 \
  /root/nivora-backups/neuralmesh-v1-20260814T131744Z/x-ui.db \
  /etc/x-ui/x-ui.db
systemctl start x-ui
systemctl is-active x-ui
```

این مرحله Test Client و Routing آزمایشی را حذف می‌کند و دیتابیس 3x-ui را دقیقاً به Snapshot پیش از اجرا برمی‌گرداند. دیتابیس Nivora در این قابلیت تغییر نکرده است.

## فایل‌های اصلی تغییرکرده

- `src/neuralmesh-manifest.js`
- `src/app.js`
- `src/server.js`
- `src/security.js`
- `test/neuralmesh-manifest.test.js`
- `scripts/provision-neuralmesh-manifest.mjs`
- `android/app/src/main/java/ir/nivora/app/NetworkLabActivity.kt`
- `android/app/src/main/java/ir/nivora/app/data/NeuralMeshManifest.kt`
- `android/app/src/main/java/ir/nivora/app/data/NeuralMeshTokenStore.kt`
- `android/app/src/main/java/ir/nivora/app/vpn/NivoraVpnService.kt`
- `android/app/src/test/java/ir/nivora/app/data/NeuralMeshScorerTest.kt`
