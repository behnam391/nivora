import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XlRFAAAAAElFTkSuQmCC','base64');

async function start(){
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'receipt-admin'}));
  await new Promise(resolvePromise=>server.listen(0,'127.0.0.1',resolvePromise));
  return {db,server,base:`http://127.0.0.1:${server.address().port}`};
}

async function register(base){
  const response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری رسید',phone:'09120002233',password:'receipt-pass-1'})});
  assert.equal(response.status,201);
  return (await response.json()).token;
}

async function registerCustomer(base,phone){
  const response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری رسید',phone,password:'receipt-pass-1'})});
  assert.equal(response.status,201);
  return response.json();
}

async function upload(base,{token}={}){
  const headers={'content-type':'application/json'};if(token)headers.authorization=`Bearer ${token}`;
  const response=await fetch(`${base}/api/receipts`,{method:'POST',headers,body:JSON.stringify({mimeType:'image/png',data:png.toString('base64')})});
  assert.equal(response.status,201);
  return response.json();
}

async function plan(base){
  const response=await fetch(`${base}/api/admin/plans`,{method:'POST',headers:{authorization:'Bearer receipt-admin','content-type':'application/json'},body:JSON.stringify({name:'پلن رسید',priceIrr:120000,trafficGb:20,durationDays:30,deviceLimit:1})});
  assert.equal(response.status,201);
  return response.json();
}

test('public store keeps secure guest receipt upload while owner access is preserved',async t=>{
  const {db,server,base}=await start();t.after(()=>server.close());
  const payload=JSON.stringify({mimeType:'image/png',data:png.toString('base64')});
  let response=await fetch(`${base}/store`);assert.equal(response.status,200);
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json'},body:payload});
  assert.equal(response.status,201);
  const guest=await response.json(),guestUrl=new URL(guest.url,base),guestName=guestUrl.pathname.split('/').at(-1);
  t.after(()=>unlink(resolve('receipts',guestName)).catch(()=>{}));
  assert.equal(db.prepare('SELECT account_id FROM receipt_uploads WHERE filename=?').get(guestName).account_id,null);
  response=await fetch(guestUrl);assert.equal(response.status,200);
  response=await fetch(`${base}${guestUrl.pathname}`);assert.equal(response.status,403);

  const token=await register(base),headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers,body:payload});
  assert.equal(response.status,201);
  const receipt=await response.json(),url=new URL(receipt.url,base),filename=url.pathname.split('/').at(-1);
  t.after(()=>unlink(resolve('receipts',filename)).catch(()=>{}));
  assert.match(receipt.url,/^\/receipts\/[a-f0-9-]+\.png\?access=/);

  response=await fetch(url);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  response=await fetch(`${base}${url.pathname}`);
  assert.equal(response.status,403);
  response=await fetch(`${base}${url.pathname}`,{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);

  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mimeType:'image/jpeg',data:png.toString('base64')})});
  assert.equal(response.status,201);
  const mismatched=await response.json(),mismatchedName=new URL(mismatched.url,base).pathname.split('/').at(-1);t.after(()=>unlink(resolve('receipts',mismatchedName)).catch(()=>{}));assert.match(mismatched.url,/\.png\?access=/);
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mimeType:'image/png',data:''})});
  assert.equal(response.status,400);
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{authorization:'Bearer invalid','content-type':'application/json'},body:payload});
  assert.equal(response.status,401);
});

test('receipt upload rejects payloads over four MiB',async t=>{
  const {server,base}=await start();t.after(()=>server.close());
  const oversized=Buffer.alloc(4*1024*1024+1).toString('base64');
  const response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mimeType:'image/png',data:oversized})});
  assert.equal(response.status,413);
  assert.equal((await response.json()).error,'RECEIPT_TOO_LARGE');
});

