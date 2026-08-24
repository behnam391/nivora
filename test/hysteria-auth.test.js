import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/auth.js';
import { hashHysteriaNodeSecret } from '../src/hysteria-auth.js';

const TICKET_SECRET = 'ticket-signing-secret-with-more-than-thirty-two-bytes';
const NODE_SECRET = 'node-callback-secret-with-more-than-thirty-two-bytes';
const DEVICE_ID = 'nivora-test-device-id-0000000001';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const db = openDatabase(':memory:');
  const now = new Date().toISOString();
  const accountId = 'account-hy2';
  const planId = 'plan-hy2';
  const locationId = 'location-hy2';
  const orderId = 'order-hy2';
  const subscriptionId = 'subscription-hy2';
  const routeId = 'fi-hy2';
  const panelClientId = 'nivo-hy2-test';
  db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,active,created_at,updated_at) VALUES(?,?,'',1000,20,30,1,1,?,?)`).run(planId,'Hysteria test',now,now);
  db.prepare(`INSERT INTO service_locations(id,name,country_code,city,provider,panel_type,capacity,active,created_at,updated_at) VALUES(?,?,'FI','','','3x-ui',100,1,?,?)`).run(locationId,'Finland',now,now);
  db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,device_binding_hash,device_bound_at) VALUES(?,?,?,'customer','active',0,?,?,?,?)`).run(accountId,'09120000001','Customer',now,now,hash(DEVICE_ID),now);
  db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,created_at,account_id,location_id,order_kind) VALUES(?,?,?,?, 'approved',?,?,?,'purchase')`).run(orderId,'Customer','09120000001',planId,now,accountId,locationId);
  db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,created_at,activated_at) VALUES(?,?,'active',?,?,?)`).run(subscriptionId,orderId,panelClientId,now,now);
  db.prepare(`INSERT INTO hysteria_nodes(id,location_id,public_host,public_port,sni,node_secret_hash,active,created_at,updated_at) VALUES(?,?,?,443,?,?,1,?,?)`).run(routeId,locationId,'hy2.example.test','hy2.example.test',hashHysteriaNodeSecret(NODE_SECRET),now,now);
  const stats = {
    [panelClientId]: {
      upBytes: 10,
      downBytes: 20,
      totalBytes: 20 * 1024 ** 3,
      expiryTime: Date.now() + 30 * 86_400_000,
      enabled: true,
      syncedAt: Date.now()
    }
  };
  const session = createSession(db,accountId);
  const server = createServer(createApp(db,{
    adminToken:'test-admin-token',
    hysteriaTicketSecret:TICKET_SECRET,
    hysteriaTicketTtlSeconds:45,
    hysteriaStatsMaxAgeSeconds:180,
    panelStatsReader:async()=>stats
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const customerHeaders = {
    authorization:`Bearer ${session.token}`,
    'x-nivora-device':DEVICE_ID,
    'content-type':'application/json'
  };
  return {db,server,base,stats,accountId,orderId,subscriptionId,routeId,panelClientId,customerHeaders};
}

async function issue(ctx, headers = ctx.customerHeaders, routeId = ctx.routeId) {
  return fetch(`${ctx.base}/api/customer/subscriptions/${ctx.orderId}/connect-ticket`,{
    method:'POST',headers,body:JSON.stringify({routeId})
  });
}

async function authenticate(ctx, token, secret = NODE_SECRET, routeId = ctx.routeId) {
  return fetch(`${ctx.base}/internal/v1/hysteria/auth/${routeId}`,{
    method:'POST',
    headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
    body:JSON.stringify({addr:'203.0.113.10:50000',auth:token,tx:1_000_000})
  });
}

test('bound customer receives a short-lived Hysteria2 ticket with the exact public contract', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const response=await issue(ctx);
  assert.equal(response.status,201);
  const body=await response.json();
  assert.deepEqual(Object.keys(body).sort(),['expiresAt','routeId','uri']);
  assert.equal(body.routeId,ctx.routeId);
  assert.ok(Date.parse(body.expiresAt)>Date.now());
  const uri=new URL(body.uri);
  assert.equal(uri.protocol,'hysteria2:');
  assert.equal(uri.hostname,'hy2.example.test');
  assert.equal(uri.port,'443');
  assert.equal(uri.searchParams.get('sni'),'hy2.example.test');
  assert.ok(decodeURIComponent(uri.username).includes('.'));
  const stored=ctx.db.prepare('SELECT * FROM hysteria_tickets').get();
  assert.equal(stored.account_id,ctx.accountId);
  assert.equal(stored.device_binding_hash,hash(DEVICE_ID));
  assert.equal(stored.consumed_at,null);
  assert.equal(ctx.db.prepare('SELECT hysteria_duration_days FROM subscriptions WHERE id=?').get(ctx.subscriptionId).hysteria_duration_days,30);
});

test('node callback accepts bounded reconnects with one stable traffic identity', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const ticket=await (await issue(ctx)).json();
  const token=decodeURIComponent(new URL(ticket.uri).username);
  let response=await authenticate(ctx,token);
  assert.equal(response.status,200);
  const accepted=await response.json();
  assert.equal(accepted.ok,true);
  assert.match(accepted.id,/^hy2-/);
  response=await authenticate(ctx,token);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),accepted);
  assert.ok(ctx.db.prepare('SELECT consumed_at FROM hysteria_tickets').get().consumed_at);
});

