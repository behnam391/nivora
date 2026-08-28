import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

const admin={'authorization':'Bearer httpsms-admin','content-type':'application/json'};
const owner='+989121112233',userId='httpsms-user-1',sender='NIVORA-BANK';
const signingKey='test-signing-key-with-at-least-thirty-two-bytes-123456';
const receiptPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XlRFAAAAAElFTkSuQmCC','base64');

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(audience,subject=userId,key=signingKey){
  const now=Math.floor(Date.now()/1000),head=encode({alg:'HS256',typ:'JWT'}),body=encode({iss:'api.httpsms.com',aud:audience,sub:subject,iat:now,nbf:now,exp:now+600});
  return `${head}.${body}.${createHmac('sha256',key).update(`${head}.${body}`).digest('base64url')}`;
}

function cloudEvent({eventId,messageId,content,contact=sender,eventUserId=userId,sim='SIM1',timestamp=new Date().toISOString()}={}){
  return {specversion:'1.0',id:eventId,source:'https://api.httpsms.com',type:'message.phone.received',time:timestamp,data:{message_id:messageId,user_id:eventUserId,owner,encrypted:false,contact,timestamp,content,sim,attachments:[]}};
}

async function start(){
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'httpsms-admin'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(`${base}/api/admin/httpsms-settings`,{method:'PATCH',headers:admin,body:JSON.stringify({enabled:true,signingKey,expectedOwner:owner,expectedSim:'SIM1',expectedSubject:userId,allowedSenders:[sender],autoReviewEnabled:true,amountToleranceRial:0,lookbackHours:2,defaultSmsUnit:'rial'})});
  assert.equal(response.status,200);
  response=await fetch(`${base}/api/admin/httpsms-settings`,{headers:admin});
  const settings=await response.json();
  return {db,server,base,webhookUrl:settings.webhookUrl};
}

async function register(base,phone='09123334455'){
  const response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'مشتری httpSMS',phone,password:'httpsms-pass-1'})});
  assert.equal(response.status,201);
  return await response.json();
}

const topup=async(base,token,{amountToman=25000,receiptReference='manual-proof'}={})=>{
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  let response=await fetch(`${base}/api/receipts`,{method:'POST',headers,body:JSON.stringify({mimeType:'image/png',data:receiptPng.toString('base64')})});
  assert.equal(response.status,201);const receipt=await response.json(),filename=new URL(receipt.url,base).pathname.split('/').at(-1);
  response=await fetch(`${base}/api/customer/wallet/topups`,{method:'POST',headers,body:JSON.stringify({amountToman,receiptReference,receiptImageUrl:receipt.url})});
  const result={status:response.status,body:await response.json()};await unlink(resolve('receipts',filename)).catch(()=>{});return result;
};

const sendEvent=(base,webhookUrl,event,{token=jwt(webhookUrl),eventType='message.phone.received'}={})=>fetch(`${base}/api/webhooks/httpsms`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-event-type':eventType,'content-type':'application/json'},body:JSON.stringify(event)});

async function waitFor(read,predicate,timeout=1500){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,15));}
  return read();
}

test('httpSMS retries and races credit a matching wallet top-up exactly once',async t=>{
  const {db,server,base,webhookUrl}=await start();t.after(()=>server.close());
  const customer=await register(base),created=await topup(base,customer.token,{receiptReference:'45127890'});
  assert.equal(created.status,201);
  const event=cloudEvent({eventId:'evt-once-1',messageId:'msg-once-1',content:'واریز مبلغ 250,000 ریال شماره پیگیری 45127890'});
  const responses=await Promise.all(Array.from({length:5},()=>sendEvent(base,webhookUrl,event)));
  assert.ok(responses.every(response=>response.status===200));
  const approved=await waitFor(()=>db.prepare('SELECT * FROM wallet_topups WHERE id=?').get(created.body.id),row=>row?.status==='approved');
  assert.equal(approved.status,'approved');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM wallet_transactions WHERE reference=?").get(`wallet-topup:${created.body.id}`).count,1);
  assert.equal(db.prepare('SELECT balance_toman FROM wallet_accounts WHERE account_id=?').get(customer.account.id).balance_toman,25000);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM bank_transactions WHERE source='httpsms'").get().count,1);
  const sameMessageNewEvent=cloudEvent({eventId:'evt-once-2',messageId:'msg-once-1',content:'واریز مبلغ 250,000 ریال شماره پیگیری 45127890'});
  const duplicate=await sendEvent(base,webhookUrl,sameMessageNewEvent);
  assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM bank_transactions WHERE source='httpsms'").get().count,1);
});

