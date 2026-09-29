import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

test('customer refund is prorated, capped after five days and credited once',async t=>{
  const removed=[],stats={};const provisioner=async order=>({panelClientId:`client-${order.id}`,subscriptionUrl:`https://sub.test/${order.id}`});provisioner.remove=async({panelClientId})=>removed.push(panelClientId);
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'admin',provisioner,panelStatsReader:async()=>stats}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`,admin={authorization:'Bearer admin','content-type':'application/json'},device='refund-device-12345678901234567890';
  let response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':device},body:JSON.stringify({name:'مشتری بازگشت',phone:'09120001122',password:'refund-password'})}),session=await response.json(),auth={authorization:`Bearer ${session.token}`,'content-type':'application/json','x-nivora-device':device};
  await fetch(`${base}/api/admin/accounts/${session.account.id}/wallet`,{method:'POST',headers:admin,body:JSON.stringify({amountToman:300000})});
  response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'پلن بازگشت',priceIrr:200000,trafficGb:30,durationDays:30,deviceLimit:1})});const plan=await response.json(),location=randomUUID(),now=new Date().toISOString();db.prepare("INSERT INTO service_locations(id,name,country_code,city,flag_emoji,capacity,active,created_at,updated_at) VALUES(?,?,?,?,?,100,1,?,?)").run(location,'آلمان','DE','Nuremberg','🇩🇪',now,now);db.prepare('INSERT INTO plan_locations(plan_id,location_id) VALUES(?,?)').run(plan.id,location);
  response=await fetch(`${base}/api/customer/wallet/purchase`,{method:'POST',headers:auth,body:JSON.stringify({planId:plan.id})});assert.equal(response.status,201);const purchase=await response.json(),orderId=purchase.orderIds[0],sub=db.prepare('SELECT * FROM subscriptions WHERE order_id=?').get(orderId);stats[sub.panel_client_id]={totalBytes:30*1024**3,upBytes:1024**3,downBytes:2*1024**3};db.prepare('UPDATE subscriptions SET activated_at=? WHERE id=?').run(new Date(Date.now()-6.2*86400000).toISOString(),sub.id);
  response=await fetch(`${base}/api/customer/subscriptions/${orderId}/refund-preview`,{headers:auth});assert.equal(response.status,200);const preview=await response.json();assert.equal(preview.usedDays,7);assert.equal(preview.refundToman,100000);
  response=await fetch(`${base}/api/customer/subscriptions/${orderId}/cancel`,{method:'POST',headers:auth,body:'{}'});assert.equal(response.status,200);assert.equal((await response.json()).balanceToman,200000);assert.equal(removed.length,1);
  response=await fetch(`${base}/api/customer/subscriptions/${orderId}/cancel`,{method:'POST',headers:auth,body:'{}'});assert.equal(response.status,409);assert.equal((await response.json()).error,'SUBSCRIPTION_ALREADY_REFUNDED');
});

test('automatic plan pricing rounds to a clear 5000 toman step',async t=>{
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'admin'}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`,admin={authorization:'Bearer admin','content-type':'application/json'};
  await fetch(`${base}/api/admin/pricing`,{method:'PATCH',headers:admin,body:JSON.stringify({usdToman:100000,eurToman:120000})});
  let response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:admin,body:JSON.stringify({name:'پلن ارزی',priceIrr:1,trafficGb:10,durationDays:30,deviceLimit:1,autoPrice:true,costCurrency:'USD',costAmount:1.25,markupPercent:20})});assert.equal(response.status,201);const plan=await response.json();
  response=await fetch(`${base}/api/admin/pricing`,{method:'PATCH',headers:admin,body:JSON.stringify({usdToman:110000,eurToman:120000})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/admin/plans`,{headers:admin});const updated=(await response.json()).find(item=>item.id===plan.id);assert.equal(updated.priceIrr,165000);
});
