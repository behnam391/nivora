import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildClientPayload, buildCompatibleClientPayload, createThreeXuiProvisioner } from '../src/providers/three-x-ui.js';
import { getWalletStatement, postWalletTransaction } from '../src/wallet.js';
import { selectLocationForPlan } from '../src/capacity.js';
import { hashPassword } from '../src/auth.js';

const start = async (options = {}) => {
  const db = openDatabase(':memory:');
  const server = createServer(createApp(db, { adminToken: 'test-token', ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
};

const receiptPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XlRFAAAAAElFTkSuQmCC','base64');
const uploadReceipt=async(base,token='')=>{
  const headers={'content-type':'application/json'};if(token)headers.authorization=`Bearer ${token}`;
  const response=await fetch(`${base}/api/receipts`,{method:'POST',headers,body:JSON.stringify({mimeType:'image/png',data:receiptPng.toString('base64')})});
  assert.equal(response.status,201);const receipt=await response.json(),filename=new URL(receipt.url,base).pathname.split('/').at(-1);
  return {...receipt,cleanup:()=>unlink(resolve('receipts',filename)).catch(()=>{})};
};

test('plan creation, order and manual approval flow', async t => {
  const { server, base } = await start();
  t.after(() => server.close());
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
  let r = await fetch(`${base}/api/admin/plans`, { method: 'POST', headers, body: JSON.stringify({ name:'استاندارد', priceIrr:5000000, trafficGb:60, durationDays:30, deviceLimit:2 }) });
  assert.equal(r.status, 201); const plan = await r.json();
  const receipt=await uploadReceipt(base);t.after(receipt.cleanup);
  r = await fetch(`${base}/api/orders`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ customerName:'کاربر تست', phone:'09121234567', planId:plan.id, receiptReference:'1234',receiptImageUrl:receipt.url, amountTransferredIrr:5000000 }) });
  assert.equal(r.status, 201); const order = await r.json(); assert.equal(order.status, 'under_review');
  r = await fetch(`${base}/api/admin/orders/${order.id}/approve`, { method:'POST', headers, body:'{}' });
  assert.equal(r.status, 200); const sub = await r.json(); assert.equal(sub.status, 'pending_provision');
});

