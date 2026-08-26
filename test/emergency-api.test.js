import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { EmergencyPoolError } from '../src/emergency-pool.js';

const ADMIN_TOKEN = 'emergency-admin-test-token';
const DEVICE_A = 'nivora-emergency-device-a-1234567890';
const DEVICE_B = 'nivora-emergency-device-b-1234567890';
const DEVICE_C = 'nivora-emergency-device-c-1234567890';
const SOURCE = 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/Sub1.txt';
const BUNDLE = 'vless://12345678-1234-4234-9234-123456789abc@203.0.114.10:443?encryption=none&security=reality&type=tcp&sni=example.com&pbk=abcdefghijklmnopqrstuvwxyz0123456789#Nivora%20Emergency%201';

function fakeEmergencyPool(overrides = {}) {
  let bundleCalls = 0;
  const status = {
    enabled: true,
    ready: true,
    sources: [SOURCE],
    maxNodes: 3,
    refreshMinutes: 30,
    nodeCount: 1,
    protocols: ['vless'],
    updatedAt: '2026-08-26T00:00:00.000Z',
    accepted: 1,
    rejected: 4,
    sourceCount: 1,
    lastError: ''
  };
  return {
    status: () => ({ ...status, ...(overrides.status || {}) }),
    refresh: async () => ({ ...status, ...(overrides.status || {}) }),
    getBundle: async () => {
      bundleCalls += 1;
      if (overrides.getBundle) return overrides.getBundle();
      return { bundle: BUNDLE, nodeCount: 1, updatedAt: status.updatedAt, stale: false };
    },
    calls: () => bundleCalls
  };
}

async function start(pool = fakeEmergencyPool(), options = {}) {
  const db = openDatabase(':memory:');
  const server = createServer(createApp(db, { adminToken: ADMIN_TOKEN, emergencyPool: pool, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { db, server, pool, base: `http://127.0.0.1:${server.address().port}` };
}

async function registerCustomer(base, deviceId = DEVICE_A, { name = 'Emergency customer', phone = '09121112233' } = {}) {
  const response = await fetch(`${base}/api/customer/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nivora-device': deviceId },
    body: JSON.stringify({
      name,
      phone,
      password: 'emergency-password-123'
    })
  });
  assert.equal(response.status, 201);
  return response.json();
}

function grantActiveSubscription(db, accountId, panelClientId = null, suffix = '') {
  const now = new Date().toISOString();
  const key = suffix ? `-${suffix}` : '';
  const account = db.prepare('SELECT name,phone FROM accounts WHERE id=?').get(accountId);
  db.prepare(`INSERT INTO plans(id,name,price_irr,traffic_gb,duration_days,device_limit,created_at,updated_at)
    VALUES(?,?,100000,20,30,1,?,?)`).run(`emergency-plan${key}`, `Emergency plan${key}`, now, now);
  db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,account_id,order_kind)
    VALUES(?,?,?,?, 'approved',?,?,'purchase')`).run(`emergency-order${key}`, account.name, account.phone, `emergency-plan${key}`, now, accountId);
  db.prepare(`INSERT INTO subscriptions(id,order_id,status,control_status,panel_client_id,created_at,activated_at)
    VALUES(?,?,'active','active',?,?,?)`).run(`emergency-subscription${key}`, `emergency-order${key}`, panelClientId, now, now);
}

const customerHeaders = (session, deviceId = DEVICE_A) => ({
  authorization: `Bearer ${session.token}`,
  'x-nivora-device': deviceId
});

test('emergency subscription requires authentication, a bound device and an active paid subscription', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });

  let response = await fetch(`${context.base}/api/customer/emergency/subscription`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
  assert.equal(context.pool.calls(), 0);

  const session = await registerCustomer(context.base);
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'EMERGENCY_SUBSCRIPTION_REQUIRED' });
  assert.equal(context.pool.calls(), 0);

  grantActiveSubscription(context.db, session.account.id);
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'DEVICE_REQUIRED');
  assert.equal(context.pool.calls(), 0);

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { authorization: `Bearer ${session.token}`, 'x-nivora-device': DEVICE_B }
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'DEVICE_ALREADY_BOUND');
  assert.equal(context.pool.calls(), 0);

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/plain/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('vary') || '', /authorization/i);
  assert.match(response.headers.get('vary') || '', /x-nivora-device/i);
  assert.equal(response.headers.get('x-nivora-emergency'), 'third-party-public');
  assert.equal(response.headers.get('x-nivora-routes'), '1');
  assert.equal(response.headers.get('x-nivora-lease-seconds'), '180');
  assert.equal(await response.text(), BUNDLE);
  assert.equal(context.pool.calls(), 1);

  response = await fetch(`${context.base}/api/customer/emergency/lease`, { headers: customerHeaders(session) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { valid: true, leaseSeconds: 180 });
  assert.equal(context.pool.calls(), 1);
});

