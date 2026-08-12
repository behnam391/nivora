export async function sendSms({ to, message, fetchImpl = fetch }) {
  const url = String(process.env.SMS_PROVIDER_URL || '').trim();
  if (!url) throw new Error('SMS_PROVIDER_NOT_CONFIGURED');
  const headers = { 'content-type': 'application/json' };
  if (process.env.SMS_PROVIDER_TOKEN) headers.authorization = `Bearer ${process.env.SMS_PROVIDER_TOKEN}`;
  const response = await fetchImpl(url, { method:'POST', headers, body:JSON.stringify({ to, message, sender:process.env.SMS_PROVIDER_SENDER || undefined }) });
  if (!response.ok) throw new Error('SMS_DELIVERY_FAILED');
}