test('node authentication rejects wrong node credentials and tampered HMAC tickets', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const ticket=await (await issue(ctx)).json();
  const token=decodeURIComponent(new URL(ticket.uri).username);
  let response=await authenticate(ctx,token,'wrong-node-secret-that-is-still-long-enough');
  assert.equal(response.status,401);
  assert.equal((await response.json()).error,'INVALID_NODE_CREDENTIALS');
  const [payload,signature]=token.split('.');
  const tampered=`${payload.slice(0,-1)}${payload.endsWith('A')?'B':'A'}.${signature}`;
  response=await authenticate(ctx,tampered);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:false,id:''});
});

test('auth callback rechecks suspension and current device binding after ticket issuance', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  let ticket=await (await issue(ctx)).json();
  let token=decodeURIComponent(new URL(ticket.uri).username);
  ctx.db.prepare("UPDATE subscriptions SET control_status='suspended' WHERE id=?").run(ctx.subscriptionId);
  let response=await authenticate(ctx,token);
  assert.deepEqual(await response.json(),{ok:false,id:''});

  ctx.db.prepare("UPDATE subscriptions SET control_status='active' WHERE id=?").run(ctx.subscriptionId);
  ticket=await (await issue(ctx)).json();
  token=decodeURIComponent(new URL(ticket.uri).username);
  ctx.db.prepare('UPDATE accounts SET device_binding_hash=? WHERE id=?').run(hash('another-device-id-000000000000'),ctx.accountId);
  response=await authenticate(ctx,token);
  assert.deepEqual(await response.json(),{ok:false,id:''});
});

test('ticket issuance requires the bound device, honours fresh denials and survives stale optional stats', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const wrongHeaders={...ctx.customerHeaders,'x-nivora-device':'wrong-device-id-00000000000000'};
  let response=await issue(ctx,wrongHeaders);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'DEVICE_ALREADY_BOUND');

  ctx.stats[ctx.panelClientId].expiryTime=Date.now()-1;
  response=await issue(ctx);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error,'SUBSCRIPTION_EXPIRED');

  ctx.stats[ctx.panelClientId].expiryTime=Date.now()+86_400_000;
  ctx.stats[ctx.panelClientId].syncedAt=Date.now()-181_000;
  response=await issue(ctx);
  assert.equal(response.status,201);
});

test('automatic route selection follows the subscription location', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const response=await issue(ctx,ctx.customerHeaders,'auto');
  assert.equal(response.status,201);
  assert.equal((await response.json()).routeId,ctx.routeId);
});

test('cumulative node traffic reports are idempotent and survive counter reset', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const ticket=await (await issue(ctx)).json();
  const token=decodeURIComponent(new URL(ticket.uri).username);
  const accepted=await (await authenticate(ctx,token)).json();
  const report=clients=>fetch(`${ctx.base}/internal/v1/hysteria/usage/${ctx.routeId}`,{
    method:'POST',headers:{authorization:`Bearer ${NODE_SECRET}`,'content-type':'application/json'},body:JSON.stringify({clients})
  });
  let response=await report({[accepted.id]:{tx:100,rx:900}});
  const firstReport=await response.json();
  assert.equal(response.status,200,JSON.stringify(firstReport));
  assert.equal(firstReport.addedBytes,1000);
  response=await report({[accepted.id]:{tx:150,rx:1050}});
  assert.equal((await response.json()).addedBytes,200);
  response=await report({[accepted.id]:{tx:10,rx:20}});
  assert.equal((await response.json()).addedBytes,30);
  assert.equal(ctx.db.prepare('SELECT hysteria_used_bytes FROM subscriptions WHERE id=?').get(ctx.subscriptionId).hysteria_used_bytes,1230);
});

test('a route can only issue tickets for subscriptions in its own location', async t => {
  const ctx=await fixture();t.after(()=>ctx.server.close());
  const now=new Date().toISOString();
  ctx.db.prepare(`INSERT INTO service_locations(id,name,country_code,city,provider,panel_type,capacity,active,created_at,updated_at) VALUES('other-location','Germany','DE','','','3x-ui',10,1,?,?)`).run(now,now);
  ctx.db.prepare(`INSERT INTO hysteria_nodes(id,location_id,public_host,public_port,sni,node_secret_hash,active,created_at,updated_at) VALUES('de-hy2','other-location','de.example.test',443,'de.example.test',?,1,?,?)`).run(hashHysteriaNodeSecret(NODE_SECRET),now,now);
  const response=await issue(ctx,ctx.customerHeaders,'de-hy2');
  assert.equal(response.status,404);
  assert.equal((await response.json()).error,'HYSTERIA2_ROUTE_NOT_FOUND');
});
