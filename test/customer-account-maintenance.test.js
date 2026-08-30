import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';

const DEVICE='nivora-account-maintenance-device-1234567890';

async function start() {
  const db=openDatabase(':memory:');
  const server=createServer(createApp(db,{adminToken:'test-token'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {db,server,base:`http://127.0.0.1:${server.address().port}`};
}

async function register(base, phone='09124440001') {
  const headers={'content-type':'application/json','x-nivora-device':DEVICE};
  const response=await fetch(`${base}/api/customer/register`,{
    method:'POST',headers,body:JSON.stringify({name:'مشتری تنظیمات',phone,password:'current-password'})
  });
  assert.equal(response.status,201);
  return {session:await response.json(),headers};
}

test('customer changes password while the current session survives and other sessions are revoked', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const {session:first,headers}=await register(base);
  let response=await fetch(`${base}/api/customer/login`,{method:'POST',headers,body:JSON.stringify({phone:'09124440001',password:'current-password'})});
  assert.equal(response.status,200);const second=await response.json();

  response=await fetch(`${base}/api/customer/change-password`,{
    method:'POST',headers:{...headers,authorization:`Bearer ${first.token}`},
    body:JSON.stringify({currentPassword:'wrong-password',newPassword:'updated-password'})
  });
  assert.equal(response.status,400);assert.equal((await response.json()).error,'INVALID_CURRENT_PASSWORD');

  response=await fetch(`${base}/api/customer/change-password`,{
    method:'POST',headers:{...headers,authorization:`Bearer ${first.token}`},
    body:JSON.stringify({currentPassword:'current-password',newPassword:'updated-password'})
  });
  assert.equal(response.status,200);assert.equal((await response.json()).otherSessionsRevoked,true);
  assert.equal((await fetch(`${base}/api/customer/me`,{headers:{...headers,authorization:`Bearer ${first.token}`}})).status,200);
  assert.equal((await fetch(`${base}/api/customer/me`,{headers:{...headers,authorization:`Bearer ${second.token}`}})).status,401);
  assert.equal((await fetch(`${base}/api/customer/login`,{method:'POST',headers,body:JSON.stringify({phone:'09124440001',password:'current-password'})})).status,401);
  assert.equal((await fetch(`${base}/api/customer/login`,{method:'POST',headers,body:JSON.stringify({phone:'09124440001',password:'updated-password'})})).status,200);
});

test('customer can change the account name and invalid names are rejected', async t => {
  const {server,base}=await start();t.after(()=>server.close());
  const {session,headers}=await register(base,'09124440003');
  const auth={...headers,authorization:`Bearer ${session.token}`};
  let response=await fetch(`${base}/api/customer/profile`,{method:'PATCH',headers:auth,body:JSON.stringify({name:'  بهنام   شفیعی  '})});
  assert.equal(response.status,200);assert.equal((await response.json()).name,'بهنام شفیعی');
  response=await fetch(`${base}/api/customer/me`,{headers:auth});
  assert.equal(response.status,200);assert.equal((await response.json()).name,'بهنام شفیعی');
  response=await fetch(`${base}/api/customer/profile`,{method:'PATCH',headers:auth,body:JSON.stringify({name:'<x>'})});
  assert.equal(response.status,400);assert.equal((await response.json()).error,'INVALID_NAME');
});

test('customer clears notifications and archives tickets without deleting support history', async t => {
  const {db,server,base}=await start();t.after(()=>server.close());
  const {session,headers}=await register(base,'09124440002');
  const auth={...headers,authorization:`Bearer ${session.token}`};
  const now=new Date().toISOString();
  db.prepare('INSERT INTO notifications(id,account_id,title,body,created_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(),session.account.id,'اعلان آزمایشی','متن اعلان',now);

  let response=await fetch(`${base}/api/customer/tickets`,{method:'POST',headers:auth,body:JSON.stringify({subject:'درخواست آزمایشی',body:'متن درخواست پشتیبانی'})});
  assert.equal(response.status,201);const ticket=await response.json();
  response=await fetch(`${base}/api/customer/notifications`,{method:'DELETE',headers:auth});
  assert.equal(response.status,200);assert.equal((await response.json()).cleared,1);
  response=await fetch(`${base}/api/customer/tickets`,{method:'DELETE',headers:auth});
  assert.equal(response.status,200);assert.equal((await response.json()).cleared,1);

  response=await fetch(`${base}/api/customer/me`,{headers:auth});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).notifications,[]);
  response=await fetch(`${base}/api/customer/tickets`,{headers:auth});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications').get().count,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM support_tickets').get().count,1);

  response=await fetch(`${base}/api/admin/tickets/${ticket.id}`,{
    method:'POST',headers:{authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify({body:'پاسخ تازه مدیریت'})
  });
  assert.equal(response.status,201);
  response=await fetch(`${base}/api/customer/tickets`,{headers:auth});
  assert.equal(response.status,200);const visible=await response.json();assert.equal(visible.length,1);assert.equal(visible[0].id,ticket.id);
});