test('unregistered files are never public and each receipt capability is linked exactly once',async t=>{
  const {db,server,base}=await start();t.after(()=>server.close());
  assert.equal(String(db.prepare('PRAGMA foreign_key_list(receipt_uploads)').all().find(row=>row.from==='account_id').on_delete).toUpperCase(),'SET NULL');
  await mkdir(resolve('receipts'),{recursive:true});
  const unknown=`${randomUUID()}.png`;await writeFile(resolve('receipts',unknown),png);t.after(()=>unlink(resolve('receipts',unknown)).catch(()=>{}));
  let response=await fetch(`${base}/receipts/${unknown}`);assert.equal(response.status,404);
  response=await fetch(`${base}/receipts/${unknown}`,{headers:{authorization:'Bearer receipt-admin'}});assert.equal(response.status,404);

  const selectedPlan=await plan(base),guest=await upload(base),guestName=new URL(guest.url,base).pathname.split('/').at(-1);t.after(()=>unlink(resolve('receipts',guestName)).catch(()=>{}));
  const orderRequest=(customerName,phone,receiptReference)=>fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName,phone,planId:selectedPlan.id,receiptReference,receiptImageUrl:guest.url,amountTransferredIrr:120000})});
  const raced=await Promise.all([orderRequest('خریدار مهمان','09120003001','guest-proof'),orderRequest('خریدار دوم','09120003002','second-proof')]);
  assert.deepEqual(raced.map(item=>item.status).sort(),[201,409]);
  const winner=raced.find(item=>item.status===201),loser=raced.find(item=>item.status===409),order=await winner.json();assert.equal((await loser.json()).error,'RECEIPT_ALREADY_USED');
  let link=db.prepare('SELECT linked_entity_type,linked_entity_id FROM receipt_uploads WHERE filename=?').get(guestName);assert.equal(link.linked_entity_type,'order');assert.equal(link.linked_entity_id,order.id);

  const first=await registerCustomer(base,'09120003003'),second=await registerCustomer(base,'09120003004'),owned=await upload(base,{token:first.token}),ownedName=new URL(owned.url,base).pathname.split('/').at(-1);t.after(()=>unlink(resolve('receipts',ownedName)).catch(()=>{}));
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:{authorization:`Bearer ${second.token}`,'content-type':'application/json'},body:JSON.stringify({amountToman:25000,receiptReference:'wrong-owner',receiptImageUrl:owned.url})});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'RECEIPT_NOT_AVAILABLE');
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:{authorization:`Bearer ${first.token}`,'content-type':'application/json'},body:JSON.stringify({amountToman:25000,receiptReference:'right-owner',receiptImageUrl:owned.url})});
  assert.equal(response.status,201);const topup=await response.json();
  link=db.prepare('SELECT linked_entity_type,linked_entity_id FROM receipt_uploads WHERE filename=?').get(ownedName);assert.equal(link.linked_entity_type,'wallet_topup');assert.equal(link.linked_entity_id,topup.id);
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:{authorization:`Bearer ${first.token}`,'content-type':'application/json'},body:JSON.stringify({amountToman:26000,receiptReference:'reuse',receiptImageUrl:owned.url})});
  assert.equal(response.status,409);assert.equal((await response.json()).error,'RECEIPT_ALREADY_USED');
});