test('admin dashboard is served and protected API rejects invalid token', async t => {
  const { server, base } = await start();
  t.after(() => server.close());
  let r = await fetch(`${base}/admin`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(await r.text(), /مدیریت Nivora/);
  r = await fetch(`${base}/api/admin/plans`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/reseller`); assert.equal(r.status,200); assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow, noarchive'); assert.match(await r.text(),/پنل همکاری Nivora/);
  r = await fetch(`${base}/account`); assert.equal(r.status,200); assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow, noarchive'); assert.match(await r.text(),/حساب مشتری Nivora/);
  r = await fetch(`${base}/brand-mark.png`); assert.equal(r.status,200); assert.equal(r.headers.get('content-type'),'image/png'); assert.ok((await r.arrayBuffer()).byteLength>1000);
});

test('public landing is separated from private commerce pages and robots policy', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  let r=await fetch(`${base}/`);assert.equal(r.status,200);assert.equal(r.headers.get('x-robots-tag'),null);
  const landing=await r.text();assert.match(landing,/استودیوی نرم‌افزار و ابزارهای هوشمند/);assert.match(landing,/studio-mark\.svg/);assert.doesNotMatch(landing,/مشاهده پلن‌ها|brand-mark\.png|\/account|\/reseller|\/admin|\/store|\/api|\/sub|\/download|\/receipts|VPN|proxy|فیلترشکن|اشتراک/i);
  r=await fetch(`${base}/landing.css`);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/css/);assert.ok((await r.text()).length>1000);
  r=await fetch(`${base}/studio-mark.svg`);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^image\/svg\+xml/);assert.match(await r.text(),/<svg/);
  for(const route of ['/store','/store/']){
    r=await fetch(`${base}${route}`);assert.equal(r.status,200);assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');assert.match(await r.text(),/مشاهده پلن‌ها/);
  }
  for(const route of ['/account/','/reseller/','/admin/']){
    r=await fetch(`${base}${route}`);assert.equal(r.status,200);assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow, noarchive');
  }
  r=await fetch(`${base}/robots.txt`);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/plain/);
  const robots=await r.text();assert.match(robots,/^User-agent: \*$/m);assert.match(robots,/^Allow: \/$/m);
  assert.doesNotMatch(robots,/\/store|\/account|\/reseller|\/admin|\/api|\/sub|\/receipts|\/download/);
});

test('admin signs in with username and password and receives an expiring session', async t => {
  const password=hashPassword('StrongAdminPass123');
  const {server,base}=await start({adminUsername:'behnam',adminPasswordSalt:password.salt,adminPasswordHash:password.hash});
  t.after(()=>server.close());
  let r=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'behnam',password:'wrong-password'})});
  assert.equal(r.status,401);
  r=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'behnam',password:'StrongAdminPass123'})});
  assert.equal(r.status,200);const session=await r.json();assert.ok(session.token);assert.equal(session.expiresInHours,12);
  r=await fetch(`${base}/api/admin/plans`,{headers:{authorization:`Bearer ${session.token}`}});assert.equal(r.status,200);
});

test('admin changes password and previous browser sessions are revoked', async t => {
  const password=hashPassword('StrongAdminPass123');
  const {server,base}=await start({adminUsername:'behnam',adminPasswordSalt:password.salt,adminPasswordHash:password.hash});
  t.after(()=>server.close());
  let r=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'behnam',password:'StrongAdminPass123'})});
  const oldSession=await r.json(),headers={authorization:`Bearer ${oldSession.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/admin/change-password`,{method:'POST',headers,body:JSON.stringify({currentPassword:'wrong-password',newPassword:'NewStrongAdmin456'})});assert.equal(r.status,400);
  r=await fetch(`${base}/api/admin/change-password`,{method:'POST',headers,body:JSON.stringify({currentPassword:'StrongAdminPass123',newPassword:'NewStrongAdmin456'})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/admin/plans`,{headers});assert.equal(r.status,401);
  r=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'behnam',password:'StrongAdminPass123'})});assert.equal(r.status,401);
  r=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'behnam',password:'NewStrongAdmin456'})});assert.equal(r.status,200);
});

test('customer order can only be tracked with its private tracking token', async t => {
  const { server, base } = await start(); t.after(() => server.close());
  const admin = { authorization:'Bearer test-token', 'content-type':'application/json' };
  let r = await fetch(`${base}/api/admin/plans`, {method:'POST',headers:admin,body:JSON.stringify({name:'پایه',priceIrr:1000,trafficGb:10,durationDays:15,deviceLimit:1})});
  const plan = await r.json();
  r = await fetch(`${base}/api/orders`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'کاربر',phone:'09121234567',planId:plan.id})});
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
  assert.deepEqual(buildClientPayload({ id:'12345678-abcd', phone:'09121234567', plan_name:'استاندارد', traffic_gb:60, duration_days:30, device_limit:2 }, 1, [2,3]).inboundIds, [1,2,3]);
  assert.deepEqual(buildClientPayload({ id:'87654321-abcd', phone:'09121234567', plan_name:'CDN', traffic_gb:10, duration_days:30, device_limit:1, panel_inbound_id:4, panel_cdn_inbound_id:9 }, 1).inboundIds, [4,9]);
  const compatible=buildCompatibleClientPayload(payload.client,[7,6,7]);
  assert.deepEqual(compatible.inboundIds,[7,6]);assert.equal(compatible.client.flow,'');assert.equal(compatible.client.id,payload.client.id);assert.equal(compatible.client.subId,payload.client.subId);
  assert.equal(buildCompatibleClientPayload(payload.client,[7], '', 0).client.limitIp,0);
});

