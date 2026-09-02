import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

const DEVICE_A='nivora-ios-device-a-1234567890';
const DEVICE_B='nivora-ios-device-b-1234567890';
const DIRECT_LINK='vless://12345678-1234-1234-1234-123456789abc@203.0.113.10:443?security=reality&type=tcp&flow=xtls-rprx-vision&sni=www.cloudflare.com&pbk=test-public-key#Nivora-iOS';

const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve));

async function register(base, {name,phone,password,device}) {
  const response=await fetch(`${base}/api/customer/register`,{
    method:'POST',
    headers:{'content-type':'application/json','x-nivora-device':device},
    body:JSON.stringify({name,phone,password})
  });
  assert.equal(response.status,201);
  return response.json();
}

async function fixture(t) {
  const upstream=createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});
    res.end(DIRECT_LINK);
  });
  await listen(upstream);
  t.after(()=>upstream.close());

  const db=openDatabase(':memory:');
  t.after(()=>db.close());
  const server=createServer(createApp(db,{adminToken:'test-token',enforceDeviceGateway:true}));
  await listen(server);
  t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;

  const owner=await register(base,{name:'iOS owner',phone:'09120000901',password:'owner-password',device:DEVICE_A});
  const stranger=await register(base,{name:'Other customer',phone:'09120000902',password:'other-password',device:DEVICE_B});
  const now=new Date().toISOString();
  const planId='ios-import-plan',orderId='ios-import-order',subscriptionId='ios-import-subscription';
  const accessToken='abcdef0123456789abcdef0123456789';
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}/source`;
  db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,active,created_at,updated_at)
    VALUES(?,?,'',1000,20,30,1,1,?,?)`).run(planId,'Nivora iPhone',now,now);
  db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,account_id,order_kind)
    VALUES(?,?,?,?, 'approved',?,?,'purchase')`).run(orderId,'iOS owner','09120000901',planId,now,owner.account.id);
  db.prepare(`INSERT INTO subscriptions(id,order_id,status,control_status,subscription_url,upstream_subscription_url,access_token,created_at,activated_at)
    VALUES(?,?,'active','active',?,?,?,?,?)`).run(subscriptionId,orderId,upstreamUrl,upstreamUrl,accessToken,now,now);

  return {
    db,base,orderId,subscriptionId,accessToken,
    ownerHeaders:{authorization:`Bearer ${owner.token}`,'x-nivora-device':DEVICE_A,'content-type':'application/json'},
    strangerHeaders:{authorization:`Bearer ${stranger.token}`,'x-nivora-device':DEVICE_B,'content-type':'application/json'}
  };
}

async function issue(base, orderId, headers) {
  return fetch(`${base}/api/customer/orders/${orderId}/ios-import`,{method:'POST',headers,body:'{}'});
}

test('customer account exposes the current Hiddify iOS flow without a copyable permanent URL', async () => {
  const [html,script]=await Promise.all([
    readFile(new URL('../public/account.html',import.meta.url),'utf8'),
    readFile(new URL('../public/account.js',import.meta.url),'utf8')
  ]);
  assert.match(html,/id="ios-dialog"/);
  assert.match(html,/https:\/\/app\.hiddify\.com\/ios/);
  assert.match(script,/hiddify:\/\/import\/\?url=/);
  assert.match(script,/\/api\/customer\/orders\/\$\{encodeURIComponent\(activeIosOrder\)\}\/ios-import/);
  assert.doesNotMatch(html,/id="ios-copy"|کپی لینک آیفون/);
});

test('iOS import issues a short-lived hashed capability and Hiddify can fetch it without a customer session', async t => {
  const {db,base,orderId,subscriptionId,accessToken,ownerHeaders}=await fixture(t);

  // The permanent subscription URL remains protected by the device gateway.
  let response=await fetch(`${base}/sub/${accessToken}`);
  assert.equal(response.status,401);

  response=await issue(base,orderId,{'content-type':'application/json','x-nivora-device':DEVICE_A});
  assert.equal(response.status,401);
  response=await issue(base,orderId,{authorization:ownerHeaders.authorization,'content-type':'application/json'});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'DEVICE_REQUIRED');

  response=await issue(base,orderId,ownerHeaders);
  assert.equal(response.status,201);
  assert.match(response.headers.get('cache-control')||'',/no-store/i);
  const issued=await response.json();
  assert.equal(issued.expiresInSeconds,120);
  assert.equal(typeof issued.profileName,'string');
  assert.ok(issued.profileName.trim().length>0);
  const importUrl=new URL(issued.subscriptionUrl,base);
  assert.equal(importUrl.origin,base);
  assert.match(importUrl.pathname,/^\/ios\/import\/[A-Za-z0-9_-]{32,}$/);
  const rawToken=importUrl.pathname.split('/').at(-1);
  const tokenHash=createHash('sha256').update(rawToken).digest('hex');

  const columns=db.prepare('PRAGMA table_info(subscription_import_tokens)').all().map(column=>column.name);
  assert.ok(columns.includes('token_hash'));
  assert.ok(!columns.includes('token')&&!columns.includes('raw_token'));
  const stored=db.prepare('SELECT * FROM subscription_import_tokens WHERE subscription_id=?').get(subscriptionId);
  assert.equal(stored.token_hash,tokenHash);
  assert.equal(stored.account_id,db.prepare('SELECT account_id FROM orders WHERE id=?').get(orderId).account_id);
  assert.ok(stored.device_id);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM subscription_import_tokens WHERE token_hash=?').get(rawToken).count,0);

  response=await fetch(importUrl);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type')||'',/^text\/plain/i);
  assert.match(response.headers.get('cache-control')||'',/no-store/i);
  assert.equal(await response.text(),DIRECT_LINK);
  assert.equal(db.prepare('SELECT fetch_count FROM subscription_import_tokens WHERE token_hash=?').get(tokenHash).fetch_count,1);
});

test('iOS import does not reveal another customer order and rejects an inactive subscription', async t => {
  const {db,base,orderId,subscriptionId,ownerHeaders,strangerHeaders}=await fixture(t);

  let response=await issue(base,orderId,strangerHeaders);
  assert.equal(response.status,404);
  assert.equal((await response.json()).error,'SUBSCRIPTION_NOT_FOUND');

  db.prepare("UPDATE subscriptions SET status='expired' WHERE id=?").run(subscriptionId);
  response=await issue(base,orderId,ownerHeaders);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'SUBSCRIPTION_NOT_ACTIVE');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM subscription_import_tokens').get().count,0);
});

test('iOS import URL expires and cannot be fetched more than its small retry allowance', async t => {
  const {db,base,orderId,ownerHeaders}=await fixture(t);

  let response=await issue(base,orderId,ownerHeaders);
  assert.equal(response.status,201);
  let issued=await response.json();
  const firstUrl=new URL(issued.subscriptionUrl,base);
  const firstHash=createHash('sha256').update(firstUrl.pathname.split('/').at(-1)).digest('hex');
  const token=db.prepare('SELECT max_fetches FROM subscription_import_tokens WHERE token_hash=?').get(firstHash);
  assert.equal(token.max_fetches,3);
  for(let attempt=0;attempt<token.max_fetches;attempt+=1){
    response=await fetch(firstUrl);
    assert.equal(response.status,200);
    await response.arrayBuffer();
  }
  response=await fetch(firstUrl);
  assert.equal(response.status,410);
  assert.equal((await response.json()).error,'IMPORT_LINK_EXPIRED');

  response=await issue(base,orderId,ownerHeaders);
  assert.equal(response.status,201);
  issued=await response.json();
  const expiredUrl=new URL(issued.subscriptionUrl,base);
  const expiredHash=createHash('sha256').update(expiredUrl.pathname.split('/').at(-1)).digest('hex');
  db.prepare("UPDATE subscription_import_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE token_hash=?").run(expiredHash);
  response=await fetch(expiredUrl);
  assert.equal(response.status,410);
  assert.equal((await response.json()).error,'IMPORT_LINK_EXPIRED');
  assert.match(response.headers.get('cache-control')||'',/no-store/i);
});
