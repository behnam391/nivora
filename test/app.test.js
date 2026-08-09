import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildClientPayload, createThreeXuiProvisioner } from '../src/providers/three-x-ui.js';
import { getWalletStatement, postWalletTransaction } from '../src/wallet.js';
import { selectLocationForPlan } from '../src/capacity.js';

const start = async (options = {}) => {
  const db = openDatabase(':memory:');
  const server = createServer(createApp(db, { adminToken: 'test-token', ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
};

test('plan creation, order and manual approval flow', async t => {
  const { server, base } = await start();
  t.after(() => server.close());
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  let r = await fetch(`${base}/api/admin/plans`, { method: 'POST', headers, body: JSON.stringify({ name:'استاندارد', priceIrr:5000000, trafficGb:60, durationDays:30, deviceLimit:2 }) });
  assert.equal(r.status, 201); const plan = await r.json();
  r = await fetch(`${base}/api/orders`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ customerName:'کاربر تست', phone:'09121234567', planId:plan.id, receiptReference:'1234', amountTransferredIrr:5000000 }) });
  assert.equal(r.status, 201); const order = await r.json(); assert.equal(order.status, 'under_review');
  r = await fetch(`${base}/api/admin/orders/${order.id}/approve`, { method:'POST', headers, body:'{}' });
  assert.equal(r.status, 200); const sub = await r.json(); assert.equal(sub.status, 'pending_provision');
});

test('admin dashboard is served and protected API rejects invalid token', async t => {
  const { server, base } = await start();
  t.after(() => server.close());
  let r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /مدیریت Nivora/);
  r = await fetch(`${base}/api/admin/plans`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/reseller`); assert.equal(r.status,200); assert.match(await r.text(),/پنل همکاری Nivora/);
  r = await fetch(`${base}/account`); assert.equal(r.status,200); assert.match(await r.text(),/حساب مشتری Nivora/);
});

test('customer order can only be tracked with its private tracking token', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  const admin = { authorization:'Bearer test-token', 'content-type':'application/json' };
  let r = await fetch(`${base}/api/admin/plans`, {method:'POST',headers:admin,body:JSON.stringify({name:'پایه',priceIrr:1000,trafficGb:10,durationDays:15,deviceLimit:1})});
  const plan = await r.json();
  r = await fetch(`${base}/api/orders`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'کاربر',phone:'09121234567',planId:plan.id,receiptReference:'22'})});
  const order = await r.json();
  assert.ok(order.trackingToken);
  r = await fetch(`${base}/api/orders/${order.id}?token=wrong`); assert.equal(r.status,404);
  r = await fetch(`${base}/api/orders/${order.id}?token=${order.trackingToken}`); assert.equal(r.status,200);
});

test('admin can add multiple payment cards while store only exposes active cards', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  const headers={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/cards`,{method:'POST',headers,body:JSON.stringify({cardNumber:'4111111111111111',cardHolder:'کاربر آزمایشی',active:true})});
  assert.equal(r.status,201);
  r=await fetch(`${base}/api/admin/cards`,{method:'POST',headers,body:JSON.stringify({cardNumber:'6037991234567890',cardHolder:'کارت دوم',active:false})});
  assert.equal(r.status,201);
  r=await fetch(`${base}/api/store-config`);const config=await r.json();
  assert.equal(config.cards.length,1);assert.equal(config.cards[0].card_number,'4111111111111111');
});

test('3X-UI payload uses binary gigabytes and starts expiry after first use', () => {
  const payload = buildClientPayload({ id:'12345678-abcd', phone:'09121234567', plan_name:'استاندارد', traffic_gb:60, duration_days:30, device_limit:2 }, 1);
  assert.equal(payload.client.totalGB, 60 * 1024 ** 3);
  assert.equal(payload.client.expiryTime, -(30 * 24 * 60 * 60 * 1000));
  assert.equal(payload.client.limitIp, 2);
  assert.equal(payload.client.flow, 'xtls-rprx-vision');
  assert.deepEqual(payload.inboundIds, [1]);
});