test('emergency pool errors expose stable codes and never leak internal failure details', async t => {
  let failure = new EmergencyPoolError('EMERGENCY_SOURCE_UNAVAILABLE', 503);
  const pool = fakeEmergencyPool({ getBundle: async () => { throw failure; } });
  const context = await start(pool);
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);

  let response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'EMERGENCY_SOURCE_UNAVAILABLE' });

  failure = new Error('upstream rejected secret-token-should-never-leak');
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 503);
  const raw = await response.text();
  assert.deepEqual(JSON.parse(raw), { error: 'EMERGENCY_POOL_UNAVAILABLE' });
  assert.doesNotMatch(raw, /secret-token|upstream rejected/i);
});

test('emergency lease is revoked by the server kill switch without exposing a bundle', async t => {
  const context = await start(fakeEmergencyPool({ status: { enabled: false, ready: false, nodeCount: 0 } }));
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const response = await fetch(`${context.base}/api/customer/emergency/lease`, { headers: customerHeaders(session) });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'EMERGENCY_DISABLED' });
  assert.equal(context.pool.calls(), 0);
});

test('expired or exhausted panel subscriptions cannot use the public emergency pool', async t => {
  let panel = { enabled: true, expiryTime: Date.now() - 60_000, totalBytes: 1_000, upBytes: 100, downBytes: 100, syncedAt: Date.now() };
  const context = await start(fakeEmergencyPool(), { panelStatsReader: async () => ({ 'panel-expired': panel }) });
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id, 'panel-expired');

  let response = await fetch(`${context.base}/api/customer/emergency/subscription`, { headers: customerHeaders(session) });
  assert.equal(response.status, 403);
  assert.equal(context.pool.calls(), 0);

  panel = { enabled: true, expiryTime: Date.now() + 60_000, totalBytes: 1_000, upBytes: 500, downBytes: 500, syncedAt: Date.now() };
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, { headers: customerHeaders(session) });
  assert.equal(response.status, 403);
  assert.equal(context.pool.calls(), 0);
});

test('fresh authoritative panel denial cannot be overridden by an active Hysteria entitlement', async t => {
  let panel = {
    enabled: false,
    expiryTime: Date.now() + 24 * 60 * 60_000,
    totalBytes: 10_000,
    upBytes: 100,
    downBytes: 100,
    syncedAt: Date.now()
  };
  const context = await start(fakeEmergencyPool(), {
    panelStatsReader: async () => ({ 'panel-authoritative': panel })
  });
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id, 'panel-authoritative');
  context.db.prepare(`UPDATE subscriptions
    SET hysteria_started_at=?,hysteria_expires_at=?,hysteria_traffic_limit_bytes=?,hysteria_used_bytes=?
    WHERE id='emergency-subscription'`).run(
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      10_000,
      100
    );

  for (const denial of [
    { enabled: false, expiryTime: Date.now() + 24 * 60 * 60_000, totalBytes: 10_000, upBytes: 100, downBytes: 100 },
    { enabled: true, expiryTime: Date.now() - 60_000, totalBytes: 10_000, upBytes: 100, downBytes: 100 },
    { enabled: true, expiryTime: Date.now() + 24 * 60 * 60_000, totalBytes: 10_000, upBytes: 5_000, downBytes: 5_000 }
  ]) {
    panel = { ...denial, syncedAt: Date.now() };
    const response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
      headers: customerHeaders(session)
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'EMERGENCY_SUBSCRIPTION_REQUIRED' });
  }
  assert.equal(context.pool.calls(), 0);
});