test('payment endpoints reject malformed, oversized and untrusted receipt fields',async t=>{
  const {server,base}=await start();t.after(()=>server.close());const selectedPlan=await plan(base);
  const submitOrder=body=>fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'مشتری امن',phone:'09120003100',planId:selectedPlan.id,receiptReference:'proof',...body})});
  let response=await submitOrder({customerName:{value:'bad'}});assert.equal(response.status,400);
  response=await submitOrder({receiptReference:'x'.repeat(101)});assert.equal(response.status,400);
  response=await submitOrder({amountTransferredIrr:'120000'});assert.equal(response.status,400);
  response=await submitOrder({amountTransferredIrr:1_000_000_001});assert.equal(response.status,400);
  response=await submitOrder({receiptImageUrl:{url:'/receipts/fake.png'}});assert.equal(response.status,400);
  response=await submitOrder({padding:'x'.repeat(25*1024)});assert.equal(response.status,413);assert.equal((await response.json()).error,'PAYMENT_BODY_TOO_LARGE');

  const customer=await registerCustomer(base,'09120003101'),auth={authorization:`Bearer ${customer.token}`,'content-type':'application/json'};
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:25000,receiptReference:{bad:true}})});assert.equal(response.status,400);
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:1_000_000_001,receiptReference:'proof'})});assert.equal(response.status,400);
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:25000,receiptReference:'proof',receiptImageUrl:`/receipts/${randomUUID()}.png?access=${'a'.repeat(43)}`})});assert.equal(response.status,403);
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:auth,body:JSON.stringify({amountToman:25000,receiptReference:'proof',padding:'x'.repeat(25*1024)})});assert.equal(response.status,413);
});