test('3X-UI provisioner adds CDN transports with the same identity and empty flow', async () => {
  const calls=[];
  const transport=async request=>{calls.push(request);return {success:true,obj:request.body?.client||{}}};
  const provision=createThreeXuiProvisioner({baseUrl:'https://panel.test',apiToken:'token',inboundId:1,cdnInboundIds:[7,6],subscriptionBaseUrl:'https://sub.test/nivo',rejectUnauthorized:true},transport);
  await provision({id:'abcdef12-test',phone:'09121234567',plan_name:'Smart',traffic_gb:20,duration_days:30,device_limit:1});
  assert.equal(calls.length,2);assert.deepEqual(calls[1].body.inboundIds,[7,6]);
  assert.equal(calls[1].body.client.id,calls[0].body.client.id);assert.equal(calls[1].body.client.subId,calls[0].body.client.subId);assert.equal(calls[1].body.client.flow,'');
  assert.equal(calls[1].body.client.limitIp,0);
});

test('3X-UI provisioner can disable the source-IP limiter for multi-route subscriptions', async () => {
  const calls=[];
  const transport=async request=>{calls.push(request);return {success:true,obj:request.body?.client||{}}};
  const provision=createThreeXuiProvisioner({baseUrl:'https://panel.test',apiToken:'token',inboundId:1,visionInboundIds:[2],cdnInboundIds:[7],disableIpLimit:true,subscriptionBaseUrl:'https://sub.test/nivo'},transport);
  await provision({id:'abcdef12-test',phone:'09121234567',plan_name:'Smart',traffic_gb:20,duration_days:30,device_limit:3});
  assert.equal(calls[0].body.client.limitIp,0);
  assert.equal(calls[1].body.client.limitIp,0);
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
  r=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,customerName:'مشتری',phone:'09123333333'})});assert.equal(r.status,201);const purchase=await r.json();assert.match(purchase.subscriptionUrl,/\/sub\/[a-f0-9]{32}$/);assert.equal(purchase.balanceToman,120000);
  r=await fetch(`${base}/api/reseller/orders`,{headers:auth});const orders=await r.json();
  r=await fetch(`${base}/api/reseller/orders/${orders[0].id}/renew`,{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,201);const renewed=await r.json();assert.equal(renewed.balanceToman,40000);
});

test('reseller support conversations and admin operation alerts work end to end', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'Support Partner',phone:'09127777777',password:'password-123',role:'reseller'})});const reseller=await r.json();
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:reseller.phone,password:'password-123'})});const login=await r.json(),auth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/reseller/tickets`,{method:'POST',headers:auth,body:JSON.stringify({subject:'Wallet question',body:'Please review my balance.'})});assert.equal(r.status,201);const ticket=await r.json();
  r=await fetch(`${base}/api/admin/notifications`,{headers:admin});const alerts=await r.json();assert.equal(alerts.counts.openTickets,1);assert.equal(alerts.items[0].type,'ticket');
  r=await fetch(`${base}/api/admin/tickets/${ticket.id}`,{method:'POST',headers:admin,body:JSON.stringify({body:'Your balance is correct.'})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/reseller/tickets/${ticket.id}`,{headers:auth});const conversation=await r.json();assert.equal(conversation.messages.length,2);assert.equal(conversation.status,'answered');
  r=await fetch(`${base}/api/reseller/me`,{headers:auth});const me=await r.json();assert.ok(me.notifications.some(x=>x.title));
});