test('Reality and Hysteria usage share one panel allowance without double-counting either source', async t => {
  let panel = {
    enabled: true,
    expiryTime: Date.now() + 24 * 60 * 60_000,
    totalBytes: 1_000,
    upBytes: 200,
    downBytes: 200,
    syncedAt: Date.now()
  };
  const context = await start(fakeEmergencyPool(), {
    panelStatsReader: async () => ({ 'panel-shared-quota': panel })
  });
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id, 'panel-shared-quota');
  context.db.prepare(`UPDATE subscriptions
    SET hysteria_started_at=?,hysteria_expires_at=?,hysteria_traffic_limit_bytes=?,hysteria_used_bytes=?
    WHERE id='emergency-subscription'`).run(
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      1_000,
      400
    );

  let response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 200, '40% Reality + 40% Hysteria remains below the shared cap');
  await response.text();

  panel = { ...panel, upBytes: 300, downBytes: 300, syncedAt: Date.now() };
  context.db.prepare("UPDATE subscriptions SET hysteria_used_bytes=600 WHERE id='emergency-subscription'").run();
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: customerHeaders(session)
  });
  assert.equal(response.status, 403, '60% Reality + 60% Hysteria exceeds the shared cap');
  assert.deepEqual(await response.json(), { error: 'EMERGENCY_SUBSCRIPTION_REQUIRED' });
  assert.equal(context.pool.calls(), 1);
});

test('emergency lease bypasses the shared IP bucket after generic API throttling', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const sharedIp = '100.64.12.34';

  let genericResponse;
  for (let index = 0; index < 181; index += 1) {
    genericResponse = await fetch(`${context.base}/api/plans`, {
      headers: { 'x-forwarded-for': sharedIp }
    });
  }
  assert.equal(genericResponse.status, 429);
  assert.equal((await genericResponse.json()).error, 'RATE_LIMITED');

  const leaseResponse = await fetch(`${context.base}/api/customer/emergency/lease`, {
    headers: { ...customerHeaders(session), 'x-forwarded-for': sharedIp }
  });
  assert.equal(leaseResponse.status, 200);
  assert.equal(leaseResponse.headers.get('x-ratelimit-scope'), 'account-device');
  assert.deepEqual(await leaseResponse.json(), { valid: true, leaseSeconds: 180 });

  const subscriptionResponse = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { ...customerHeaders(session), 'x-forwarded-for': sharedIp }
  });
  assert.equal(subscriptionResponse.status, 200);
  assert.equal(subscriptionResponse.headers.get('x-ratelimit-scope'), 'account-device');
  assert.equal(await subscriptionResponse.text(), BUNDLE);
});

