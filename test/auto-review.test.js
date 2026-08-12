import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

process.env.SMS_WEBHOOK_SECRET = 'test-secret';

const start = async (options = {}) => {
  const db = openDatabase(':memory:');
  const server = createServer(createApp(db, { adminToken: 'test-token', ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
};

const admin = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const provisioner = async order => ({ panelClientId: `client-${order.id}`, subscriptionUrl: `https://sub.test/${order.id}` });

async function makePlan(base, priceIrr = 25000) {
  const r = await fetch(`${base}/api/admin/plans`, { method: 'POST', headers: admin, body: JSON.stringify({ name: 'پلن تست', priceIrr, trafficGb: 30, durationDays: 30, deviceLimit: 1 }) });
  return (await r.json()).id;
}
const order = (base, planId, body) => fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customerName: 'مشتری', phone: '09120000000', planId, ...body }) }).then(r => r.json());
const ingest = (base, message, extra = {}) => fetch(`${base}/api/sms/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'test-secret' }, body: JSON.stringify({ message, ...extra }) });
const statusOf = (base, id, token) => fetch(`${base}/api/orders/${id}?token=${token}`).then(r => r.json());

test('a unique same-amount bank deposit auto-approves a pending order', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  const planId = await makePlan(base, 25000); // price_irr = 250000
  const o = await order(base, planId, { receiptImageUrl: '/receipts/a.jpg' });
  let s = await statusOf(base, o.id, o.trackingToken);
  assert.equal(s.status, 'under_review'); // no deposit yet

  const r = await ingest(base, 'واریز به حساب شما مبلغ 250,000 ریال\nشماره پیگیری 123456');
  assert.equal(r.status, 201);
  s = await statusOf(base, o.id, o.trackingToken);
  assert.equal(s.status, 'approved');
  assert.equal(s.subscription_status, 'active');
});

test('a tracking code already consumed by another order is auto-rejected as duplicate', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  const planId = await makePlan(base, 25000);
  await ingest(base, 'واریز مبلغ 250,000 ریال پیگیری 778899'); // deposit waiting, unmatched
  const first = await order(base, planId, { receiptImageUrl: '/receipts/b.jpg' }); // approved on create by unique amount
  assert.equal((await statusOf(base, first.id, first.trackingToken)).status, 'approved');

  const second = await order(base, planId, { receiptReference: '778899', receiptImageUrl: '/receipts/c.jpg' });
  const s = await statusOf(base, second.id, second.trackingToken);
  assert.equal(s.status, 'rejected');
});

test('multiple same-amount deposits stay manual (ambiguous), order remains under review', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  const planId = await makePlan(base, 25000);
  await ingest(base, 'واریز مبلغ 250,000 ریال پیگیری 111111');
  await ingest(base, 'واریز مبلغ 250,000 ریال پیگیری 222222');
  const o = await order(base, planId, { receiptImageUrl: '/receipts/d.jpg' });
  const s = await statusOf(base, o.id, o.trackingToken);
  assert.equal(s.status, 'under_review');
});

test('a deposit with the wrong amount does not approve the order', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  const planId = await makePlan(base, 25000);
  const o = await order(base, planId, { receiptImageUrl: '/receipts/e.jpg' });
  await ingest(base, 'واریز مبلغ 300,000 ریال پیگیری 909090');
  const s = await statusOf(base, o.id, o.trackingToken);
  assert.equal(s.status, 'under_review');
});

test('an epoch receivedAt from a forwarder app is normalised and still matches', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  const planId = await makePlan(base, 25000);
  const o = await order(base, planId, { receiptImageUrl: '/receipts/f.jpg' });
  const epochMs = String(Date.now());
  const r = await ingest(base, 'واریز مبلغ 250,000 ریال پیگیری 424242', { receivedAt: epochMs });
  assert.equal(r.status, 201);
  assert.equal((await statusOf(base, o.id, o.trackingToken)).status, 'approved');
});

test('SMS webhook rejects a wrong secret and ignores debit messages', async t => {
  const { server, base } = await start({ provisioner }); t.after(() => server.close());
  let r = await fetch(`${base}/api/sms/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 'nope' }, body: JSON.stringify({ message: 'x' }) });
  assert.equal(r.status, 401);
  r = await ingest(base, 'خرید مبلغ 250,000 ریال از حساب شما برداشت شد');
  const body = await r.json();
  assert.equal(body.usable, false); // debit is stored but not usable for matching
});
