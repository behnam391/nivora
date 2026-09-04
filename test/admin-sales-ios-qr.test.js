import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import QRCode from 'qrcode';

test('wallet purchase retries and overlapping requests deliver and debit once',async t=>{
  let release,started;const wait=new Promise(r=>release=r),entered=new Promise(r=>started=r);let calls=0;
  const provisioner=async order=>{calls++;started();await wait;return {panelClientId:order.id,subscriptionUrl:'https://panel.test/sub/one'}};
  const {db,base,admin}=await start(t,{provisioner});
  const customer=await createAccount(base,admin,{name:'خریدار تست',phone:'09128889999'}),{plan}=await createPlanAndLocation(base,admin);
  await fetch(`${base}/api/admin/accounts/${customer.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:200000})});
  const login=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:customer.phone,password:'password-123'})});
  const token=(await login.json()).token,headers={authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'checkout-test-123456789'};
  const buy=()=>fetch(`${base}/api/customer/wallet/purchase`,{method:'POST',headers,body:JSON.stringify({planId:plan.id})});
  const first=buy();await entered;
  const pending=await buy();assert.equal(pending.status,409);assert.equal((await pending.json()).error,'PURCHASE_PENDING');
  release();const original=await first;assert.equal(original.status,201);const originalBody=await original.json();
  const retry=await buy();assert.equal(retry.status,201);assert.equal(retry.headers.get('idempotency-replayed'),'true');assert.deepEqual(await retry.json(),originalBody);
  assert.equal(calls,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE type='purchase'").get().n,1);
  const asset=await fetch(`${base}/purchase-safe.js`);assert.equal(asset.status,200);assert.match(await asset.text(),/Idempotency-Key/);
});

test('failed admin sale is not counted as an approved order',async t=>{
  const {db,base,admin}=await start(t,{provisioner:async()=>{throw new Error('PANEL_UNAVAILABLE')}});
  const customer=await createAccount(base,admin,{name:'خریدار تست',phone:'09128889998'}),{plan}=await createPlanAndLocation(base,admin);
  const response=await fetch(`${base}/api/admin/sales`,{method:'POST',headers:{...admin,'idempotency-key':'checkout-test-987654321'},body:JSON.stringify({customerId:customer.id,planId:plan.id})});
  assert.equal(response.status,502);const result=await response.json();
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(result.orderIds[0]).status,'rejected');
});

test('unknown panel outcome stays pending and is never executed twice',async t=>{
  let calls=0;
  const {db,base,admin}=await start(t,{provisioner:async()=>{calls++;throw Object.assign(new Error('RESPONSE_LOST'),{uncertain:true})}});
  const customer=await createAccount(base,admin,{name:'خریدار تست',phone:'09128889997'}),{plan}=await createPlanAndLocation(base,admin);
  const buy=()=>fetch(`${base}/api/admin/sales`,{method:'POST',headers:{...admin,'idempotency-key':'checkout-unknown-123456789'},body:JSON.stringify({customerId:customer.id,planId:plan.id})});
  const response=await buy();assert.equal(response.status,503);const body=await response.json();assert.equal(body.error,'PURCHASE_PENDING');assert.equal(body.refunded,false);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(body.orderIds[0]).status,'under_review');
  assert.equal((await buy()).status,409);assert.equal(calls,1);
});

async function start(t,{provisioner}={}){
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'test-token',provisioner}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());t.after(()=>db.close());
  return {db,base:`http://127.0.0.1:${server.address().port}`,admin:{authorization:'Bearer test-token','content-type':'application/json'}};
}

async function createAccount(base,admin,{name,phone,role='customer'}){
  const response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name,phone,role,password:'password-123'})});
  assert.equal(response.status,201);return response.json();
}

async function createPlanAndLocation(base,admin){
  let response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'پلن تست فروش مدیر',priceIrr:75000,trafficGb:30,durationDays:30,deviceLimit:1})});
  assert.equal(response.status,201);const plan=await response.json();
  response=await fetch(`${base}/api/admin/locations`,{method:'POST',headers:admin,body:JSON.stringify({name:'آلمان تست',countryCode:'DE',panelInboundId:7})});
  assert.equal(response.status,201);const location=await response.json();
  response=await fetch(`${base}/api/admin/locations/${location.id}/plans`,{method:'POST',headers:admin,body:JSON.stringify({planIds:[plan.id]})});assert.equal(response.status,200);
  return {plan,location};
}