test('3X-UI provisioner creates client then builds the public subscription URL', async () => {
  const calls = [];
  const transport = async request => {
    calls.push(request);
    return request.method === 'POST' ? { success:true } : { success:true, obj:{ subId:'sample-sub-id' } };
  };
  const provision = createThreeXuiProvisioner({ baseUrl:'https://panel.test/secret', apiToken:'token', inboundId:7, subscriptionBaseUrl:'https://sub.test/nivo/', rejectUnauthorized:true }, transport);
  const result = await provision({ id:'abcdef12-1', phone:'09121234567', plan_name:'پایه', traffic_gb:30, duration_days:30, device_limit:1 });
  assert.equal(calls[0].url.pathname, '/secret/panel/api/clients/add');
  assert.match(result.subscriptionUrl, /^https:\/\/sub\.test\/nivo\/[0-9a-f-]{36}$/);
  await provision.renew({panelClientId:'nivo-client',addDays:30,addTrafficGb:25});
  assert.equal(calls[1].url.pathname,'/secret/panel/api/clients/bulkAdjust');
  assert.deepEqual(calls[1].body,{emails:['nivo-client'],addDays:30,addBytes:25*1024**3,flow:''});
});

test('wallet ledger is atomic, auditable and never allows a negative balance', () => {
  const db=openDatabase(':memory:'),now=new Date().toISOString(),accountId='reseller-1';
  db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at) VALUES(?,?,?,'reseller','active',10,?,?)`).run(accountId,'09120000000','همکار تست',now,now);
  postWalletTransaction(db,{accountId,amountToman:500000,type:'manual_credit',reference:'credit-1',actor:'admin'});
  postWalletTransaction(db,{accountId,amountToman:-125000,type:'purchase',reference:'order-1',actor:'reseller'});
  const wallet=getWalletStatement(db,accountId);
  assert.equal(wallet.balanceToman,375000);assert.equal(wallet.transactions.length,2);
  assert.throws(()=>postWalletTransaction(db,{accountId,amountToman:-400000,type:'purchase',reference:'order-2',actor:'reseller'}),/INSUFFICIENT_BALANCE/);
  assert.equal(getWalletStatement(db,accountId).balanceToman,375000);
  assert.throws(()=>postWalletTransaction(db,{accountId,amountToman:1000,type:'manual_credit',reference:'credit-1',actor:'admin'}),/DUPLICATE_REFERENCE/);
});

test('admin manages reseller wallet and wholesale prices through API', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const headers={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers,body:JSON.stringify({name:'همکاری',priceIrr:200000,trafficGb:50,durationDays:30,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers,body:JSON.stringify({name:'همکار تست',phone:'09121111111',password:'secure-pass-1',role:'reseller',defaultDiscountPercent:15})});assert.equal(r.status,201);const reseller=await r.json();
  r=await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers,body:JSON.stringify({amountToman:500000,note:'شارژ اولیه',reference:'initial-credit'})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{headers});const wallet=await r.json();assert.equal(wallet.balanceToman,500000);
  r=await fetch(`${base}/api/admin/resellers/${reseller.id}/prices`,{method:'POST',headers,body:JSON.stringify({prices:[{planId:plan.id,priceToman:150000,active:true}]})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/admin/resellers/${reseller.id}/prices`,{headers});const prices=await r.json();assert.equal(prices.plans[0].effective_price_toman,150000);
});