test('a bank event received before its top-up is matched later, while amount-only stays manual',async t=>{
  const {db,server,base,webhookUrl}=await start();t.after(()=>server.close());
  const customer=await register(base,'09123334456');
  let response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-before-1',messageId:'msg-before-1',content:'واریز 320,000 ریال کد پیگیری 88221100'}));
  assert.equal(response.status,200);
  const created=await topup(base,customer.token,{amountToman:32000,receiptReference:'88221100'});
  const approved=await waitFor(()=>db.prepare('SELECT * FROM wallet_topups WHERE id=?').get(created.body.id),row=>row?.status==='approved');
  assert.equal(approved.status,'approved');

  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-amount-1',messageId:'msg-amount-1',content:'واریز 410,000 ریال کد پیگیری 665544'}));
  assert.equal(response.status,200);
  const manual=await topup(base,customer.token,{amountToman:41000,receiptReference:undefined});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(db.prepare('SELECT status FROM wallet_topups WHERE id=?').get(manual.body.id).status,'under_review');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM wallet_transactions WHERE reference=?").get(`wallet-topup:${manual.body.id}`).count,0);
});

test('an identified destination card must match an active payment card',async t=>{
  const {db,server,base,webhookUrl}=await start();t.after(()=>server.close());
  let response=await fetch(`${base}/api/admin/cards`,{method:'POST',headers:admin,body:JSON.stringify({cardNumber:'6219861915944697',cardHolder:'Nivora',bankName:'Test',sortOrder:0,active:true})});
  assert.equal(response.status,201);
  const customer=await register(base,'09123334457'),created=await topup(base,customer.token,{amountToman:25000,receiptReference:'73445500'});
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-card-1',messageId:'msg-card-1',content:'واریز به کارت ****9999 مبلغ 250,000 ریال شماره پیگیری 73445500'}));
  assert.equal(response.status,200);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(db.prepare('SELECT status FROM wallet_topups WHERE id=?').get(created.body.id).status,'under_review');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM wallet_transactions WHERE reference=?").get(`wallet-topup:${created.body.id}`).count,0);
});

test('httpSMS enforces JWT/event identity and safely ignores untrusted or unitless SMS',async t=>{
  const {db,server,base,webhookUrl}=await start();t.after(()=>server.close());
  let response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-bad-sub',messageId:'msg-bad-sub',eventUserId:'someone-else',content:'واریز 250,000 ریال پیگیری 123456'}));
  assert.equal(response.status,401);
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-sender',messageId:'msg-sender',contact:'UNTRUSTED',content:'واریز 250,000 ریال پیگیری 123456'}));
  assert.equal(response.status,200);assert.equal((await response.json()).ignored,true);
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-unitless',messageId:'msg-unitless',content:'واریز مبلغ 250000 پیگیری 123456'}));
  assert.equal(response.status,200);assert.equal((await response.json()).usable,false);
  assert.equal(db.prepare("SELECT status FROM bank_transactions WHERE provider_event_id='evt-unitless'").get().status,'ignored');
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-other',messageId:'msg-other',content:'واریز 1 ریال پیگیری 1234'}),{eventType:'message.phone.sent'});
  assert.equal(response.status,200);assert.equal((await response.json()).ignored,true);
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-key',messageId:'msg-key',content:'واریز 1 ریال پیگیری 1234'}),{token:jwt(webhookUrl,userId,'wrong-key-with-at-least-thirty-two-bytes-123456')});
  assert.equal(response.status,401);
  response=await sendEvent(base,webhookUrl,cloudEvent({eventId:'evt-aud',messageId:'msg-aud',content:'واریز 1 ریال پیگیری 1234'}),{token:jwt('https://wrong.example/webhook')});
  assert.equal(response.status,401);
});

test('admin httpSMS settings never disclose the signing key or raw bank SMS',async t=>{
  const {db,server,base}=await start();t.after(()=>server.close());
  let response=await fetch(`${base}/api/admin/httpsms-settings`,{headers:admin}),settings=await response.json();
  assert.equal(settings.signingKeyConfigured,true);assert.equal('signingKey' in settings,false);assert.equal('generatedSigningKey' in settings,false);
  response=await fetch(`${base}/api/admin/httpsms-settings`,{method:'PATCH',headers:admin,body:JSON.stringify({rotateSigningKey:true})});
  const rotated=await response.json();assert.equal(response.status,200);assert.ok(rotated.generatedSigningKey.length>=32);
  response=await fetch(`${base}/api/admin/httpsms-settings`,{headers:admin});settings=await response.json();
  assert.equal('generatedSigningKey' in settings,false);assert.equal('signingKey' in settings,false);
  response=await fetch(`${base}/api/admin/bank-transactions`,{headers:admin});
  const transactions=await response.json();assert.ok(transactions.every(row=>!('raw_message' in row)&&!('tracking_code' in row)));
  response=await fetch(`${base}/api/admin/httpsms-settings`,{method:'PATCH',headers:admin,body:JSON.stringify({enabled:false,autoReviewEnabled:true})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/admin/httpsms-settings`,{headers:admin});settings=await response.json();assert.equal(settings.enabled,false);assert.equal(settings.autoReviewEnabled,false);
  assert.ok(db.prepare("SELECT details FROM audit_log WHERE entity_type='httpsms_settings'").all().every(row=>!String(row.details).includes(signingKey)&&!String(row.details).includes(rotated.generatedSigningKey)));
});
