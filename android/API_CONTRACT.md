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

## اپ مستقل همکار فروش

- `POST /api/reseller/login` — فقط حساب فعال با نقش `reseller`
- `GET /api/reseller/me` — آمار، موجودی، گردش، اعلان‌ها، بدهی‌ها و شارژهای ثبت‌شده توسط همان همکار
- `GET /api/reseller/plans|customers|orders|tickets`
- `GET /api/reseller/customer-directory?q=...` — جست‌وجوی حداقل سه‌کاراکتری مشتریان موجود
- `POST /api/reseller/customers` — ساخت مشتری با رمز انتخابی؛ اگر رمز فرستاده نشود `temporaryPassword` فقط یک بار برمی‌گردد
- `PATCH /api/reseller/customers/{id}` و `POST .../{id}/reset-password`
- `POST /api/reseller/customers/{accountId}/wallet` — انتقال اتمیک از کیف پول همکار به مشتری
- `POST /api/reseller/wallet-transfers/{id}/reverse` — برگشت کامل/جزئی فقط از شارژ همان همکار
- `POST /api/reseller/customers/{accountId}/debts` و `POST /api/reseller/debts/{id}/settle|cancel`
- `POST /api/reseller/purchase` و `POST /api/reseller/orders/{id}/renew`
- `POST /api/reseller/orders/{id}/suspend|resume|delete` — فقط سرویسی که همان همکار فروخته است

## اتصال

اپ از `subscription_url` سفارش فعال استفاده می‌کند. محتوای Subscription در لایه شبکه دریافت، توسط libXray به JSON معتبر تبدیل، پینگ‌ها به‌صورت محدود بررسی و بهترین خروجی انتخاب می‌شود. لینک و کانفیگ نباید در گزارش خطا یا ابزار تحلیل رفتار ثبت شود.

## خطاهای مهم

- `401 UNAUTHORIZED`: بازگشت به ورود
- `400 INSUFFICIENT_BALANCE`: نمایش شارژ کیف پول
- `409 NO_CAPACITY`: توقف خرید پلن
- `429 RATE_LIMITED`: انتظار بر اساس `Retry-After`
- `502 PROVISION_FAILED|RENEW_FAILED`: مبلغ خودکار بازپرداخت شده است
- `400 SEARCH_QUERY_TOO_SHORT`: جست‌وجوی مشتری کمتر از سه کاراکتر است
- `403 CUSTOMER_PASSWORD_NOT_MANAGED`: همکار مالک حساب مشتری نیست
- `404 WALLET_TRANSFER_NOT_FOUND`: شارژ متعلق به این همکار نیست یا قبلاً کامل برگشت خورده است
- `409 INVALID_SUBSCRIPTION_STATE`: عمل کنترل با وضعیت فعلی سرویس سازگار نیست