test('forged emergency lease requests use a generous pre-auth IP bucket without throttling a valid device', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const sharedIp = '100.64.90.12';

  let response;
  for (let index = 0; index < 300; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/lease`, {
      headers: { authorization: 'Bearer forged-token', 'x-forwarded-for': sharedIp }
    });
  }
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'failure-ip');

  response = await fetch(`${context.base}/api/customer/emergency/lease`, {
    headers: { authorization: 'Bearer forged-token', 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'failure-ip');
  assert.match(response.headers.get('retry-after') || '', /^\d+$/);
  assert.equal((await response.json()).error, 'EMERGENCY_LEASE_PREAUTH_RATE_LIMITED');

  response = await fetch(`${context.base}/api/customer/emergency/lease`, {
    headers: { ...customerHeaders(session), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.deepEqual(await response.json(), { valid: true, leaseSeconds: 180 });
});

test('forged emergency subscription requests use a dedicated pre-auth bucket without blocking a valid bundle', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const sharedIp = '100.64.90.13';

  let response;
  for (let index = 0; index < 300; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
      headers: { authorization: 'Bearer forged-token', 'x-forwarded-for': sharedIp }
    });
  }
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'failure-ip');

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { authorization: 'Bearer forged-token', 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'failure-ip');
  assert.match(response.headers.get('retry-after') || '', /^\d+$/);
  assert.equal((await response.json()).error, 'EMERGENCY_SUBSCRIPTION_PREAUTH_RATE_LIMITED');

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { ...customerHeaders(session), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.equal(await response.text(), BUNDLE);
});

test('valid sessions with missing or malformed devices are eventually failure-IP limited on both emergency endpoints', async t => {
  const cases = [
    { endpoint: 'lease', deviceId: '', sharedIp: '100.64.91.10' },
    { endpoint: 'subscription', deviceId: 'invalid', sharedIp: '100.64.91.11' }
  ];
  for (const item of cases) {
    const context = await start();
    t.after(() => { context.server.close(); context.db.close(); });
    const session = await registerCustomer(context.base);
    grantActiveSubscription(context.db, session.account.id);
    const headers = {
      authorization: `Bearer ${session.token}`,
      'x-forwarded-for': item.sharedIp,
      ...(item.deviceId ? { 'x-nivora-device': item.deviceId } : {})
    };

    let response = await fetch(`${context.base}/api/customer/emergency/${item.endpoint}`, { headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'DEVICE_REQUIRED');
    for (let index = 1; index < 350; index += 1) {
      response = await fetch(`${context.base}/api/customer/emergency/${item.endpoint}`, { headers });
    }
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('x-ratelimit-scope'), 'failure-ip');
    assert.match((await response.json()).error, /^EMERGENCY_(?:LEASE|SUBSCRIPTION)_DEVICE_RATE_LIMITED$/);

    const safeSession = await registerCustomer(context.base, DEVICE_C, {
      name: 'CGNAT safe customer',
      phone: '09121112234'
    });
    grantActiveSubscription(context.db, safeSession.account.id, null, `safe-${item.endpoint}`);
    response = await fetch(`${context.base}/api/customer/emergency/${item.endpoint}`, {
      headers: { ...customerHeaders(safeSession, DEVICE_C), 'x-forwarded-for': item.sharedIp }
    });
    assert.equal(response.status, 200, 'a valid different account must bypass the saturated shared failure-IP bucket');
    if (item.endpoint === 'lease') assert.deepEqual(await response.json(), { valid: true, leaseSeconds: 180 });
    else assert.equal(await response.text(), BUNDLE);
  }
});

test('valid-device limiter runs before claimCustomerDevice can update last_seen_at', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const headers = customerHeaders(session);

  let response;
  for (let index = 0; index < 10; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/subscription`, { headers });
    assert.equal(response.status, 200);
    await response.text();
  }
  const device = context.db.prepare("SELECT id FROM account_devices WHERE account_id=? AND status='active'").get(session.account.id);
  const sentinel = '2000-01-01T00:00:00.000Z';
  context.db.prepare('UPDATE account_devices SET last_seen_at=? WHERE id=?').run(sentinel, device.id);

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, { headers });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.equal(context.db.prepare('SELECT last_seen_at FROM account_devices WHERE id=?').get(device.id).last_seen_at, sentinel);
});

test('rotating valid-format device IDs cannot bypass the per-account emergency ceiling', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id);
  const sharedIp = '100.64.91.12';

  let response;
  for (let index = 0; index < 20; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        'x-nivora-device': `nivora-rotated-device-${String(index).padStart(4, '0')}`,
        'x-forwarded-for': sharedIp
      }
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'DEVICE_ALREADY_BOUND');
  }
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      'x-nivora-device': 'nivora-rotated-device-final',
      'x-forwarded-for': sharedIp
    }
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account');
  assert.equal((await response.json()).error, 'EMERGENCY_SUBSCRIPTION_ACCOUNT_RATE_LIMITED');
});