test('reseller logs in and purchases a provisioned subscription from wallet', async t => {
  const provisioner=async order=>({panelClientId:`client-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});
  provisioner.renew=async()=>({adjusted:1});
  const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'فروش همکار',priceIrr:100000,trafficGb:30,durationDays:30,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار',phone:'09122222222',password:'password-123',role:'reseller',defaultDiscountPercent:20})});const reseller=await r.json();
  await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:200000,note:'شارژ'})});
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09122222222',password:'password-123'})});assert.equal(r.status,200);const login=await r.json(),auth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,customerName:'مشتری',phone:'09123333333'})});assert.equal(r.status,201);const purchase=await r.json();assert.match(purchase.subscriptionUrl,/sub\.test/);assert.equal(purchase.balanceToman,120000);
  r=await fetch(`${base}/api/reseller/orders`,{headers:auth});const orders=await r.json();
  r=await fetch(`${base}/api/reseller/orders/${orders[0].id}/renew`,{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,201);const renewed=await r.json();assert.equal(renewed.balanceToman,40000);
});

test('failed reseller provisioning is refunded automatically', async t => {
  const {server,base}=await start({provisioner:async()=>{throw new Error('panel down')}});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'خطا',priceIrr:50000,trafficGb:10,durationDays:10,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار خطا',phone:'09124444444',password:'password-123',role:'reseller',defaultDiscountPercent:0})});const reseller=await r.json();
  await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:100000,note:'شارژ'})});
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09124444444',password:'password-123'})});const login=await r.json(),auth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,customerName:'مشتری',phone:'09125555555'})});assert.equal(r.status,502);
  r=await fetch(`${base}/api/reseller/me`,{headers:auth});const me=await r.json();assert.equal(me.balanceToman,100000);assert.ok(me.transactions.some(t=>t.type==='refund'));
});

test('failed reseller renewal is refunded and recorded', async t => {
  const provisioner=async order=>({panelClientId:`c-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});provisioner.renew=async()=>{throw new Error('adjust failed')};
  const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'تمدید خطا',priceIrr:50000,trafficGb:10,durationDays:10,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار تمدید',phone:'09129999999',password:'password-123',role:'reseller',defaultDiscountPercent:0})});const reseller=await r.json();await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:150000,note:'شارژ'})});
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09129999999',password:'password-123'})});const login=await r.json(),auth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,customerName:'مشتری',phone:'09120000001'})});r=await fetch(`${base}/api/reseller/orders`,{headers:auth});const orders=await r.json();
  r=await fetch(`${base}/api/reseller/orders/${orders[0].id}/renew`,{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,502);r=await fetch(`${base}/api/reseller/me`,{headers:auth});const me=await r.json();assert.equal(me.balanceToman,100000);assert.ok(me.transactions.some(t=>t.type==='refund'));
});

test('admin resets legacy reseller password and safely deletes only history-free accounts', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'قابل ویرایش',phone:'09126666666',password:'old-password',role:'reseller',defaultDiscountPercent:5})});const a=await r.json();
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:a.phone,password:'old-password'})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/admin/accounts/${a.id}`,{method:'PATCH',headers:admin,body:JSON.stringify({name:'نام جدید',phone:'09127777777',password:'new-password',defaultDiscountPercent:12})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09127777777',password:'old-password'})});assert.equal(r.status,401);
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09127777777',password:'new-password'})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/admin/accounts/${a.id}`,{method:'DELETE',headers:admin});assert.equal(r.status,200);
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'دارای سابقه',phone:'09128888888',password:'password-123',role:'reseller',defaultDiscountPercent:0})});const b=await r.json();
  await fetch(`${base}/api/admin/accounts/${b.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:1000,note:'سابقه'})});
  r=await fetch(`${base}/api/admin/accounts/${b.id}`,{method:'DELETE',headers:admin});assert.equal(r.status,409);assert.equal((await r.json()).error,'ACCOUNT_HAS_HISTORY');
});

test('customer password recovery is private, rate-safe and completed by admin', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری بازیابی',phone:'09121234567',password:'old-password-1'})});
  assert.equal(r.status,201);
  r=await fetch(`${base}/api/customer/password-reset-requests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09121234567'})});assert.equal(r.status,202);assert.deepEqual(await r.json(),{accepted:true,message:'اگر حسابی با این شماره وجود داشته باشد، درخواست برای مدیر ارسال می‌شود.'});
  r=await fetch(`${base}/api/customer/password-reset-requests`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09129998888'})});assert.equal(r.status,202);
  r=await fetch(`${base}/api/admin/password-reset-requests`,{headers:admin});assert.equal(r.status,200);const requests=await r.json();assert.equal(requests.length,1);assert.equal(requests[0].phone,'09121234567');
  r=await fetch(`${base}/api/admin/password-reset-requests/${requests[0].id}/resolve`,{method:'POST',headers:admin,body:JSON.stringify({password:'new-password-2'})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09121234567',password:'old-password-1'})});assert.equal(r.status,401);
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09121234567',password:'new-password-2'})});assert.equal(r.status,200);
});

test('admin manages locations, plan routing and safe deletion', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'پلن لوکیشن',priceIrr:100000,trafficGb:20,durationDays:30,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/locations`,{method:'POST',headers:admin,body:JSON.stringify({name:'آلمان — نورنبرگ',countryCode:'DE',city:'Nuremberg',provider:'Hetzner',panelInboundId:2,capacity:500})});assert.equal(r.status,201);const location=await r.json();
  r=await fetch(`${base}/api/admin/locations/${location.id}/plans`,{method:'POST',headers:admin,body:JSON.stringify({planIds:[plan.id]})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/plans`);const publicPlans=await r.json();assert.equal(publicPlans[0].locations[0].countryCode,'DE');
  r=await fetch(`${base}/api/admin/locations/${location.id}`,{method:'DELETE',headers:admin});assert.equal(r.status,409);
  await fetch(`${base}/api/admin/locations/${location.id}/plans`,{method:'POST',headers:admin,body:JSON.stringify({planIds:[]})});
  r=await fetch(`${base}/api/admin/locations/${location.id}`,{method:'DELETE',headers:admin});assert.equal(r.status,200);
});

