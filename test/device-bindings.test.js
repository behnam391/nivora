import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { claimCustomerDevice, deviceSummary, effectiveDeviceLimit, listAccountDevices, resetAccountDevices, revokeAccountDevice, setDeviceLimitOverride } from '../src/device-bindings.js';

const request = id => ({headers:{'x-nivora-device':id}});
const hash = value => createHash('sha256').update(value).digest('hex');
const DEVICE_A='nivora-device-a-1234567890';
const DEVICE_B='nivora-device-b-1234567890';
const DEVICE_C='nivora-device-c-1234567890';

function addCustomer(db, id = 'account-devices') {
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at)
    VALUES(?,?,?,'customer','active',0,?,?)`).run(id,'09120000111','Device customer',now,now);
  return db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
}

function addActivePlan(db, accountId, deviceLimit) {
  const now=new Date().toISOString(),planId=`plan-${deviceLimit}`,orderId=`order-${deviceLimit}`,subscriptionId=`subscription-${deviceLimit}`;
  db.prepare(`INSERT INTO plans(id,name,price_irr,traffic_gb,duration_days,device_limit,created_at,updated_at)
    VALUES(?,? ,1000,10,30,?,?,?)`).run(planId,'Device plan',deviceLimit,now,now);
  db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,account_id,order_kind)
    VALUES(?,'Customer','09120000111',?,'approved',?,?,'purchase')`).run(orderId,planId,now,accountId);
  db.prepare(`INSERT INTO subscriptions(id,order_id,status,created_at,activated_at)
    VALUES(?,?,'active',?,?)`).run(subscriptionId,orderId,now,now);
}

test('device registry inherits the active plan, supports an override and enforces it atomically', () => {
  const db=openDatabase(':memory:');
  const account=addCustomer(db);addActivePlan(db,account.id,2);
  assert.equal(effectiveDeviceLimit(db,account.id),2);
  const first=claimCustomerDevice(db,account,request(DEVICE_A),{required:true});
  const second=claimCustomerDevice(db,account,request(DEVICE_B),{required:true});
  assert.equal(claimCustomerDevice(db,account,request(DEVICE_A),{required:true}).id,first.id);
  assert.throws(()=>claimCustomerDevice(db,account,request(DEVICE_C),{required:true}),error=>error.code==='DEVICE_LIMIT_REACHED'&&error.details.deviceLimit===2);
  assert.deepEqual(deviceSummary(db,account.id),{activeDeviceCount:2,deviceCount:2,device_count:2,deviceLimit:2,device_limit:2,deviceLimitOverride:null});

  assert.equal(setDeviceLimitOverride(db,account.id,3).deviceLimit,3);
  const third=claimCustomerDevice(db,account,request(DEVICE_C),{required:true});
  assert.ok(third.id);
  assert.throws(()=>setDeviceLimitOverride(db,account.id,2),error=>error.code==='DEVICE_LIMIT_BELOW_ACTIVE_COUNT');
  revokeAccountDevice(db,account.id,second.id,'test');
  assert.equal(setDeviceLimitOverride(db,account.id,2).deviceLimit,2);
  assert.equal(listAccountDevices(db,account.id).length,2);
  assert.equal(Object.hasOwn(listAccountDevices(db,account.id)[0],'device_hash'),false);
  assert.throws(()=>claimCustomerDevice(db,account,request(DEVICE_B),{required:true}),error=>error.code==='DEVICE_LIMIT_REACHED');
  resetAccountDevices(db,account.id,'test');
  assert.equal(deviceSummary(db,account.id).activeDeviceCount,0);
  assert.equal(db.prepare('SELECT device_binding_hash FROM accounts WHERE id=?').get(account.id).device_binding_hash,null);
  db.close();
});