test('emergency lease and subscription limiters are isolated per authenticated account and bound device behind CGNAT', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });
  const first = await registerCustomer(context.base, DEVICE_A);
  const second = await registerCustomer(context.base, DEVICE_C, {
    name: 'Second emergency customer',
    phone: '09121112234'
  });
  grantActiveSubscription(context.db, first.account.id, null, 'first');
  grantActiveSubscription(context.db, second.account.id, null, 'second');
  const sharedIp = '100.64.56.78';

  let response;
  for (let index = 0; index < 30; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/lease`, {
      headers: { ...customerHeaders(first, DEVICE_A), 'x-forwarded-for': sharedIp }
    });
    assert.equal(response.status, 200);
  }
  response = await fetch(`${context.base}/api/customer/emergency/lease`, {
    headers: { ...customerHeaders(first, DEVICE_A), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.match(response.headers.get('retry-after') || '', /^\d+$/);
  assert.equal((await response.json()).error, 'EMERGENCY_LEASE_RATE_LIMITED');

  response = await fetch(`${context.base}/api/customer/emergency/lease`, {
    headers: { ...customerHeaders(second, DEVICE_C), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.deepEqual(await response.json(), { valid: true, leaseSeconds: 180 });

  for (let index = 0; index < 10; index += 1) {
    response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
      headers: { ...customerHeaders(first, DEVICE_A), 'x-forwarded-for': sharedIp }
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { ...customerHeaders(first, DEVICE_A), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.equal((await response.json()).error, 'EMERGENCY_SUBSCRIPTION_RATE_LIMITED');

  response = await fetch(`${context.base}/api/customer/emergency/subscription`, {
    headers: { ...customerHeaders(second, DEVICE_C), 'x-forwarded-for': sharedIp }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ratelimit-scope'), 'account-device');
  assert.equal(await response.text(), BUNDLE);
});

test('missing or stale entitlement telemetry fails closed after a short provisioning grace', async t => {
  const context = await start(fakeEmergencyPool(), { panelStatsReader: async () => ({
    'missing-from-panel': { enabled: true, expiryTime: Date.now() + 24 * 60 * 60_000, totalBytes: 1_000, upBytes: 10, downBytes: 10, syncedAt: Date.now() - 60 * 60_000 }
  }) });
  t.after(() => { context.server.close(); context.db.close(); });
  const session = await registerCustomer(context.base);
  grantActiveSubscription(context.db, session.account.id, 'missing-from-panel');
  context.db.prepare("UPDATE subscriptions SET activated_at=? WHERE id='emergency-subscription'")
    .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString());

  let response = await fetch(`${context.base}/api/customer/emergency/subscription`, { headers: customerHeaders(session) });
  assert.equal(response.status, 403);
  assert.equal(context.pool.calls(), 0);

  response = await fetch(`${context.base}/api/customer/me`, { headers: customerHeaders(session) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).emergency, { enabled: false, ready: false, nodeCount: 0, updatedAt: null });
});

test('emergency administration is authenticated and returns only the safe pool summary', async t => {
  const context = await start();
  t.after(() => { context.server.close(); context.db.close(); });

  let response = await fetch(`${context.base}/api/admin/emergency-settings`);
  assert.equal(response.status, 401);
  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    headers: { authorization: 'Bearer wrong-token' }
  });
  assert.equal(response.status, 401);

  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const summary = JSON.parse(raw);
  assert.equal(summary.ready, true);
  assert.equal(summary.nodeCount, 1);
  assert.deepEqual(summary.sources, [SOURCE]);
  assert.equal(Object.hasOwn(summary, 'bundle'), false);
  assert.doesNotMatch(raw, /vless:\/\/|12345678-1234|secret/i);

  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false, sources: [SOURCE], maxNodes: 3, refreshMinutes: 5 })
  });
  assert.equal(response.status, 401);
  assert.equal(context.db.prepare("SELECT value FROM app_settings WHERE key='emergency_enabled'").get(), undefined);

  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: false,
      sources: [SOURCE],
      maxNodes: 3,
      refreshMinutes: 5,
      bundle: BUNDLE,
      token: 'secret-token-should-be-ignored'
    })
  });
  assert.equal(response.status, 200);
  const savedRaw = await response.text();
  assert.doesNotMatch(savedRaw, /vless:\/\/|secret-token/i);
  assert.equal(context.db.prepare("SELECT value FROM app_settings WHERE key='emergency_enabled'").get().value, 'false');
  assert.equal(context.db.prepare("SELECT value FROM app_settings WHERE key='emergency_cache'").get(), undefined);
  assert.equal(context.db.prepare("SELECT value FROM app_settings WHERE key='token'").get(), undefined);
  const audit = context.db.prepare("SELECT details FROM audit_log WHERE entity_type='emergency_settings' ORDER BY id DESC LIMIT 1").get();
  assert.ok(audit);
  assert.doesNotMatch(audit.details, /vless:\/\/|secret-token/i);

  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(response.status, 200);
  context.db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('emergency_cache','old-cache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(new Date().toISOString());
  response = await fetch(`${context.base}/api/admin/emergency-settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(response.status, 200);
  assert.equal(context.db.prepare("SELECT value FROM app_settings WHERE key='emergency_cache'").get().value, '');
});