test('admin customer list is searchable and paginated and direct sale provisions a real subscription',async t=>{
  const calls=[],provisioner=async order=>{calls.push(order);return {panelClientId:`admin-${order.id}`,subscriptionUrl:`https://panel.test/sub/${order.id}`}};provisioner.remove=async()=>{};
  const {db,base,admin}=await start(t,{provisioner});
  const customers=[];for(let index=0;index<13;index+=1)customers.push(await createAccount(base,admin,{name:`مشتری شماره ${index+1}`,phone:`09123330${String(index).padStart(3,'0')}`}));
  let response=await fetch(`${base}/api/admin/accounts?role=customer&page=1&pageSize=5`,{headers:admin});assert.equal(response.status,200);let page=await response.json();assert.equal(page.items.length,5);assert.equal(page.total,13);assert.equal(page.totalPages,3);
  response=await fetch(`${base}/api/admin/accounts?role=customer&page=1&pageSize=10&q=${encodeURIComponent('شماره 13')}`,{headers:admin});page=await response.json();assert.equal(page.total,1);assert.equal(page.items[0].id,customers[12].id);
  const {plan,location}=await createPlanAndLocation(base,admin);
  response=await fetch(`${base}/api/admin/sales`,{method:'POST',headers:admin,body:JSON.stringify({customerId:customers[0].id,planId:plan.id,salePriceToman:90000})});assert.equal(response.status,201);const sale=await response.json();assert.equal(sale.status,'active');assert.equal(sale.subscriptionCount,1);assert.equal(sale.subscriptions[0].locationId,location.id);assert.equal(calls.length,1);
  const order=db.prepare('SELECT account_id,status,amount_transferred_irr,reviewed_by FROM orders WHERE id=?').get(sale.orderId);assert.equal(order.account_id,customers[0].id);assert.equal(order.status,'approved');assert.equal(order.amount_transferred_irr,900000);assert.equal(order.reviewed_by,'admin');assert.equal(db.prepare('SELECT status FROM subscriptions WHERE order_id=?').get(sale.orderId).status,'active');
});

test('reseller can create a short-lived iPhone QR only for a subscription it sold',async t=>{
  const originalQr=QRCode.toDataURL;let qrPayload='';
  QRCode.toDataURL=(payload,options)=>{qrPayload=payload;return originalQr(payload,options)};
  t.after(()=>{QRCode.toDataURL=originalQr});
  const provisioner=async order=>({panelClientId:`partner-${order.id}`,subscriptionUrl:`https://panel.test/sub/${order.id}`});provisioner.remove=async()=>{};
  const {db,base,admin}=await start(t,{provisioner});const {plan}=await createPlanAndLocation(base,admin);
  const reseller=await createAccount(base,admin,{name:'همکار اول',phone:'09124440001',role:'reseller'}),other=await createAccount(base,admin,{name:'همکار دوم',phone:'09124440002',role:'reseller'});
  for(const item of [reseller,other]){const credit=await fetch(`${base}/api/admin/accounts/${item.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:200000,note:'اعتبار تست'})});assert.equal(credit.status,201);}
  const login=async phone=>{const response=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,password:'password-123'})});assert.equal(response.status,200);return {authorization:`Bearer ${(await response.json()).token}`,'content-type':'application/json'}};
  const resellerAuth=await login(reseller.phone),otherAuth=await login(other.phone);
  let response=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:resellerAuth,body:JSON.stringify({name:'مشتری آیفون',phone:'09125550001',password:'customer-password'})});assert.equal(response.status,201);const customer=await response.json();
  response=await fetch(`${base}/api/reseller/purchase`,{method:'POST',headers:resellerAuth,body:JSON.stringify({customerId:customer.id,planId:plan.id,salePriceToman:95000})});assert.equal(response.status,201);const sale=await response.json();
  response=await fetch(`${base}/api/reseller/orders/${sale.orderId}/ios-import`,{method:'POST',headers:otherAuth,body:'{}'});assert.equal(response.status,404);
  response=await fetch(`${base}/api/reseller/orders/${sale.orderId}/ios-import`,{method:'POST',headers:resellerAuth,body:'{}'});assert.equal(response.status,201);assert.match(response.headers.get('cache-control')||'',/no-store/i);const qr=await response.json();assert.match(qr.qrDataUrl,/^data:image\/png;base64,/);assert.equal(qr.expiresInSeconds,300);assert.equal(qr.maxFetches,3);assert.equal('subscriptionUrl' in qr,false);assert.equal(db.prepare('SELECT COUNT(*) count FROM reseller_subscription_import_tokens WHERE reseller_id=? AND account_id=?').get(reseller.id,customer.account_id).count,1);
  const deepLink=new URL(qrPayload);
  assert.equal(deepLink.protocol,'v2box:');assert.equal(deepLink.hostname,'install-sub');
  assert.equal(deepLink.searchParams.get('name'),qr.profileName);
  const importUrl=new URL(deepLink.searchParams.get('url'));
  assert.equal(importUrl.origin,base);assert.match(importUrl.pathname,/^\/ios\/partner-import\/[A-Za-z0-9_-]+$/);
});
