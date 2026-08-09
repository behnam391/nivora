# Mobile API contract v1

Base URL: `https://YOUR-DOMAIN`

تمام پاسخ‌ها JSON هستند. توکن نشست با `Authorization: Bearer <token>` ارسال می‌شود و نباید در لاگ اپ نوشته شود.

## احراز هویت

- `POST /api/customer/register` — `name`, `phone`, `password`
- `POST /api/customer/login` — `phone`, `password`
- `GET /api/customer/me` — حساب، موجودی، سفارش‌ها، اشتراک‌ها و اعلان‌ها

## فروش و کیف پول

- `GET /api/plans`
- `GET /api/store-config`
- `POST /api/customer/discount/validate`
- `POST /api/customer/wallet/purchase`
- `POST /api/customer/orders/{id}/renew`
- `POST /api/receipts`
- `POST /api/customer/wallet/topups`

## پشتیبانی

- `GET|POST /api/customer/tickets`
- `GET|POST /api/customer/tickets/{id}`
- `POST /api/customer/notifications/read`

## اتصال

اپ از `subscription_url` سفارش فعال استفاده می‌کند. محتوای Subscription در لایه شبکه دریافت، توسط libXray به JSON معتبر تبدیل، پینگ‌ها به‌صورت محدود بررسی و بهترین خروجی انتخاب می‌شود. لینک و کانفیگ نباید در گزارش خطا یا ابزار تحلیل رفتار ثبت شود.

## خطاهای مهم

- `401 UNAUTHORIZED`: بازگشت به ورود
- `400 INSUFFICIENT_BALANCE`: نمایش شارژ کیف پول
- `409 NO_CAPACITY`: توقف خرید پلن
- `429 RATE_LIMITED`: انتظار بر اساس `Retry-After`
- `502 PROVISION_FAILED|RENEW_FAILED`: مبلغ خودکار بازپرداخت شده است