test('pending payment caps are scoped to account or phone rather than shared CGNAT IP',async t=>{
  const {server,base}=await start();t.after(()=>server.close());const selectedPlan=await plan(base);
  const order=phone=>fetch(`${base}/api/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerName:'خریدار محدود',phone,planId:selectedPlan.id})});
  for(let index=0;index<5;index++)assert.equal((await order('09120003200',index)).status,201);
  let response=await order('09120003200',5);assert.equal(response.status,429);assert.equal((await response.json()).error,'TOO_MANY_PENDING_ORDERS');
  assert.equal((await order('09120003201',0)).status,201);

  const first=await registerCustomer(base,'09120003202'),second=await registerCustomer(base,'09120003203');
  const topup=async(token,index)=>{const receipt=await upload(base,{token}),name=new URL(receipt.url,base).pathname.split('/').at(-1);t.after(()=>unlink(resolve('receipts',name)).catch(()=>{}));return fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({amountToman:25000+index,receiptReference:`proof-${index}`,receiptImageUrl:receipt.url})});};
  for(let index=0;index<5;index++)assert.equal((await topup(first.token,index)).status,201);
  response=await topup(first.token,5);assert.equal(response.status,429);assert.equal((await response.json()).error,'TOO_MANY_PENDING_TOPUPS');
  assert.equal((await topup(second.token,0)).status,201);
});

test('retention cleanup deletes only old unlinked uploads',async t=>{
  const {db,server,base}=await start();t.after(()=>server.close());await mkdir(resolve('receipts'),{recursive:true});
  const orphan=`${randomUUID()}.png`,linked=`${randomUUID()}.png`,finalized=`${randomUUID()}.png`,pending=`${randomUUID()}.png`,createdAt='2000-01-01T00:00:00.000Z',hash=createHash('sha256').update('legacy-token').digest('hex');
  for(const filename of [orphan,linked,finalized,pending])await writeFile(resolve('receipts',filename),png);
  t.after(()=>Promise.all([orphan,linked,finalized,pending].map(filename=>unlink(resolve('receipts',filename)).catch(()=>{}))));
  db.prepare("INSERT INTO plans(id,name,price_irr,traffic_gb,duration_days,device_limit,created_at,updated_at) VALUES('retention-plan','Retention',1000,1,1,1,?,?)").run(createdAt,createdAt);
  db.prepare("INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,reviewed_at) VALUES('final-order','x','09120003300','retention-plan','approved',?,?),('pending-order','x','09120003301','retention-plan','under_review',?,NULL)").run(createdAt,createdAt,createdAt);
  db.prepare('INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at) VALUES(?,NULL,?,\'image/png\',?,?)').run(orphan,hash,png.length,createdAt);
  db.prepare("INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at,linked_entity_type,linked_entity_id,linked_at) VALUES(?,NULL,?,'image/png',?,?,'order','legacy-order',?)").run(linked,hash,png.length,createdAt,createdAt);
  db.prepare("INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at,linked_entity_type,linked_entity_id,linked_at) VALUES(?,NULL,?,'image/png',?,?,'order','final-order',?)").run(finalized,hash,png.length,createdAt,createdAt);
  db.prepare("INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at,linked_entity_type,linked_entity_id,linked_at) VALUES(?,NULL,?,'image/png',?,?,'order','pending-order',?)").run(pending,hash,png.length,createdAt,createdAt);
  const uploaded=await upload(base),newName=new URL(uploaded.url,base).pathname.split('/').at(-1);t.after(()=>unlink(resolve('receipts',newName)).catch(()=>{}));
  assert.equal(db.prepare('SELECT 1 FROM receipt_uploads WHERE filename=?').get(orphan),undefined);
  await assert.rejects(access(resolve('receipts',orphan)));
  assert.ok(db.prepare('SELECT 1 FROM receipt_uploads WHERE filename=?').get(linked));
  await access(resolve('receipts',linked));
  assert.equal(db.prepare('SELECT 1 FROM receipt_uploads WHERE filename=?').get(finalized),undefined);await assert.rejects(access(resolve('receipts',finalized)));
  assert.ok(db.prepare('SELECT 1 FROM receipt_uploads WHERE filename=?').get(pending));await access(resolve('receipts',pending));
});

test('guest/account upload rates and global storage caps fail closed',async t=>{
  const {db,server,base}=await start();t.after(()=>server.close());const payload=JSON.stringify({mimeType:'image/png',data:png.toString('base64')}),createdAt=new Date().toISOString(),hash=createHash('sha256').update('cap-token').digest('hex');
  const guestFiles=[];
  for(let index=0;index<8;index++){const receipt=await upload(base),name=new URL(receipt.url,base).pathname.split('/').at(-1);guestFiles.push(name);t.after(()=>unlink(resolve('receipts',name)).catch(()=>{}));}
  let response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json'},body:payload});assert.equal(response.status,429);assert.equal((await response.json()).error,'RECEIPT_RATE_LIMITED');
  db.prepare(`DELETE FROM receipt_uploads WHERE filename IN (${guestFiles.map(()=>'?').join(',')})`).run(...guestFiles);

  const customer=await registerCustomer(base,'09120003400'),accountFiles=[];
  for(let index=0;index<12;index++){const receipt=await upload(base,{token:customer.token}),name=new URL(receipt.url,base).pathname.split('/').at(-1);accountFiles.push(name);t.after(()=>unlink(resolve('receipts',name)).catch(()=>{}));}
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{authorization:`Bearer ${customer.token}`,'content-type':'application/json'},body:payload});assert.equal(response.status,429);
  db.prepare(`DELETE FROM receipt_uploads WHERE filename IN (${accountFiles.map(()=>'?').join(',')})`).run(...accountFiles);

  const insert=db.prepare("INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at,linked_entity_type,linked_entity_id,linked_at) VALUES(?,NULL,?,'image/png',?,?, 'order',?,?)");
  db.exec('BEGIN IMMEDIATE');for(let index=0;index<256;index++)insert.run(`byte-cap-${index}.png`,hash,4*1024*1024,createdAt,`missing-byte-${index}`,createdAt);db.exec('COMMIT');
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'198.51.100.40'},body:payload});assert.equal(response.status,503);assert.equal((await response.json()).error,'RECEIPT_STORAGE_BUSY');
  db.prepare("DELETE FROM receipt_uploads WHERE filename LIKE 'byte-cap-%'").run();
  db.exec('BEGIN IMMEDIATE');for(let index=0;index<5000;index++)insert.run(`count-cap-${index}.png`,hash,1,createdAt,`missing-count-${index}`,createdAt);db.exec('COMMIT');
  response=await fetch(`${base}/api/receipts`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'198.51.100.41'},body:payload});assert.equal(response.status,503);assert.equal((await response.json()).error,'RECEIPT_STORAGE_BUSY');
});