test('reseller customer book scopes profiles, sales, renewals and profit to its owner', async t => {
  const provisioner=async order=>({panelClientId:`book-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});provisioner.renew=async()=>({adjusted:1});
  const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'دفترچه',priceIrr:100000,trafficGb:40,durationDays:30,deviceLimit:2})});const plan=await r.json();
  r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار دفترچه',phone:'09120001111',password:'password-123',role:'reseller',defaultDiscountPercent:20})});const reseller=await r.json();
  await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:300000,note:'شارژ'})});
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:reseller.phone,password:'password-123'})});const login=await r.json(),auth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  r=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:auth,body:JSON.stringify({name:'مشتری دفترچه',phone:'09123330000',note:'مشتری ویژه'})});assert.equal(r.status,201);const customer=await r.json();
  r=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id,customerId:customer.id,salePriceToman:130000})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/reseller/customers`,{headers:auth});let customers=await r.json();assert.equal(customers.length,1);assert.equal(customers[0].active_subscriptions,1);assert.equal(customers[0].revenue_toman,130000);assert.equal(customers[0].profit_toman,50000);
  r=await fetch(`${base}/api/reseller/customers/${customer.id}`,{headers:auth});const profile=await r.json();assert.equal(profile.orders.length,1);assert.equal(profile.orders[0].reseller_sale_price_toman,130000);
  r=await fetch(`${base}/api/reseller/orders/${profile.orders[0].id}/renew`,{method:'POST',headers:auth,body:JSON.stringify({salePriceToman:120000})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/reseller/me`,{headers:auth});const summary=await r.json();assert.equal(summary.customersCount,1);assert.equal(summary.salesCount,1);assert.equal(summary.totalRevenueToman,250000);assert.equal(summary.totalProfitToman,90000);
  r=await fetch(`${base}/api/reseller/customers/${customer.id}`,{method:'PATCH',headers:auth,body:JSON.stringify({name:'مشتری ویرایش‌شده',phone:'09123330001',note:'پیگیری ماهانه'})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09123330001',password:customer.temporaryPassword})});assert.equal(r.status,200);
  r=await fetch(`${base}/api/reseller/customers/${customer.id}`,{method:'DELETE',headers:auth});assert.equal(r.status,200);
  r=await fetch(`${base}/api/reseller/customers`,{headers:auth});customers=await r.json();assert.equal(customers.length,0);
});

test('reseller wallet credits are atomic, shared-customer safe and reversible only by their owner', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  const createReseller=async(name,phone)=>{let r=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name,phone,password:'password-123',role:'reseller'})});const reseller=await r.json();await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:100000,note:'اعتبار تست'})});r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,password:'password-123'})});const login=await r.json();return {reseller,auth:{authorization:`Bearer ${login.token}`,'content-type':'application/json'}}};
  const a=await createReseller('همکار الف','09121111001'),b=await createReseller('همکار ب','09121111002');
  let r=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:a.auth,body:JSON.stringify({name:'مشتری مشترک',phone:'09123334444',password:'customer-pass-1'})});assert.equal(r.status,201);const customer=await r.json();
  r=await fetch(`${base}/api/reseller/customers/${customer.account_id}/wallet`,{method:'POST',headers:a.auth,body:JSON.stringify({amountToman:30000,note:'شارژ الف'})});assert.equal(r.status,201);const creditA=await r.json();assert.equal(creditA.balanceToman,30000);assert.equal(creditA.resellerBalanceToman,70000);
  r=await fetch(`${base}/api/reseller/customer-directory?q=09`,{headers:b.auth});assert.equal(r.status,400);
  r=await fetch(`${base}/api/reseller/customer-directory?q=3444`,{headers:b.auth});assert.equal(r.status,200);assert.ok((await r.json()).some(row=>row.id===customer.account_id));
  r=await fetch(`${base}/api/reseller/customers/${customer.account_id}/wallet`,{method:'POST',headers:b.auth,body:JSON.stringify({amountToman:20000,note:'شارژ ب'})});assert.equal(r.status,201);const creditB=await r.json();assert.equal(creditB.balanceToman,50000);
  r=await fetch(`${base}/api/reseller/customers`,{headers:b.auth});const bCustomers=await r.json(),bCustomer=bCustomers.find(row=>row.account_id===customer.account_id);assert.ok(bCustomer);
  r=await fetch(`${base}/api/reseller/customers/${bCustomer.id}`,{headers:b.auth});const bProfile=await r.json();assert.equal(bProfile.password_managed,0);
  r=await fetch(`${base}/api/reseller/customers/${bCustomer.id}/reset-password`,{method:'POST',headers:b.auth,body:JSON.stringify({password:'blocked-pass-1'})});assert.equal(r.status,403);
  r=await fetch(`${base}/api/reseller/wallet-transfers/${creditB.transferId}/reverse`,{method:'POST',headers:a.auth,body:'{}'});assert.equal(r.status,404);
  r=await fetch(`${base}/api/reseller/wallet-transfers/${creditA.transferId}/reverse`,{method:'POST',headers:a.auth,body:JSON.stringify({amountToman:10000,reason:'اصلاح مبلغ'})});assert.equal(r.status,200);const reversal=await r.json();assert.equal(reversal.balanceToman,40000);assert.equal(reversal.resellerBalanceToman,80000);assert.equal(reversal.remainingAmountToman,20000);
  r=await fetch(`${base}/api/reseller/wallet-transfers/${creditA.transferId}/reverse`,{method:'POST',headers:a.auth,body:JSON.stringify({amountToman:30000})});assert.equal(r.status,400);assert.equal((await r.json()).error,'INVALID_REVERSAL_AMOUNT');
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09123334444',password:'customer-pass-1'})});assert.equal(r.status,200);const customerLogin=await r.json();r=await fetch(`${base}/api/customer/me`,{headers:{authorization:`Bearer ${customerLogin.token}`}});const me=await r.json();assert.equal(me.balanceToman,40000);
  r=await fetch(`${base}/api/reseller/me`,{headers:a.auth});const resellerMe=await r.json();assert.equal(resellerMe.walletTransfers[0].status,'partially_reversed');
});

test('reseller sales belong to the customer account while subscription control stays with the seller', async t => {
  const controls=[];const provisioner=async order=>({panelClientId:`owned-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});provisioner.renew=async()=>({adjusted:1});provisioner.suspend=async args=>controls.push(['suspend',args]);provisioner.resume=async args=>controls.push(['resume',args]);provisioner.remove=async args=>controls.push(['remove',args]);
  const {server,base}=await start({provisioner});t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let r=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'اشتراک همکار',priceIrr:100000,trafficGb:25,durationDays:30,deviceLimit:1})});const plan=await r.json();
  const createReseller=async(name,phone)=>{let response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name,phone,password:'password-123',role:'reseller'})});const reseller=await response.json();await fetch(`${base}/api/admin/accounts/${reseller.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:100000,note:'اعتبار'})});response=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,password:'password-123'})});const login=await response.json();return {auth:{authorization:`Bearer ${login.token}`,'content-type':'application/json'}}};
  const seller=await createReseller('فروشنده اصلی','09121112001'),other=await createReseller('فروشنده دیگر','09121112002');
  r=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:seller.auth,body:JSON.stringify({name:'کاربر متصل',phone:'09124445555',password:'customer-pass-2'})});const customer=await r.json();
  r=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:seller.auth,body:JSON.stringify({planId:plan.id,customerId:customer.id})});assert.equal(r.status,201);
  r=await fetch(`${base}/api/reseller/orders`,{headers:seller.auth});const orders=await r.json(),order=orders.find(x=>x.order_kind==='purchase');assert.ok(order);
  r=await fetch(`${base}/api/reseller/orders/${order.id}/suspend`,{method:'POST',headers:other.auth,body:JSON.stringify({reason:'غیرمجاز'})});assert.equal(r.status,404);
  r=await fetch(`${base}/api/reseller/orders/${order.id}/suspend`,{method:'POST',headers:seller.auth,body:JSON.stringify({reason:'عدم تسویه آزمایشی'})});assert.equal(r.status,200);assert.equal(controls.length,1);
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09124445555',password:'customer-pass-2'})});const login=await r.json();r=await fetch(`${base}/api/customer/me`,{headers:{authorization:`Bearer ${login.token}`}});const me=await r.json();assert.equal(me.orders.length,1);assert.equal(me.orders[0].control_status,'suspended');assert.ok(me.notifications.some(x=>x.title==='اشتراک تعلیق شد'));
  r=await fetch(`${base}/api/reseller/orders/${order.id}/suspend`,{method:'POST',headers:seller.auth,body:JSON.stringify({reason:'تکراری'})});assert.equal(r.status,409);
  r=await fetch(`${base}/api/reseller/orders/${order.id}/resume`,{method:'POST',headers:seller.auth,body:'{}'});assert.equal(r.status,200);assert.equal(controls.length,2);
  r=await fetch(`${base}/api/admin/orders/${order.id}/suspend`,{method:'POST',headers:admin,body:JSON.stringify({reason:'بررسی مدیریت'})});assert.equal(r.status,200);assert.equal(controls.length,3);
  r=await fetch(`${base}/api/admin/orders/${order.id}/resume`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,200);assert.equal(controls.length,4);
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

test('customer web login works while device binding remains exclusive and admin can reset it', async t => {
  const {server,base}=await start({enforceDeviceGateway:true});t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'};
  const deviceA='nivora-device-a-1234567890',deviceB='nivora-device-b-0987654321';
  const credentials={phone:'09121113333',password:'customer-pass-123'};
  let r=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':deviceA},body:JSON.stringify({name:'مشتری دستگاه',...credentials})});
  assert.equal(r.status,201);const registration=await r.json();

  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(r.status,200);const webLogin=await r.json();
  r=await fetch(`${base}/api/customer/me`,{headers:{authorization:`Bearer ${webLogin.token}`}});
  assert.equal(r.status,200);assert.equal((await r.json()).id,registration.account.id);

  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':deviceB},body:JSON.stringify(credentials)});
  assert.equal(r.status,403);assert.equal((await r.json()).error,'DEVICE_ALREADY_BOUND');

  r=await fetch(`${base}/api/admin/accounts?role=customer`,{headers:admin});assert.equal(r.status,200);
  const customer=(await r.json()).find(account=>account.id===registration.account.id);assert.ok(customer);assert.equal(customer.device_bound,1);assert.ok(customer.device_bound_at);
  for(const privateField of ['password_hash','password_salt','device_binding_hash'])assert.equal(Object.hasOwn(customer,privateField),false);

  r=await fetch(`${base}/api/admin/accounts/${registration.account.id}/device-reset`,{method:'POST',headers:admin,body:'{}'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{id:registration.account.id,deviceBound:false,sessionsRevoked:true});
  r=await fetch(`${base}/api/customer/me`,{headers:{authorization:`Bearer ${webLogin.token}`}});assert.equal(r.status,401);

  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':deviceB},body:JSON.stringify(credentials)});
  assert.equal(r.status,200);const replacementLogin=await r.json();assert.ok(replacementLogin.token);
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

test('admin defines and manages an Iran transit tunnel without exposing host automation', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'};
  const createNode=async name=>{const response=await fetch(`${base}/api/admin/panel-nodes`,{method:'POST',headers:admin,body:JSON.stringify({name,provider:'test',subscriptionBaseUrl:'https://sub.test/sub'})});assert.equal(response.status,201);return (await response.json()).id};
  const entryNodeId=await createNode('Iran entry'),exitNodeId=await createNode('Finland exit');
  let response=await fetch(`${base}/api/admin/transit-tunnels`,{method:'POST',headers:admin,body:JSON.stringify({name:'Iran to Finland',entryNodeId,exitNodeId,transport:'amneziawg',publicHost:'127.0.0.1',publicPort:server.address().port,mtu:1280})});
  assert.equal(response.status,201);const tunnel=await response.json();
  response=await fetch(`${base}/api/admin/transit-tunnels`,{headers:admin});assert.equal(response.status,200);const rows=await response.json();assert.equal(rows.length,1);assert.equal(rows[0].entry_node_name,'Iran entry');assert.equal(rows[0].active,false);
  response=await fetch(`${base}/api/admin/transit-tunnels/${tunnel.id}/test`,{method:'POST',headers:admin,body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).status,'online');
  response=await fetch(`${base}/api/admin/transit-tunnels/${tunnel.id}`,{method:'PATCH',headers:admin,body:JSON.stringify({active:true,note:'carrier canary'})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/admin/transit-tunnels/${tunnel.id}`,{method:'DELETE',headers:admin});assert.equal(response.status,200);
});