test('opening an existing database imports its singleton device binding without exposing its hash', () => {
  const folder=mkdtempSync(join(tmpdir(),'nivora-device-migration-')),file=join(folder,'old.db');
  try{
    const legacy=new DatabaseSync(file),now=new Date().toISOString();
    legacy.exec(`CREATE TABLE accounts (
      id TEXT PRIMARY KEY,phone TEXT UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,
      default_discount_percent INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      password_hash TEXT,password_salt TEXT,device_binding_hash TEXT,device_bound_at TEXT,managed_by_reseller_id TEXT
    )`);
    legacy.prepare(`INSERT INTO accounts(id,phone,name,role,status,created_at,updated_at,device_binding_hash,device_bound_at)
      VALUES('legacy','09120000112','Legacy','customer','active',?,?,?,?)`).run(now,now,hash(DEVICE_A),now);
    legacy.close();
    const db=openDatabase(file),devices=listAccountDevices(db,'legacy');
    assert.equal(devices.length,1);assert.equal(devices[0].label,'دستگاه قدیمی');
    assert.equal(db.prepare('SELECT device_limit_override FROM accounts WHERE id=?').get('legacy').device_limit_override,null);
    assert.equal(effectiveDeviceLimit(db,'legacy'),1);
    db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});

async function start() {
  const db=openDatabase(':memory:'),server=createServer(createApp(db,{adminToken:'test-token'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {db,server,base:`http://127.0.0.1:${server.address().port}`};
}

test('admin can set the account ceiling, list active devices and revoke one device', async t => {
  const {db,server,base}=await start();t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'},credentials={phone:'09120000113',password:'device-pass-123'};
  let response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_A},body:JSON.stringify({name:'Admin devices',...credentials})});
  const registered=await response.json(),authA={authorization:`Bearer ${registered.token}`};assert.equal(response.status,201);
  response=await fetch(`${base}/api/admin/accounts/${registered.account.id}/device-limit`,{method:'PATCH',headers:admin,body:JSON.stringify({deviceLimit:2})});
  assert.equal(response.status,200);assert.equal((await response.json()).deviceLimit,2);
  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});assert.equal(response.status,200);
  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_C},body:JSON.stringify(credentials)});assert.equal(response.status,403);assert.equal((await response.json()).error,'DEVICE_LIMIT_REACHED');
  response=await fetch(`${base}/api/admin/accounts/${registered.account.id}/devices`,{headers:admin});const inventory=await response.json();assert.equal(inventory.devices.length,2);assert.ok(inventory.devices.every(device=>device.status==='active'));
  const firstId=db.prepare('SELECT id FROM account_devices WHERE account_id=? AND device_hash=?').get(registered.account.id,hash(DEVICE_A)).id;
  response=await fetch(`${base}/api/admin/accounts/${registered.account.id}/devices/${firstId}`,{method:'DELETE',headers:admin});assert.equal(response.status,200);
  response=await fetch(`${base}/api/customer/me`,{headers:authA});
  assert.equal(response.status,401);
  response=await fetch(`${base}/api/admin/accounts/${registered.account.id}/devices`,{headers:admin});assert.equal((await response.json()).devices.length,1);
});

test('a reseller can manage devices only for an account it created', async t => {
  const {server,base}=await start();t.after(()=>server.close());const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'Reseller owner',phone:'09120000114',password:'reseller-pass-1',role:'reseller'})});const reseller=await response.json();
  response=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09120000114',password:'reseller-pass-1'})});const login=await response.json(),resellerAuth={authorization:`Bearer ${login.token}`,'content-type':'application/json'};
  response=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:resellerAuth,body:JSON.stringify({name:'Managed customer',phone:'09120000115'})});const customer=await response.json();assert.ok(customer.temporaryPassword);
  const customerCredentials={phone:'09120000115',password:customer.temporaryPassword};
  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_A},body:JSON.stringify(customerCredentials)});assert.equal(response.status,200);
  response=await fetch(`${base}/api/reseller/customers/${customer.id}/device-limit`,{method:'PATCH',headers:resellerAuth,body:JSON.stringify({limit:2})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(customerCredentials)});assert.equal(response.status,200);
  response=await fetch(`${base}/api/reseller/customers/${customer.id}/devices`,{headers:resellerAuth});assert.equal((await response.json()).devices.length,2);

  response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'Other reseller',phone:'09120000116',password:'reseller-pass-2',role:'reseller'})});
  response=await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'09120000116',password:'reseller-pass-2'})});const other=await response.json(),otherAuth={authorization:`Bearer ${other.token}`};
  response=await fetch(`${base}/api/reseller/customers/${customer.id}/devices`,{headers:otherAuth});assert.equal(response.status,403);assert.equal((await response.json()).error,'CUSTOMER_DEVICE_NOT_MANAGED');
  assert.ok(reseller.id);
});