test('capacity selector overflows to the next location and then stops sales', () => {
  const db=openDatabase(':memory:'),now=new Date().toISOString(),plan='p1',l1='l1',l2='l2';
  db.prepare(`INSERT INTO plans(id,name,price_irr,traffic_gb,duration_days,device_limit,created_at,updated_at) VALUES(?,? ,1000,10,30,1,?,?)`).run(plan,'ظرفیت',now,now);
  const addLocation=db.prepare(`INSERT INTO service_locations(id,name,country_code,city,provider,panel_type,panel_inbound_id,capacity,active,created_at,updated_at) VALUES(?,?,?,'','', '3x-ui',?,1,1,?,?)`);
  addLocation.run(l1,'اول','FI',1,now,now);addLocation.run(l2,'دوم','DE',2,now,now);db.prepare('INSERT INTO plan_locations(plan_id,location_id) VALUES(?,?),(?,?)').run(plan,l1,plan,l2);
  const addUsed=(id,location)=>{db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,location_id) VALUES(?,'x','09120000000',?,'approved',?,?)`).run(id,plan,now,location);db.prepare(`INSERT INTO subscriptions(id,order_id,status,created_at) VALUES(?,?,'active',?)`).run(`s-${id}`,id,now)};
  assert.equal(selectLocationForPlan(db,plan).id,l1);addUsed('o1',l1);assert.equal(selectLocationForPlan(db,plan).id,l2);addUsed('o2',l2);assert.equal(selectLocationForPlan(db,plan),null);
});

test('customer renews an active subscription with tracking token and manual receipt approval', async t => {
  const renewCalls=[];
  const provisioner=async order=>({panelClientId:`customer-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});
  provisioner.renew=async input=>{renewCalls.push(input);return {adjusted:1}};
  const {server,base}=await start({provisioner});t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'تمدید مشتری',priceIrr:120000,trafficGb:40,durationDays:30,deviceLimit:2})});
  const plan=await r.json();
  r=await fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'مشتری تمدید',phone:'09120000002',planId:plan.id,receiptReference:'first',amountTransferredIrr:120000})});
  const purchase=await r.json();
  r=await fetch(`${base}/api/admin/orders/${purchase.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,200);
  const originalSub=await r.json();assert.equal(originalSub.status,'active');
  r=await fetch(`${base}/api/orders/${purchase.id}/renew?token=wrong`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receiptReference:'renew'})});assert.equal(r.status,404);
  r=await fetch(`${base}/api/orders/${purchase.id}/renew?token=${purchase.trackingToken}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receiptReference:'renew',receiptImageUrl:'/receipts/test.jpg',amountTransferredIrr:120000})});assert.equal(r.status,201);
  const renewal=await r.json();
  r=await fetch(`${base}/api/admin/orders/${renewal.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,200);
  const renewedSub=await r.json();assert.equal(renewedSub.status,'active');assert.equal(renewedSub.panel_client_id,originalSub.panel_client_id);assert.equal(renewedSub.subscription_url,originalSub.subscription_url);
  assert.deepEqual(renewCalls,[{panelClientId:originalSub.panel_client_id,addDays:30,addTrafficGb:40}]);
});

test('customer account uses wallet for instant purchase and renewal', async t => {
  const renewCalls=[];const provisioner=async o=>({panelClientId:`wallet-${o.id}`,subscriptionUrl:`https://sub.test/${o.id}`});provisioner.renew=async x=>{renewCalls.push(x)};
  const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'کیف پول مشتری',priceIrr:70000,trafficGb:25,durationDays:30,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری کیف پول',phone:'09121112222',password:'customer-pass-1'})});assert.equal(r.status,201);const registration=await r.json(),auth={authorization:`Bearer ${registration.token}`,'content-type':'application/json'};
  await fetch(`${base}/api/admin/accounts/${registration.account.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:150000,note:'شارژ آزمایشی'})});
  r=await fetch(`${base}/api/customer/wallet/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id})});assert.equal(r.status,201);const purchase=await r.json();assert.equal(purchase.balanceToman,80000);
  r=await fetch(`${base}/api/customer/me`,{headers:auth});assert.equal(r.status,200);const me=await r.json();assert.equal(me.orders.length,1);assert.equal(me.orders[0].subscription_status,'active');
  r=await fetch(`${base}/api/customer/orders/${purchase.id}/renew`,{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,201);const renewal=await r.json();assert.equal(renewal.balanceToman,10000);assert.equal(renewCalls.length,1);
  r=await fetch(`${base}/api/customer/wallet/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id})});assert.equal(r.status,400);assert.equal((await r.json()).error,'INSUFFICIENT_BALANCE');
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09121112222',password:'customer-pass-1'})});assert.equal(r.status,200);
});

test('wallet top-up receipt is reviewed once and credits the customer ledger', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری شارژ',phone:'09123334444',password:'topup-pass-1'})});const registration=await r.json(),auth={authorization:`Bearer ${registration.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:250000,receiptReference:'bank-7788',receiptImageUrl:'/receipts/sample.jpg'})});assert.equal(r.status,201);const topup=await r.json();
  r=await fetch(`${base}/api/admin/wallet-topups?status=under_review`,{headers:admin});assert.equal(r.status,200);assert.equal((await r.json()).length,1);
  r=await fetch(`${base}/api/admin/wallet-topups/${topup.id}/approve`,{method:'POST',headers:admin,body:JSON.stringify({note:'تأیید بانکی'})});assert.equal(r.status,200);assert.equal((await r.json()).balanceToman,250000);
  r=await fetch(`${base}/api/admin/wallet-topups/${topup.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,409);
  r=await fetch(`${base}/api/customer/me`,{headers:auth});const me=await r.json();assert.equal(me.balanceToman,250000);assert.equal(me.topups[0].status,'approved');assert.equal(me.transactions.filter(x=>x.reference===`wallet-topup:${topup.id}`).length,1);
  r=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:500,receiptReference:'too-small'})});assert.equal(r.status,400);
});

test('discount limits, support tickets and customer notifications work end to end', async t => {
  const provisioner=async o=>({panelClientId:`promo-${o.id}`,subscriptionUrl:`https://sub.test/${o.id}`});const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'پلن تخفیف',priceIrr:100000,trafficGb:20,durationDays:30,deviceLimit:1})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/discounts`,{method:'POST',headers:admin,body:JSON.stringify({code:'WELCOME20',percent:20,maxUses:5,perCustomerLimit:1})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری پشتیبانی',phone:'09125556666',password:'support-pass-1'})});const reg=await r.json(),auth={authorization:`Bearer ${reg.token}`,'content-type':'application/json'};await fetch(`${base}/api/admin/accounts/${reg.account.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:200000,note:'اعتبار'})});
  r=await fetch(`${base}/api/customer/discount/validate`,{method:'POST',headers:auth,body:JSON.stringify({code:'welcome20'})});assert.equal(r.status,200);assert.equal((await r.json()).percent,20);
  r=await fetch(`${base}/api/customer/wallet/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,discountCode:'WELCOME20'})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/customer/me`,{headers:auth});let me=await r.json();assert.equal(me.balanceToman,120000);
  r=await fetch(`${base}/api/customer/discount/validate`,{method:'POST',headers:auth,body:JSON.stringify({code:'WELCOME20'})});assert.equal(r.status,404);
  r=await fetch(`${base}/api/customer/tickets`,{method:'POST',headers:auth,body:JSON.stringify({subject:'مشکل اتصال',body:'لطفاً اشتراک را بررسی کنید'})});assert.equal(r.status,201);const ticket=await r.json();
  r=await fetch(`${base}/api/admin/tickets/${ticket.id}`,{method:'POST',headers:admin,body:JSON.stringify({body:'بررسی شد؛ دوباره امتحان کنید.'})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/customer/tickets/${ticket.id}`,{headers:auth});const detail=await r.json();assert.equal(detail.messages.length,2);assert.equal(detail.status,'answered');
  r=await fetch(`${base}/api/customer/me`,{headers:auth});me=await r.json();assert.ok(me.notifications.some(n=>n.title==='پاسخ پشتیبانی'));
  r=await fetch(`${base}/api/admin/discounts`,{headers:admin});const codes=await r.json();assert.equal(codes[0].used_count,1);assert.equal(codes[0].total_discount_toman,20000);
});

test('security headers, health diagnostics and authentication rate limits are enforced', async t => {
  const {server,base}=await start();t.after(()=>server.close());let r=await fetch(`${base}/health`);assert.equal(r.status,200);assert.equal(r.headers.get('x-frame-options'),'DENY');assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);const health=await r.json();assert.equal(health.database,'ok');
  for(let i=0;i<10;i++){r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.10'},body:JSON.stringify({phone:'09120000000',password:'invalid-pass'})});assert.equal(r.status,401);}
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.10'},body:JSON.stringify({phone:'09120000000',password:'invalid-pass'})});assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>0);assert.ok(r.headers.get('x-request-id'));
});
