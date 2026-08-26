import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

const DEVICE_A='nivora-recovery-device-a-1234567890';
const DEVICE_B='nivora-recovery-device-b-1234567890';

async function start() {
  const db=openDatabase(':memory:');
  const server=createServer(createApp(db,{adminToken:'test-token'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {db,server,base:`http://127.0.0.1:${server.address().port}`};
}

test('a blocked phone can request approval and admin approval replaces the oldest device', async t => {
  const {db,server,base}=await start();t.after(()=>server.close());
  const credentials={phone:'09123330001',password:'device-recovery-pass'};
  const customerHeaders={'content-type':'application/json','x-nivora-device':DEVICE_A};
  let response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:customerHeaders,body:JSON.stringify({name:'مشتری بازیابی',...credentials})});
  assert.equal(response.status,201);const registration=await response.json();

  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,403);assert.equal((await response.json()).error,'DEVICE_ALREADY_BOUND');
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify({...credentials,password:'wrong-password'})});
  assert.equal(response.status,401);
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,202);const request=await response.json();assert.equal(request.status,'pending');assert.ok(request.id);
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,202);assert.equal((await response.json()).id,request.id);

  response=await fetch(`${base}/api/admin/notifications`,{headers:{authorization:'Bearer test-token'}});const notifications=await response.json();assert.equal(notifications.counts.pendingDevices,1);
  response=await fetch(`${base}/api/admin/device-recovery-requests/${request.id}/approve`,{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);const approval=await response.json();assert.equal(approval.status,'approved');
  response=await fetch(`${base}/api/admin/device-recovery-requests/${request.id}/approve`,{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.equal((await response.json()).resolvedNow,false);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM notifications WHERE account_id=? AND title='دستگاه جدید تأیید شد'").get(registration.account.id).count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM account_sessions WHERE account_id=?').get(registration.account.id).count,0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(registration.account.id).count,1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='revoked'").get(registration.account.id).count,1);
  response=await fetch(`${base}/api/device-recovery/request/${request.id}`);assert.equal(response.status,200);const publicStatus=await response.json();assert.equal(publicStatus.status,'approved');
  for(const payload of [request,approval,publicStatus]){
    const exposed=JSON.stringify(payload);
    assert.equal(exposed.includes('requested_device_hash'),false);
    assert.equal(exposed.includes('password_hash'),false);
    assert.equal(exposed.includes('password_salt'),false);
    assert.equal(exposed.includes(credentials.password),false);
  }

  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,200);
  response=await fetch(`${base}/api/customer/login`,{method:'POST',headers:customerHeaders,body:JSON.stringify(credentials)});
  assert.equal(response.status,403);
  response=await fetch(`${base}/api/admin/accounts/${registration.account.id}/devices`,{headers:{authorization:'Bearer test-token'}});const devices=await response.json();assert.equal(devices.devices.length,1);assert.equal(devices.recoveryRequests.length,0);
});

test('stale device recovery expires and no longer blocks a fresh request', async t => {
  const {db,server,base}=await start();t.after(()=>server.close());
  const credentials={phone:'09123330006',password:'device-recovery-pass'};
  const headers={'content-type':'application/json','x-nivora-device':DEVICE_A};
  await fetch(`${base}/api/customer/register`,{method:'POST',headers,body:JSON.stringify({name:'مشتری انقضا',...credentials})});
  let response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,202);const first=await response.json();
  db.prepare('UPDATE device_recovery_requests SET requested_at=? WHERE id=?').run(new Date(Date.now()-2*86400000).toISOString(),first.id);
  response=await fetch(`${base}/api/device-recovery/request/${first.id}`);assert.equal(response.status,200);assert.equal((await response.json()).status,'expired');
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,202);const fresh=await response.json();assert.notEqual(fresh.id,first.id);assert.equal(fresh.status,'pending');
});

test('only the reseller managing the customer can approve its device request', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const admin={authorization:'Bearer test-token','content-type':'application/json'};
  let response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار مالک',phone:'09123330002',password:'reseller-password',role:'reseller'})});
  const owner=await response.json();
  response=await fetch(`${base}/api/admin/accounts`,{method:'POST',headers:admin,body:JSON.stringify({name:'همکار دیگر',phone:'09123330003',password:'reseller-password',role:'reseller'})});
  const outsider=await response.json();
  const login=async phone=>(await (await fetch(`${base}/api/reseller/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,password:'reseller-password'})})).json()).token;
  const ownerToken=await login(owner.phone),outsiderToken=await login(outsider.phone);
  response=await fetch(`${base}/api/reseller/customers`,{method:'POST',headers:{authorization:`Bearer ${ownerToken}`,'content-type':'application/json'},body:JSON.stringify({name:'مشتری همکار',phone:'09123330004',password:'customer-password'})});
  const customer=await response.json();
  const credentials={phone:customer.phone,password:'customer-password'};
  await fetch(`${base}/api/customer/login`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_A},body:JSON.stringify(credentials)});
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});const request=await response.json();assert.equal(response.status,202);

  response=await fetch(`${base}/api/reseller/device-recovery-requests/${request.id}/approve`,{method:'POST',headers:{authorization:`Bearer ${outsiderToken}`,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,403);
  response=await fetch(`${base}/api/reseller/customers/${customer.id}/devices`,{headers:{authorization:`Bearer ${ownerToken}`}});const inventory=await response.json();assert.equal(inventory.recoveryRequests.length,1);
  response=await fetch(`${base}/api/reseller/device-recovery-requests/${request.id}/approve`,{method:'POST',headers:{authorization:`Bearer ${ownerToken}`,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.equal((await response.json()).status,'approved');
});

test('a pending recovery cannot activate a device after the customer is suspended', async t => {
  const {db,server,base}=await start();t.after(()=>server.close());
  const credentials={phone:'09123330005',password:'device-recovery-pass'};
  let response=await fetch(`${base}/api/customer/register`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_A},body:JSON.stringify({name:'مشتری تعلیق‌شده',...credentials})});
  assert.equal(response.status,201);const registration=await response.json();
  response=await fetch(`${base}/api/device-recovery/request`,{method:'POST',headers:{'content-type':'application/json','x-nivora-device':DEVICE_B},body:JSON.stringify(credentials)});
  assert.equal(response.status,202);const request=await response.json();
  db.prepare("UPDATE accounts SET status='suspended' WHERE id=?").run(registration.account.id);

  response=await fetch(`${base}/api/admin/device-recovery-requests/${request.id}/approve`,{method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,404);
  assert.equal(db.prepare('SELECT status FROM device_recovery_requests WHERE id=?').get(request.id).status,'pending');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(registration.account.id).count,1);
});