test('connectivity probes are small, uncached and deterministic', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  let response=await fetch(`${base}/api/connectivity/204`);assert.equal(response.status,204);assert.equal(response.headers.get('cache-control'),'no-store');
  response=await fetch(`${base}/api/connectivity/payload?bytes=65536`);assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),65536);assert.equal((await response.arrayBuffer()).byteLength,65536);
  response=await fetch(`${base}/api/connectivity/payload?bytes=9999999`);assert.equal(Number(response.headers.get('content-length')),262144);
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
  const purchaseReceipt=await uploadReceipt(base);t.after(purchaseReceipt.cleanup);
  r=await fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'مشتری تمدید',phone:'09120000002',planId:plan.id,receiptReference:'first',receiptImageUrl:purchaseReceipt.url,amountTransferredIrr:120000})});
  const purchase=await r.json();
  r=await fetch(`${base}/api/admin/orders/${purchase.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,200);
  const originalSub=await r.json();assert.equal(originalSub.status,'active');
  r=await fetch(`${base}/api/orders/${purchase.id}/renew?token=wrong`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receiptReference:'renew'})});assert.equal(r.status,404);
  const renewalReceipt=await uploadReceipt(base);t.after(renewalReceipt.cleanup);
  r=await fetch(`${base}/api/orders/${purchase.id}/renew?token=${purchase.trackingToken}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receiptReference:'renew',receiptImageUrl:renewalReceipt.url,amountTransferredIrr:120000})});assert.equal(r.status,201);
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
  const receipt=await uploadReceipt(base,registration.token);t.after(receipt.cleanup);
  r=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:250000,receiptReference:'bank-7788',receiptImageUrl:receipt.url})});assert.equal(r.status,201);const topup=await r.json();
  r=await fetch(`${base}/api/admin/wallet-topups?status=under_review`,{headers:admin});assert.equal(r.status,200);assert.equal((await r.json()).length,1);
  r=await fetch(`${base}/api/admin/wallet-topups/${topup.id}/approve`,{method:'POST',headers:admin,body:JSON.stringify({note:'تأیید بانکی'})});assert.equal(r.status,200);assert.equal((await r.json()).balanceToman,250000);
  r=await fetch(`${base}/api/admin/wallet-topups/${topup.id}/approve`,{method:'POST',headers:admin,body:'{}'});assert.equal(r.status,409);
  r=await fetch(`${base}/api/customer/me`,{headers:auth});const me=await r.json();assert.equal(me.balanceToman,250000);assert.equal(me.topups[0].status,'approved');assert.equal(me.transactions.filter(x=>x.reference===`wallet-topup:${topup.id}`).length,1);
  const referenceFreeReceipt=await uploadReceipt(base,registration.token);t.after(referenceFreeReceipt.cleanup);
  r=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:30000,receiptImageUrl:referenceFreeReceipt.url})});assert.equal(r.status,201);assert.equal((await r.json()).status,'under_review');
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
  const ipHeaders={'content-type':'application/json','x-forwarded-for':'203.0.113.10'};
  const invalidCustomer=JSON.stringify({phone:'09120000000',password:'invalid-pass'}),invalidReseller=JSON.stringify({phone:'09120000001',password:'invalid-pass'});
  for(let i=0;i<60;i++){r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:ipHeaders,body:invalidCustomer});assert.equal(r.status,401);}
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:ipHeaders,body:invalidReseller});assert.equal(r.status,401);assert.equal(r.headers.get('x-ratelimit-remaining'),'59');
  r=await fetch(`${base}/api/customer/login`,{method:'POST',headers:ipHeaders,body:invalidCustomer});assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>0);assert.ok(r.headers.get('x-request-id'));
  for(let i=1;i<60;i++){r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:ipHeaders,body:invalidReseller});assert.equal(r.status,401);}
  r=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:ipHeaders,body:invalidReseller});assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>0);
});
