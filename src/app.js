import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { getWalletStatement, postWalletTransaction } from './wallet.js';
import { accountFromRequest, createSession, hashPassword, verifyPassword } from './auth.js';
import { selectLocationForPlan } from './capacity.js';
import { createRequestGuard } from './security.js';
import { enrichSubscription, readPanelStats } from './subscription-stats.js';
import { buildMultiEndpointSubscription, fetchCleanIpSource, fetchSubscriptionText, measureCloudflareEndpoint, measureTcpEndpoint, parseCleanIpList } from './multi-endpoint.js';
import { evaluateOrder, sweepPendingOrders, ingestBankMessage, loadAutoReviewConfig } from './auto-review.js';
import { extractReceiptFields } from './receipt-ocr.js';
import net from 'node:net';
import { createHash, randomInt, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { sendSms } from './sms.js';
import { createTelegramRecovery } from './telegram-bot.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readJson = async req => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 6_000_000) throw new Error('BODY_TOO_LARGE');
  }
  return raw ? JSON.parse(raw) : {};
};

const planFromRow = row => row && ({
  id: row.id, name: row.name, description: row.description,
  priceIrr: Math.round(row.price_irr / 10), trafficGb: row.traffic_gb,
  durationDays: row.duration_days, deviceLimit: row.device_limit,
  sortOrder: row.sort_order, active: Boolean(row.active),
  locations: row.locations ? row.locations.split('|').map(x => { const [id,name,countryCode,city,flagEmoji] = x.split('~'); return {id,name,countryCode,city,flagEmoji:flagEmoji||''}; }) : [],
  createdAt: row.created_at, updatedAt: row.updated_at
});

function validPlan(body) {
  const required = ['name', 'priceIrr', 'trafficGb', 'durationDays', 'deviceLimit'];
  return required.every(k => body[k] !== undefined) && body.name.trim() &&
    [body.priceIrr, body.trafficGb, body.durationDays, body.deviceLimit].every(Number.isInteger) &&
    body.priceIrr >= 0 && body.trafficGb > 0 && body.durationDays > 0 && body.deviceLimit > 0;
}

const resellerCustomerFromBody = body => ({
  name: String(body.name || body.customerName || '').trim(),
  phone: String(body.phone || '').trim(),
  note: String(body.note || '').trim().slice(0, 500)
});

function createOrRestoreResellerCustomer(db, resellerId, body, now = new Date().toISOString()) {
  const customer = resellerCustomerFromBody(body);
  if (customer.name.length < 2 || !/^09\d{9}$/.test(customer.phone)) throw new Error('INVALID_CUSTOMER');
  const existing = db.prepare('SELECT * FROM reseller_customers WHERE reseller_id=? AND phone=?').get(resellerId,customer.phone);
  if (existing) {
    db.prepare("UPDATE reseller_customers SET name=?,note=CASE WHEN ?<>'' THEN ? ELSE note END,status='active',updated_at=? WHERE id=?").run(customer.name,customer.note,customer.note,now,existing.id);
    return db.prepare('SELECT * FROM reseller_customers WHERE id=?').get(existing.id);
  }
  const id=randomUUID();
  db.prepare("INSERT INTO reseller_customers(id,reseller_id,name,phone,note,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)").run(id,resellerId,customer.name,customer.phone,customer.note,now,now);
  return db.prepare('SELECT * FROM reseller_customers WHERE id=?').get(id);
}

// A reseller may serve an existing Nivora customer as well as customers they created.
// Keep a private address-book row for that relationship; this never changes ownership
// of the customer account or grants control over subscriptions issued by another reseller.
function attachExistingCustomerToReseller(db, resellerId, account, now = new Date().toISOString()) {
  const current = db.prepare('SELECT * FROM reseller_customers WHERE reseller_id=? AND account_id=?').get(resellerId, account.id);
  if (current) return current;
  const byPhone = db.prepare('SELECT * FROM reseller_customers WHERE reseller_id=? AND phone=?').get(resellerId, account.phone);
  if (byPhone) {
    db.prepare('UPDATE reseller_customers SET account_id=?,name=?,status=?,updated_at=? WHERE id=?').run(account.id,account.name,'active',now,byPhone.id);
    return db.prepare('SELECT * FROM reseller_customers WHERE id=?').get(byPhone.id);
  }
  const id = randomUUID();
  db.prepare("INSERT INTO reseller_customers(id,reseller_id,name,phone,note,status,created_at,updated_at,account_id) VALUES(?,?,?,?,?,'active',?,?,?)")
    .run(id,resellerId,account.name,account.phone,'مشتری موجود Nivora',now,now,account.id);
  return db.prepare('SELECT * FROM reseller_customers WHERE id=?').get(id);
}

const subscriptionToken = () => randomUUID().replace(/-/g, '');

function publicOrigin(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:8787').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  return `${proto}://${host}`;
}

const publicSubscriptionUrl = (req, token, fallback = null) => token ? `${publicOrigin(req)}/sub/${token}` : fallback;
const exposeSubscription = (req, row) => row && ({
  ...row,
  subscription_url: publicSubscriptionUrl(req, row.subscription_access_token || row.access_token, row.subscription_url)
});

function endpointFromBody(body, current = {}) {
  return {
    label: String(body.label ?? current.label ?? '').trim().slice(0, 60),
    host: String(body.host ?? current.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
    port: Number(body.port ?? current.port ?? 443),
    mode: String(body.mode ?? current.mode ?? 'direct').trim().toLowerCase(),
    serverName: String(body.serverName ?? current.server_name ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''),
    sourceUrl: String(body.sourceUrl ?? current.source_url ?? '').trim().slice(0, 1000),
    priority: Number(body.priority ?? current.priority ?? 0),
    active: body.active ?? Boolean(current.active ?? true)
  };
}

const validHost = host => net.isIP(host) > 0 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
const validEndpoint = endpoint => endpoint.label.length >= 2 && endpoint.host.length <= 253 && validHost(endpoint.host) &&
  ['direct','cloudflare'].includes(endpoint.mode) && (endpoint.mode !== 'cloudflare' || (validHost(endpoint.serverName) && !net.isIP(endpoint.serverName))) &&
  Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535 &&
  Number.isInteger(endpoint.priority) && endpoint.priority >= 0 && endpoint.priority <= 10_000;

export function createApp(db, { adminToken = process.env.ADMIN_TOKEN || 'dev-only-change-me', adminUsername = process.env.ADMIN_USERNAME || '', adminPasswordSalt = process.env.ADMIN_PASSWORD_SALT || '', adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '', provisioner = null, neuralMeshManifest = null } = {}) {
  const adminSessionHours=Math.min(72,Math.max(1,Number(process.env.ADMIN_SESSION_HOURS)||12));
  const savedAdmin=Object.fromEntries(db.prepare("SELECT key,value FROM app_settings WHERE key IN ('admin_username','admin_password_salt','admin_password_hash','admin_session_version')").all().map(row=>[row.key,row.value]));
  let activeAdminUsername=savedAdmin.admin_username||adminUsername;
  let activeAdminPasswordSalt=savedAdmin.admin_password_salt||adminPasswordSalt;
  let activeAdminPasswordHash=savedAdmin.admin_password_hash||adminPasswordHash;
  let adminSessionVersion=savedAdmin.admin_session_version||'1';
  const sessionSignature=payload=>createHmac('sha256',adminToken).update(payload).digest('base64url');
  const issueAdminSession=()=>{const payload=Buffer.from(JSON.stringify({role:'admin',exp:Date.now()+adminSessionHours*3600000,credentialVersion:adminSessionVersion,nonce:randomBytes(16).toString('hex')})).toString('base64url');return `${payload}.${sessionSignature(payload)}`};
  const validAdminSession=token=>{try{const [payload,signature]=String(token||'').split('.');if(!payload||!signature)return false;const expected=Buffer.from(sessionSignature(payload)),actual=Buffer.from(signature);if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return false;const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));return data.role==='admin'&&data.credentialVersion===adminSessionVersion&&Number(data.exp)>Date.now()}catch{return false}};
  const isAdmin = req => {const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];return token===adminToken||validAdminSession(token)};
  const audit = (actor, action, type, id, details = null) => db.prepare(
    'INSERT INTO audit_log(actor,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?)'
  ).run(actor, action, type, id, details && JSON.stringify(details), new Date().toISOString());
  const notify = (accountId,title,body) => db.prepare('INSERT INTO notifications(id,account_id,title,body,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),accountId,title,body,new Date().toISOString());
  const normalizePhone = value => String(value || '').replace(/[\s\-()]/g, '').replace(/^\+98/, '0').replace(/^0098/, '0');
  const codeHash = code => createHash('sha256').update(String(code)).digest('hex');
  const settingGet=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
  const settingSet=(key,value)=>db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value),new Date().toISOString());
  const settingsKey=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||adminToken).digest();
  const encrypt=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',settingsKey,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`};
  const decrypt=value=>{try{const [a,b,c]=value.split('.'),iv=Buffer.from(a,'base64url'),dec=createDecipheriv('aes-256-gcm',settingsKey,iv);dec.setAuthTag(Buffer.from(b,'base64url'));return Buffer.concat([dec.update(Buffer.from(c,'base64url')),dec.final()]).toString('utf8')}catch{return ''}};
  const telegramConfig=()=>({enabled:settingGet('telegram_enabled')==='true',token:decrypt(settingGet('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,secret:decrypt(settingGet('telegram_secret')||'')||process.env.TELEGRAM_WEBHOOK_SECRET,username:settingGet('telegram_username')||'',adminIds:(settingGet('telegram_admin_ids')||'').split(',').map(x=>x.trim()).filter(Boolean)});
  const telegramRecovery=createTelegramRecovery(db,{getConfig:telegramConfig});
  const guard=createRequestGuard();
  const autoReviewConfig = loadAutoReviewConfig();
  const subscriptionRow = id => db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);

  // Shared approval → provisioning path used by both the admin review routes and the
  // auto-review agent. The order's status must already be set to 'approved'.
  async function finalizeApprovedOrder(order, { actor = 'admin' } = {}) {
    const now = new Date().toISOString();
    const subscriptionId = randomUUID();
    if (order.order_kind === 'renewal') {
      const parent = db.prepare(`SELECT s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM subscriptions s WHERE s.order_id=? AND s.status='active'`).get(order.parent_order_id);
      if (!parent || !provisioner?.renew) return { ok: false, code: 'RENEW_TARGET_UNAVAILABLE', note: 'Renewal target unavailable' };
      db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(subscriptionId, order.id, parent.panel_client_id, parent.subscription_url, parent.upstream_subscription_url || parent.subscription_url, now);
      audit(actor, 'approve', 'renewal_order', order.id);
      try {
        await provisioner.renew({ panelClientId: parent.panel_client_id, addDays: order.duration_days, addTrafficGb: order.traffic_gb });
        db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(), subscriptionId);
        const row = subscriptionRow(subscriptionId); row.subscription_access_token = parent.subscription_access_token;
        return { ok: true, subscription: row };
      } catch (e) {
        db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message || e), subscriptionId);
        return { ok: false, code: 'RENEW_FAILED' };
      }
    }
    const location = order.location_id ? db.prepare('SELECT * FROM service_locations WHERE id=? AND active=1').get(order.location_id) : selectLocationForPlan(db, order.plan_id);
    if (!location) return { ok: false, code: 'NO_CAPACITY', note: 'No server capacity' };
    db.prepare('UPDATE orders SET location_id=? WHERE id=?').run(location.id, order.id);
    order.location_id = location.id; order.location_name = location.name; order.panel_inbound_id = location.panel_inbound_id; order.panel_cdn_inbound_id = location.panel_cdn_inbound_id;
    const accessToken = subscriptionToken();
    db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(subscriptionId, order.id, accessToken, now);
    audit(actor, 'approve', 'order', order.id);
    if (provisioner) {
      try {
        const result = await provisioner(order);
        db.prepare(`UPDATE subscriptions SET status='active',panel_client_id=?,subscription_url=?,upstream_subscription_url=?,activated_at=? WHERE id=?`).run(result.panelClientId, result.subscriptionUrl, result.subscriptionUrl, new Date().toISOString(), subscriptionId);
      } catch (e) {
        db.prepare(`UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?`).run(String(e.message || e), subscriptionId);
      }
    }
    return { ok: true, subscription: subscriptionRow(subscriptionId) };
  }

  // Load an approved order with the plan fields the provisioner needs, then provision it.
  async function provisionApprovedById(orderId, actor = 'agent') {
    const order = db.prepare(`SELECT o.*,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(orderId);
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' };
    return finalizeApprovedOrder(order, { actor });
  }
  const ocrExtract = autoReviewConfig.ocrEnabled ? (imageUrl => extractReceiptFields(imageUrl)) : null;
  const agentDeps = () => ({ config: autoReviewConfig, provisionApproved: id => provisionApprovedById(id, 'agent'), ocrExtract, actor: 'agent' });
  const triggerReview = orderId => autoReviewConfig.enabled ? evaluateOrder(db, orderId, agentDeps()).catch(() => {}) : Promise.resolve();

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if(req.method==='POST'&&path==='/api/telegram/webhook')return telegramRecovery(req,res,readJson,json);
      const guarded=guard(req,res,path);if(guarded.blocked)return json(res,429,{error:'RATE_LIMITED',requestId:guarded.requestId});
      res.once('finish',()=>{if(process.env.NODE_ENV==='production')console.log(JSON.stringify({time:new Date().toISOString(),requestId:guarded.requestId,method:req.method,path,status:res.statusCode,durationMs:Date.now()-guarded.started}));});
      if (req.method === 'GET' && path === '/api/health') {
        db.prepare('SELECT 1').get();
        return json(res, 200, { ok: true, service: 'nivora' });
      }
      if (req.method === 'GET' && path === '/api/neuralmesh/manifest') {
        if (!neuralMeshManifest) return json(res, 503, { error: 'MANIFEST_UNAVAILABLE' });
        const result = neuralMeshManifest.respond(req.headers.authorization);
        res.setHeader('cache-control', 'no-store, max-age=0');
        res.setHeader('pragma', 'no-cache');
        res.setHeader('vary', 'authorization');
        return json(res, result.status, result.body);
      }
      if (req.method === 'GET' && path === '/') {
        const html = await readFile(resolve('public/index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (req.method === 'GET' && path === '/store.css') {
        const css = await readFile(resolve('public/store.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/store-wizard.css') {
        const css = await readFile(resolve('public/store-wizard.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/store.js') {
        const js = await readFile(resolve('public/store.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(js);
      }
      const receiptFile = path.match(/^\/receipts\/([a-f0-9-]+\.(?:jpg|jpeg|png|webp))$/i);
      if (req.method === 'GET' && receiptFile) {
        const file = await readFile(resolve('receipts', receiptFile[1]));
        const type = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[extname(receiptFile[1]).toLowerCase()];
        res.writeHead(200, { 'content-type':type, 'cache-control':'private, max-age=3600', 'x-content-type-options':'nosniff' }); return res.end(file);
      }
      if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
        const html = await readFile(resolve('public/admin.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (req.method === 'GET' && (path === '/reseller' || path === '/reseller/')) {
        const html=await readFile(resolve('public/reseller.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);
      }
      if(req.method==='GET'&&(path==='/account'||path==='/account/')){const html=await readFile(resolve('public/account.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}
      if(req.method==='GET'&&path==='/account.css'){const css=await readFile(resolve('public/account.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/account-extra.css'){const css=await readFile(resolve('public/account-extra.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/account.js'){const js=await readFile(resolve('public/account.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/account-recovery.js'){const js=await readFile(resolve('public/account-recovery.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/web-notifications.js'){const js=await readFile(resolve('public/web-notifications.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/reseller.css'){const css=await readFile(resolve('public/reseller.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/reseller.js'){const js=await readFile(resolve('public/reseller.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/brand-mark.svg'){const svg=await readFile(resolve('public/brand-mark.svg'));res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'public, max-age=86400'});return res.end(svg);}
      if(req.method==='GET'&&path==='/brand.css'){const css=await readFile(resolve('public/brand.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'public, max-age=3600'});return res.end(css);}
      if (req.method === 'GET' && path === '/admin.css') {
        const css = await readFile(resolve('public/admin.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/admin-extra.css') {
        const css = await readFile(resolve('public/admin-extra.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/admin-resellers.css') {
        const css = await readFile(resolve('public/admin-resellers.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/admin-resellers.js') {
        const js = await readFile(resolve('public/admin-resellers.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(js);
      }
      if (req.method === 'GET' && path === '/admin-account-edit.js') {
        const js = await readFile(resolve('public/admin-account-edit.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(js);
      }
      if (req.method === 'GET' && path === '/admin-locations.js') {
        const js=await readFile(resolve('public/admin-locations.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);
      }
      if (req.method === 'GET' && path === '/admin-nodes.js') {
        const js=await readFile(resolve('public/admin-nodes.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);
      }
      if (req.method === 'GET' && path === '/admin-locations.css') {
        const css=await readFile(resolve('public/admin-locations.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);
      }
      if(req.method==='GET'&&path==='/admin-topups.js'){const js=await readFile(resolve('public/admin-topups.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-notifications.js'){const js=await readFile(resolve('public/admin-notifications.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-topups.css'){const css=await readFile(resolve('public/admin-topups.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/admin-customers.js'){const js=await readFile(resolve('public/admin-customers.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-password-resets.js'){const js=await readFile(resolve('public/admin-password-resets.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-growth.js'){const js=await readFile(resolve('public/admin-growth.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-telegram.js'){const js=await readFile(resolve('public/admin-telegram.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if (req.method === 'GET' && path === '/admin.js') {
        const js = await readFile(resolve('public/admin.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(js);
      }
      if (req.method === 'GET' && path === '/health') {db.prepare('SELECT 1 ok').get();return json(res, 200, { ok:true,service:'nivora',uptimeSeconds:Math.floor(process.uptime()),database:'ok',time:new Date().toISOString() });}

      const publicSubscriptionMatch = path.match(/^\/sub\/([a-f0-9]{32})$/i);
      if (req.method === 'GET' && publicSubscriptionMatch) {
        const subscription = db.prepare(`SELECT s.upstream_subscription_url,s.subscription_url,o.location_id
          FROM subscriptions s JOIN orders o ON o.id=s.order_id
          WHERE s.access_token=? AND s.status='active'`).get(publicSubscriptionMatch[1]);
        if (!subscription) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('SUBSCRIPTION_NOT_FOUND'); }
        const upstream = subscription.upstream_subscription_url || subscription.subscription_url;
        if (!upstream) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('SUBSCRIPTION_NOT_READY'); }
        const endpoints = subscription.location_id ? db.prepare(`SELECT label,host,port,mode,server_name,priority,active FROM location_endpoints WHERE location_id=? AND active=1 ORDER BY priority,created_at`).all(subscription.location_id) : [];
        try {
          const raw = await fetchSubscriptionText(upstream, { rejectUnauthorized: process.env.PANEL_TLS_REJECT_UNAUTHORIZED !== 'false' });
          const rendered = buildMultiEndpointSubscription(raw, endpoints.map(endpoint => ({...endpoint,active:Boolean(endpoint.active)})));
          res.writeHead(200, {
            'content-type':'text/plain; charset=utf-8',
            'cache-control':'private, no-store',
            'x-nivora-routes':String(endpoints.length)
          });
          return res.end(rendered);
        } catch (error) {
          res.writeHead(502, {'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
          return res.end('SUBSCRIPTION_UPSTREAM_UNAVAILABLE');
        }
      }

      if (req.method === 'GET' && path === '/api/plans') {
        const rows = db.prepare(`SELECT p.*,GROUP_CONCAT(l.id||'~'||l.name||'~'||l.country_code||'~'||l.city||'~'||l.flag_emoji,'|') locations FROM plans p
          LEFT JOIN plan_locations pl ON pl.plan_id=p.id LEFT JOIN service_locations l ON l.id=pl.location_id AND l.active=1
          WHERE p.active=1 GROUP BY p.id ORDER BY p.sort_order,p.name`).all();
        return json(res, 200, rows.map(planFromRow));
      }

      if (req.method === 'GET' && path === '/api/store-config') {
        const cards = db.prepare('SELECT id,card_number,card_holder,bank_name FROM payment_cards WHERE active=1 ORDER BY sort_order,created_at').all();
        return json(res, 200, {
          cards,
          supportId: process.env.SUPPORT_ID || '',telegramBotUsername:telegramConfig().enabled?telegramConfig().username:''
        });
      }
      if(req.method==='POST'&&path==='/api/customer/register'){
        const b=await readJson(req),phone=normalizePhone(b.phone);if(!b.name?.trim()||!/^09\d{9}$/.test(phone))return json(res,400,{error:'INVALID_ACCOUNT'});
        let password;try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}
        const id=randomUUID(),now=new Date().toISOString();try{db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,password_hash,password_salt) VALUES(?,?,?,'customer','active',0,?,?,?,?)`).run(id,phone,b.name.trim(),now,now,password.hash,password.salt);db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),id,now);}catch{return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}
        const session=createSession(db,id);audit(phone,'register','account',id);return json(res,201,{...session,account:{id,name:b.name.trim(),phone}});
      }
      if(req.method==='POST'&&path==='/api/customer/login'){
        const b=await readJson(req),account=db.prepare("SELECT * FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(b.phone);if(!account||!verifyPassword(b.password,account.password_salt,account.password_hash))return json(res,401,{error:'INVALID_CREDENTIALS'});const session=createSession(db,account.id);return json(res,200,{...session,account:{id:account.id,name:account.name,phone:account.phone}});
      }
      if(req.method==='POST'&&path==='/api/customer/password-reset/request'){
        const b=await readJson(req),phone=normalizePhone(b.phone);if(!/^09\d{9}$/.test(phone))return json(res,400,{error:'INVALID_PHONE'});
        const account=db.prepare("SELECT id FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(phone);if(!account)return json(res,202,{accepted:true});
        const code=String(randomInt(100000,1000000)),id=randomUUID(),now=new Date(),expires=new Date(now.getTime()+600000);
        db.prepare('UPDATE password_reset_codes SET consumed_at=? WHERE account_id=? AND consumed_at IS NULL').run(now.toISOString(),account.id);
        db.prepare('INSERT INTO password_reset_codes(id,account_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(id,account.id,codeHash(code),expires.toISOString(),now.toISOString());
        try{await sendSms({to:phone,message:`کد بازیابی رمز نیورا: ${code}\nاعتبار: ۱۰ دقیقه`});}catch(e){if(process.env.PASSWORD_RESET_DEBUG_CODE!=='true'){db.prepare('DELETE FROM password_reset_codes WHERE id=?').run(id);return json(res,503,{error:e.message});}}
        audit(phone,'request','password_reset_code',id);return json(res,202,{accepted:true,resetId:id,...(process.env.PASSWORD_RESET_DEBUG_CODE==='true'?{debugCode:code}:{})});
      }
      if(req.method==='POST'&&path==='/api/customer/password-reset/confirm'){
        const b=await readJson(req),phone=normalizePhone(b.phone),row=db.prepare(`SELECT c.*,a.phone FROM password_reset_codes c JOIN accounts a ON a.id=c.account_id WHERE c.id=? AND a.phone=? AND c.consumed_at IS NULL`).get(b.resetId,phone);
        if(!row||row.expires_at<=new Date().toISOString()||row.attempts>=5)return json(res,400,{error:'RESET_CODE_INVALID'});
        if(row.code_hash!==codeHash(String(b.code||''))){db.prepare('UPDATE password_reset_codes SET attempts=attempts+1 WHERE id=?').run(row.id);return json(res,400,{error:'RESET_CODE_INVALID'});}
        let password;try{password=hashPassword(b.newPassword)}catch(e){return json(res,400,{error:e.message});}const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(password.hash,password.salt,now,row.account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(row.account_id);db.prepare('UPDATE password_reset_codes SET consumed_at=? WHERE id=?').run(now,row.id);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return json(res,500,{error:'PASSWORD_RESET_FAILED'});}audit(phone,'confirm','password_reset_code',row.id);return json(res,200,{reset:true});
      }
      if(req.method==='POST'&&path==='/api/customer/password-reset-requests'){
        const b=await readJson(req),phone=String(b.phone||'').trim();
        if(!/^09\d{9}$/.test(phone))return json(res,400,{error:'INVALID_PHONE'});
        const account=db.prepare("SELECT id FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(phone);
        if(account){const pending=db.prepare("SELECT id FROM password_reset_requests WHERE account_id=? AND status='pending'").get(account.id);if(!pending){const id=randomUUID(),now=new Date().toISOString();db.prepare("INSERT INTO password_reset_requests(id,account_id,status,requested_at) VALUES(?,?,'pending',?)").run(id,account.id,now);audit(phone,'request','password_reset',id);}}
        return json(res,202,{accepted:true,message:'اگر حسابی با این شماره وجود داشته باشد، درخواست برای مدیر ارسال می‌شود.'});
      }
      if(path.startsWith('/api/customer/')){
        const account=accountFromRequest(db,req);if(!account||account.role!=='customer')return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&path==='/api/customer/me'){
          const wallet=getWalletStatement(db,account.id,25),panelStats=await readPanelStats();
        const rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.status,o.created_at,o.tracking_token,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,s.access_token subscription_access_token,s.panel_client_id,l.name location_name,l.country_code,l.flag_emoji,l.city,(SELECT COUNT(*) FROM location_endpoints e WHERE e.location_id=o.location_id AND e.active=1) route_count FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.account_id=? AND o.order_kind='purchase' ORDER BY o.created_at DESC LIMIT 100`).all(account.id);
          const orders=rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats));
          const topups=db.prepare('SELECT id,amount_toman,receipt_reference,receipt_image_url,status,review_note,created_at,reviewed_at FROM wallet_topups WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(account.id),notifications=db.prepare('SELECT id,title,body,read_at,created_at FROM notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 30').all(account.id);
          return json(res,200,{id:account.id,name:account.name,phone:account.phone,balanceToman:wallet.balanceToman,transactions:wallet.transactions,orders,topups,notifications});
        }
        if(req.method==='POST'&&path==='/api/customer/discount/validate'){const b=await readJson(req),code=String(b.code||'').trim().toUpperCase(),discount=db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id) used,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id AND account_id=?) customer_used FROM discount_codes d WHERE d.code=? AND d.active=1`).get(account.id,code);if(!discount||(discount.expires_at&&discount.expires_at<=new Date().toISOString())||(discount.max_uses&&discount.used>=discount.max_uses)||discount.customer_used>=discount.per_customer_limit)return json(res,404,{error:'DISCOUNT_NOT_AVAILABLE'});return json(res,200,{code:discount.code,percent:discount.percent});}
        if(req.method==='GET'&&path==='/api/customer/tickets'){const tickets=db.prepare(`SELECT t.*,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t WHERE account_id=? ORDER BY updated_at DESC`).all(account.id);return json(res,200,tickets);}
        if(req.method==='POST'&&path==='/api/customer/tickets'){const b=await readJson(req),subject=String(b.subject||'').trim(),body=String(b.body||'').trim();if(subject.length<3||body.length<3)return json(res,400,{error:'INVALID_TICKET'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO support_tickets(id,account_id,subject,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)`).run(id,account.id,subject,now,now);db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),id,body,now);return json(res,201,{id,status:'open'});}
        const customerTicket=path.match(/^\/api\/customer\/tickets\/([^/]+)$/);if(customerTicket&&req.method==='GET'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=? AND account_id=?').get(customerTicket[1],account.id);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(customerTicket&&req.method==='POST'){const ticket=db.prepare("SELECT * FROM support_tickets WHERE id=? AND account_id=? AND status<>'closed'").get(customerTicket[1],account.id),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='open',updated_at=? WHERE id=?").run(now,ticket.id);return json(res,201,{sent:true});}
        if(req.method==='POST'&&path==='/api/customer/notifications/read'){db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE account_id=?').run(new Date().toISOString(),account.id);return json(res,200,{success:true});}
        if(req.method==='POST'&&path==='/api/customer/wallet/topups'){const b=await readJson(req),amount=Number(b.amountToman);if(!Number.isInteger(amount)||amount<1000||(!b.receiptReference&&!b.receiptImageUrl))return json(res,400,{error:'INVALID_TOPUP'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO wallet_topups(id,account_id,amount_toman,receipt_reference,receipt_image_url,status,created_at) VALUES(?,?,?,?,?,'under_review',?)`).run(id,account.id,amount,b.receiptReference||null,b.receiptImageUrl||null,now);audit(account.id,'create','wallet_topup',id,{amountToman:amount});return json(res,201,{id,status:'under_review',amountToman:amount});}
        if(req.method==='POST'&&path==='/api/customer/wallet/purchase'){
          const b=await readJson(req),plan=db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(b.planId);if(!plan)return json(res,404,{error:'PLAN_NOT_FOUND'});const location=selectLocationForPlan(db,plan.id);if(!location)return json(res,409,{error:'NO_CAPACITY'});
          const basePrice=Math.round(plan.price_irr/10),code=String(b.discountCode||'').trim().toUpperCase();let discount=null;if(code){discount=db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id) used,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id AND account_id=?) customer_used FROM discount_codes d WHERE d.code=? AND d.active=1`).get(account.id,code);if(!discount||(discount.expires_at&&discount.expires_at<=new Date().toISOString())||(discount.max_uses&&discount.used>=discount.max_uses)||discount.customer_used>=discount.per_customer_limit)return json(res,400,{error:'DISCOUNT_NOT_AVAILABLE'});}const discountToman=discount?Math.floor(basePrice*discount.percent/100):0,price=basePrice-discountToman,id=randomUUID(),token=randomUUID().replace(/-/g,''),now=new Date().toISOString();try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`customer-order:${id}`,actor:account.id,note:`خرید ${plan.name}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,account_id,location_id) VALUES(?,?,?,?,'approved',?,?,?,?,?)`).run(id,account.name,account.phone,plan.id,price*10,now,token,account.id,location.id);if(discount)db.prepare('INSERT INTO discount_redemptions(id,discount_id,account_id,order_id,discount_toman,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),discount.id,account.id,id,discountToman,now);const sid=randomUUID(),accessToken=subscriptionToken();db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(sid,id,accessToken,now);
          const order={id,phone:account.phone,plan_name:plan.name,traffic_gb:plan.traffic_gb,duration_days:plan.duration_days,device_limit:plan.device_limit,panel_inbound_id:location.panel_inbound_id,panel_cdn_inbound_id:location.panel_cdn_inbound_id,location_name:location.name};try{if(!provisioner)throw new Error('PROVISIONER_NOT_CONFIGURED');const result=await provisioner(order);db.prepare(`UPDATE subscriptions SET status='active',panel_client_id=?,subscription_url=?,upstream_subscription_url=?,activated_at=? WHERE id=?`).run(result.panelClientId,result.subscriptionUrl,result.subscriptionUrl,new Date().toISOString(),sid);notify(account.id,'اشتراک فعال شد',`پلن ${plan.name} با موفقیت ساخته شد.`);return json(res,201,{id,trackingToken:token,status:'active',subscriptionUrl:publicSubscriptionUrl(req,accessToken,result.subscriptionUrl),balanceToman:getWalletStatement(db,account.id,1).balanceToman,discountToman});}catch(e){db.prepare(`UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?`).run(String(e.message||e),sid);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`customer-refund:${id}`,actor:'system',note:'بازپرداخت خرید ناموفق'});if(discount)db.prepare('DELETE FROM discount_redemptions WHERE order_id=?').run(id);notify(account.id,'بازپرداخت انجام شد','ساخت اشتراک ناموفق بود و مبلغ به کیف پول برگشت.');return json(res,502,{error:'PROVISION_FAILED',refunded:true});}
        }
        const walletRenew=path.match(/^\/api\/customer\/orders\/([^/]+)\/renew$/);if(req.method==='POST'&&walletRenew){
          const original=db.prepare(`SELECT o.*,p.name plan_name,p.price_irr,p.traffic_gb,p.duration_days,s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.account_id=? AND o.order_kind='purchase' AND s.status='active'`).get(walletRenew[1],account.id);if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});const price=Math.round(original.price_irr/10),id=randomUUID(),now=new Date().toISOString();try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`customer-renew:${id}`,actor:account.id,note:`تمدید ${original.plan_name}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,account_id,location_id,order_kind,parent_order_id) VALUES(?,?,?,?,'approved',?,?,?,?,?,'renewal',?)`).run(id,account.name,account.phone,original.plan_id,price*10,now,randomUUID().replace(/-/g,''),account.id,original.location_id,original.id);const sid=randomUUID();db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(sid,id,original.panel_client_id,original.subscription_url,original.upstream_subscription_url||original.subscription_url,now);try{if(!provisioner?.renew)throw new Error('RENEW_NOT_SUPPORTED');await provisioner.renew({panelClientId:original.panel_client_id,addDays:original.duration_days,addTrafficGb:original.traffic_gb});db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(),sid);return json(res,201,{id,status:'active',subscriptionUrl:publicSubscriptionUrl(req,original.subscription_access_token,original.subscription_url),balanceToman:getWalletStatement(db,account.id,1).balanceToman});}catch(e){db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message||e),sid);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`customer-renew-refund:${id}`,actor:'system',note:'بازپرداخت تمدید ناموفق'});return json(res,502,{error:'RENEW_FAILED',refunded:true});}
        }
      }
      if(req.method==='POST'&&path==='/api/reseller/login'){
        const b=await readJson(req),account=db.prepare("SELECT * FROM accounts WHERE phone=? AND role='reseller' AND status='active'").get(b.phone);
        if(!account||!verifyPassword(b.password,account.password_salt,account.password_hash))return json(res,401,{error:'INVALID_CREDENTIALS'});
        const session=createSession(db,account.id);return json(res,200,{...session,account:{id:account.id,name:account.name,phone:account.phone}});
      }
      if(path.startsWith('/api/reseller/')){
        const account=accountFromRequest(db,req);if(!account||account.role!=='reseller')return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&path==='/api/reseller/me'){
          const wallet=getWalletStatement(db,account.id,25),summary=db.prepare(`SELECT
            (SELECT COUNT(*) FROM reseller_customers WHERE reseller_id=? AND status='active') customers_count,
            (SELECT COUNT(*) FROM orders WHERE reseller_id=? AND order_kind='purchase') sales_count,
            (SELECT COUNT(*) FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.reseller_id=? AND o.order_kind='purchase' AND s.status='active') active_subscriptions,
            (SELECT COALESCE(SUM(reseller_sale_price_toman),0) FROM orders WHERE reseller_id=? AND status='approved') total_revenue_toman,
            (SELECT COALESCE(SUM(CAST(amount_transferred_irr/10 AS INTEGER)),0) FROM orders WHERE reseller_id=? AND status='approved') total_cost_toman`).get(account.id,account.id,account.id,account.id,account.id);
          const notifications=db.prepare('SELECT id,title,body,read_at,created_at FROM notifications WHERE account_id=? ORDER BY created_at DESC LIMIT 30').all(account.id);
          return json(res,200,{id:account.id,name:account.name,phone:account.phone,balanceToman:wallet.balanceToman,transactions:wallet.transactions,notifications,customersCount:summary.customers_count,salesCount:summary.sales_count,activeSubscriptions:summary.active_subscriptions,totalRevenueToman:summary.total_revenue_toman,totalProfitToman:summary.total_revenue_toman-summary.total_cost_toman});
        }
        if(req.method==='GET'&&path==='/api/reseller/plans'){
          const rows=db.prepare(`SELECT p.id,p.name,p.description,p.traffic_gb,p.duration_days,p.device_limit,CAST(p.price_irr/10 AS INTEGER) retail_price_toman,r.price_toman,
            GROUP_CONCAT(l.name,'، ') locations FROM plans p LEFT JOIN reseller_plan_prices r ON r.plan_id=p.id AND r.reseller_id=? AND r.active=1 LEFT JOIN plan_locations pl ON pl.plan_id=p.id LEFT JOIN service_locations l ON l.id=pl.location_id AND l.active=1 WHERE p.active=1 GROUP BY p.id ORDER BY p.sort_order`).all(account.id);
          return json(res,200,rows.map(p=>({...p,price_toman:p.price_toman??Math.round(p.retail_price_toman*(100-account.default_discount_percent)/100)})));
        }
        if(req.method==='GET'&&path==='/api/reseller/customers'){
          const q=String(url.searchParams.get('q')||'').trim(),like=`%${q}%`;
          const rows=db.prepare(`SELECT rc.id,rc.name,rc.phone,rc.note,rc.account_id,rc.created_at,rc.updated_at,
            COUNT(DISTINCT CASE WHEN o.order_kind='purchase' THEN o.id END) subscription_count,
            COUNT(DISTINCT CASE WHEN o.order_kind='purchase' AND s.status='active' THEN o.id END) active_subscriptions,
            COUNT(DISTINCT o.id) order_count,MAX(o.created_at) last_order_at,
            COALESCE(SUM(CASE WHEN o.status='approved' THEN o.reseller_sale_price_toman ELSE 0 END),0) revenue_toman,
            COALESCE(SUM(CASE WHEN o.status='approved' THEN CAST(o.amount_transferred_irr/10 AS INTEGER) ELSE 0 END),0) cost_toman
            FROM reseller_customers rc LEFT JOIN orders o ON o.reseller_customer_id=rc.id LEFT JOIN subscriptions s ON s.order_id=o.id
            WHERE rc.reseller_id=? AND rc.status='active' AND (?='' OR rc.name LIKE ? OR rc.phone LIKE ?)
            GROUP BY rc.id ORDER BY COALESCE(MAX(o.created_at),rc.updated_at) DESC LIMIT 500`).all(account.id,q,like,like);
          return json(res,200,rows.map(row=>({...row,profit_toman:row.revenue_toman-row.cost_toman})));
        }
        if(req.method==='POST'&&path==='/api/reseller/customers'){
          const body=await readJson(req),customer=resellerCustomerFromBody({...body,phone:normalizePhone(body.phone)});if(customer.name.length<2||!/^09\d{9}$/.test(customer.phone))return json(res,400,{error:'INVALID_CUSTOMER'});
          let password;try{password=hashPassword(body.password||randomUUID())}catch(e){return json(res,400,{error:e.message});}
          if(db.prepare('SELECT id FROM accounts WHERE phone=?').get(customer.phone)||db.prepare('SELECT id FROM reseller_customers WHERE phone=?').get(customer.phone))return json(res,409,{error:'PHONE_ALREADY_EXISTS'});
          const id=randomUUID(),customerAccountId=randomUUID(),now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,password_hash,password_salt,managed_by_reseller_id) VALUES(?,?,?,'customer','active',0,?,?,?,?,?)`).run(customerAccountId,customer.phone,customer.name,now,now,password.hash,password.salt,account.id);db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),customerAccountId,now);db.prepare("INSERT INTO reseller_customers(id,reseller_id,name,phone,note,status,created_at,updated_at,account_id) VALUES(?,?,?,?,?,'active',?,?,?)").run(id,account.id,customer.name,customer.phone,customer.note,now,now,customerAccountId);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}audit(account.id,'create','reseller_customer',id,{accountId:customerAccountId});notify(customerAccountId,'حساب شما ساخته شد','همکار فروش نیورا حساب کاربری شما را ایجاد کرد.');return json(res,201,{id,...customer,account_id:customerAccountId,created_at:now,updated_at:now});
        }
        const resellerResetMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/reset-password$/);
        if(resellerResetMatch&&req.method==='POST'){
          const customer=db.prepare(`SELECT rc.*,a.id managed_account_id FROM reseller_customers rc JOIN accounts a ON a.id=rc.account_id AND a.managed_by_reseller_id=rc.reseller_id WHERE rc.id=? AND rc.reseller_id=? AND rc.status='active'`).get(resellerResetMatch[1],account.id);if(!customer)return json(res,403,{error:'CUSTOMER_PASSWORD_NOT_MANAGED'});
          const body=await readJson(req);let password;try{password=hashPassword(body.password)}catch(e){return json(res,400,{error:e.message});}const now=new Date().toISOString();db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(password.hash,password.salt,now,customer.managed_account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(customer.managed_account_id);notify(customer.managed_account_id,'رمز عبور تغییر کرد','رمز حساب شما توسط همکار فروش تغییر داده شد.');audit(account.id,'reset_password','reseller_customer',customer.id);return json(res,200,{reset:true});
        }
        if(req.method==='POST'&&path==='/api/reseller/notifications/read'){db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE account_id=?').run(new Date().toISOString(),account.id);return json(res,200,{success:true});}
        if(req.method==='GET'&&path==='/api/reseller/customer-directory'){
          const q=String(url.searchParams.get('q')||'').trim(),like=`%${q}%`;
          const rows=db.prepare(`SELECT a.id,a.name,a.phone,COALESCE(w.balance_toman,0) balance_toman FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id WHERE a.role='customer' AND a.status='active' AND (?='' OR a.name LIKE ? OR a.phone LIKE ?) ORDER BY a.updated_at DESC LIMIT 80`).all(q,like,like);
          return json(res,200,rows);
        }
        const resellerWalletTransfer=path.match(/^\/api\/reseller\/customers\/([^/]+)\/wallet$/);
        if(resellerWalletTransfer&&req.method==='POST'){
          const target=db.prepare("SELECT id,name,phone FROM accounts WHERE id=? AND role='customer' AND status='active'").get(resellerWalletTransfer[1]);
          const body=await readJson(req),amount=Number(body.amountToman),note=String(body.note||'شارژ توسط همکار فروش').trim();
          if(!target)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});if(!Number.isInteger(amount)||amount<=0)return json(res,400,{error:'INVALID_AMOUNT'});
          const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{
            postWalletTransaction(db,{accountId:account.id,amountToman:-amount,type:'transfer_out',reference:`reseller-wallet:${randomUUID()}`,actor:account.id,note:`شارژ کیف پول ${target.phone}`});
            const credited=postWalletTransaction(db,{accountId:target.id,amountToman:amount,type:'transfer_in',reference:`reseller-wallet:${account.id}`,actor:account.id,note});
            attachExistingCustomerToReseller(db,account.id,target,now);db.exec('COMMIT');notify(target.id,'کیف پول شارژ شد',`${amount.toLocaleString('fa-IR')} تومان توسط همکار فروش به کیف پول شما افزوده شد.`);audit(account.id,'wallet_transfer','customer',target.id,{amount,note});return json(res,201,{balanceToman:credited.balanceToman});
          }catch(e){db.exec('ROLLBACK');return json(res,400,{error:e.message});}
        }
        if(req.method==='GET'&&path==='/api/reseller/tickets'){const tickets=db.prepare(`SELECT t.*,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t WHERE account_id=? ORDER BY updated_at DESC`).all(account.id);return json(res,200,tickets);}
        if(req.method==='POST'&&path==='/api/reseller/tickets'){const b=await readJson(req),subject=String(b.subject||'').trim(),body=String(b.body||'').trim();if(subject.length<3||body.length<3)return json(res,400,{error:'INVALID_TICKET'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO support_tickets(id,account_id,subject,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)`).run(id,account.id,subject,now,now);db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),id,body,now);return json(res,201,{id,status:'open'});}
        const resellerTicket=path.match(/^\/api\/reseller\/tickets\/([^/]+)$/);if(resellerTicket&&req.method==='GET'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=? AND account_id=?').get(resellerTicket[1],account.id);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(resellerTicket&&req.method==='POST'){const ticket=db.prepare("SELECT * FROM support_tickets WHERE id=? AND account_id=? AND status<>'closed'").get(resellerTicket[1],account.id),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='open',updated_at=? WHERE id=?").run(now,ticket.id);return json(res,201,{sent:true});}
        const resellerCustomerMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)$/);
        if(resellerCustomerMatch&&req.method==='GET'){
          const customer=db.prepare("SELECT * FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(resellerCustomerMatch[1],account.id);if(!customer)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});
          const panelStats=await readPanelStats(),rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.customer_name,o.phone,o.status,o.created_at,o.amount_transferred_irr,o.reseller_sale_price_toman,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.panel_client_id,l.name location_name,l.country_code,l.flag_emoji,l.city FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.reseller_id=? AND o.reseller_customer_id=? ORDER BY o.created_at DESC LIMIT 200`).all(account.id,customer.id);
          return json(res,200,{...customer,orders:rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats))});
        }
        if(resellerCustomerMatch&&req.method==='PATCH'){
          const current=db.prepare("SELECT * FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(resellerCustomerMatch[1],account.id);if(!current)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});const body=await readJson(req),customer=resellerCustomerFromBody(body);if(customer.name.length<2||!/^09\d{9}$/.test(customer.phone))return json(res,400,{error:'INVALID_CUSTOMER'});
          const duplicate=db.prepare('SELECT id FROM reseller_customers WHERE reseller_id=? AND phone=? AND id<>?').get(account.id,customer.phone,current.id);if(duplicate)return json(res,409,{error:'CUSTOMER_ALREADY_EXISTS'});const now=new Date().toISOString();db.prepare('UPDATE reseller_customers SET name=?,phone=?,note=?,updated_at=? WHERE id=?').run(customer.name,customer.phone,customer.note,now,current.id);db.prepare('UPDATE orders SET customer_name=?,phone=? WHERE reseller_customer_id=?').run(customer.name,customer.phone,current.id);audit(account.id,'update','reseller_customer',current.id);return json(res,200,{id:current.id,...customer,updated_at:now});
        }
        if(resellerCustomerMatch&&req.method==='DELETE'){
          const current=db.prepare("SELECT id FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(resellerCustomerMatch[1],account.id);if(!current)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});db.prepare("UPDATE reseller_customers SET status='archived',updated_at=? WHERE id=?").run(new Date().toISOString(),current.id);audit(account.id,'archive','reseller_customer',current.id);return json(res,200,{archived:true});
        }
        if(req.method==='GET'&&path==='/api/reseller/orders'){
          const panelStats=await readPanelStats(),rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.reseller_customer_id,o.customer_name,o.phone,o.status,o.created_at,o.amount_transferred_irr,o.reseller_sale_price_toman,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.panel_client_id,s.provision_error,l.name location_name,l.country_code,l.flag_emoji,l.city FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.reseller_id=? ORDER BY o.created_at DESC LIMIT 300`).all(account.id);return json(res,200,rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats)));
        }
        const renewMatch=path.match(/^\/api\/reseller\/orders\/([^/]+)\/renew$/);
        if(req.method==='POST'&&renewMatch){
          const body=await readJson(req);
          const original=db.prepare(`SELECT o.*,p.name plan_name,p.price_irr,p.traffic_gb,p.duration_days,p.device_limit,s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.reseller_id=? AND o.order_kind='purchase' AND s.status='active'`).get(renewMatch[1],account.id);
          if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
          const override=db.prepare('SELECT price_toman FROM reseller_plan_prices WHERE reseller_id=? AND plan_id=? AND active=1').get(account.id,original.plan_id),price=override?.price_toman??Math.round((original.price_irr/10)*(100-account.default_discount_percent)/100);
          const salePrice=Number.isInteger(body.salePriceToman)&&body.salePriceToman>=0?body.salePriceToman:(original.reseller_sale_price_toman??Math.round(original.price_irr/10)),id=randomUUID(),now=new Date().toISOString();try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`reseller-renew:${id}`,actor:account.id,note:`تمدید ${original.plan_name} برای ${original.phone}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,reseller_id,location_id,order_kind,parent_order_id,reseller_customer_id,reseller_sale_price_toman) VALUES(?,?,?,?,'approved',?,?,?,?,?,'renewal',?,?,?)`).run(id,original.customer_name,original.phone,original.plan_id,price*10,now,randomUUID().replace(/-/g,''),account.id,original.location_id,original.id,original.reseller_customer_id,salePrice);
          const sid=randomUUID();db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(sid,id,original.panel_client_id,original.subscription_url,original.upstream_subscription_url||original.subscription_url,now);
          try{if(!provisioner?.renew)throw new Error('RENEW_NOT_SUPPORTED');await provisioner.renew({panelClientId:original.panel_client_id,addDays:original.duration_days,addTrafficGb:original.traffic_gb});db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(),sid);notify(account.id,'تمدید موفق',`${original.plan_name} برای ${original.customer_name} تمدید شد.`);return json(res,201,{orderId:id,status:'active',subscriptionUrl:publicSubscriptionUrl(req,original.subscription_access_token,original.subscription_url),balanceToman:getWalletStatement(db,account.id,1).balanceToman});}
          catch(e){db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message||e),sid);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`reseller-renew-refund:${id}`,actor:'system',note:`بازپرداخت تمدید ناموفق ${id}`});return json(res,502,{error:'RENEW_FAILED',refunded:true});}
        }
        const controlMatch=path.match(/^\/api\/reseller\/orders\/([^/]+)\/(suspend|resume|delete)$/);
        if(req.method==='POST'&&controlMatch){
          const body=await readJson(req),action=controlMatch[2],row=db.prepare(`SELECT o.id,o.account_id,o.customer_name,s.id subscription_id,s.status,s.panel_client_id FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.reseller_id=? AND o.order_kind='purchase'`).get(controlMatch[1],account.id);if(!row)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
          const reason=String(body.reason||'').trim();if(action==='suspend'&&reason.length<3)return json(res,400,{error:'SUSPENSION_REASON_REQUIRED'});if(action==='delete'&&body.confirm!==true)return json(res,400,{error:'DELETE_CONFIRMATION_REQUIRED'});
          try{if(action==='suspend'){if(!provisioner?.suspend)throw new Error('CONTROL_NOT_SUPPORTED');await provisioner.suspend({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='suspended',suspension_reason=?,suspended_at=? WHERE id=?").run(reason,new Date().toISOString(),row.subscription_id);}else if(action==='resume'){if(!provisioner?.resume)throw new Error('CONTROL_NOT_SUPPORTED');await provisioner.resume({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='active',suspension_reason=NULL,suspended_at=NULL WHERE id=?").run(row.subscription_id);}else{if(!provisioner?.remove)throw new Error('CONTROL_NOT_SUPPORTED');await provisioner.remove({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='deleted',deleted_at=?,suspension_reason=? WHERE id=?").run(new Date().toISOString(),reason||'حذف توسط همکار',row.subscription_id);}if(row.account_id)notify(row.account_id,action==='suspend'?'اشتراک تعلیق شد':action==='resume'?'اشتراک فعال شد':'اشتراک حذف شد',reason||'درخواست توسط همکار فروش انجام شد.');audit(account.id,action,'subscription',row.subscription_id,{reason});return json(res,200,{status:action==='resume'?'active':action==='suspend'?'suspended':'deleted'});}catch(e){return json(res,502,{error:'PANEL_CONTROL_FAILED',detail:String(e.message||e)});}
        }
        if(req.method==='POST'&&path==='/api/reseller/purchase'){
          const b=await readJson(req),plan=db.prepare(`SELECT p.*,r.price_toman reseller_price FROM plans p LEFT JOIN reseller_plan_prices r ON r.plan_id=p.id AND r.reseller_id=? AND r.active=1 WHERE p.id=? AND p.active=1`).get(account.id,b.planId);
          if(!plan)return json(res,400,{error:'INVALID_PURCHASE'});let customer;
          if(b.customerId)customer=db.prepare("SELECT * FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(b.customerId,account.id);
          else if(b.customerAccountId){const existing=db.prepare("SELECT id,name,phone FROM accounts WHERE id=? AND role='customer' AND status='active'").get(b.customerAccountId);if(existing)customer=attachExistingCustomerToReseller(db,account.id,existing);}
          else try{customer=createOrRestoreResellerCustomer(db,account.id,b);}catch{return json(res,400,{error:'INVALID_CUSTOMER'});}
          if(!customer)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});
          const location=selectLocationForPlan(db,plan.id);if(!location)return json(res,409,{error:'NO_CAPACITY'});
          const price=plan.reseller_price??Math.round((plan.price_irr/10)*(100-account.default_discount_percent)/100),salePrice=Number.isInteger(b.salePriceToman)&&b.salePriceToman>=0?b.salePriceToman:Math.round(plan.price_irr/10),id=randomUUID(),trackingToken=randomUUID().replace(/-/g,''),now=new Date().toISOString();
          try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`reseller-order:${id}`,actor:account.id,note:`خرید ${plan.name} برای ${customer.phone}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,reseller_id,location_id,reseller_customer_id,reseller_sale_price_toman) VALUES(?,?,?,?,'approved',?,?,?,?,?,?,?)`).run(id,customer.name,customer.phone,plan.id,price*10,now,trackingToken,account.id,location.id,customer.id,salePrice);
          const subscriptionId=randomUUID(),accessToken=subscriptionToken();db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(subscriptionId,id,accessToken,now);
          const order={id,phone:customer.phone,plan_name:plan.name,traffic_gb:plan.traffic_gb,duration_days:plan.duration_days,device_limit:plan.device_limit,panel_inbound_id:location.panel_inbound_id,panel_cdn_inbound_id:location.panel_cdn_inbound_id,location_name:location.name};
          try{if(!provisioner)throw new Error('PROVISIONER_NOT_CONFIGURED');const result=await provisioner(order);db.prepare(`UPDATE subscriptions SET status='active',panel_client_id=?,subscription_url=?,upstream_subscription_url=?,activated_at=? WHERE id=?`).run(result.panelClientId,result.subscriptionUrl,result.subscriptionUrl,new Date().toISOString(),subscriptionId);notify(account.id,'فروش موفق',`${plan.name} برای ${customer.name} ساخته شد.`);return json(res,201,{orderId:id,customerId:customer.id,status:'active',subscriptionUrl:publicSubscriptionUrl(req,accessToken,result.subscriptionUrl),balanceToman:getWalletStatement(db,account.id,1).balanceToman});}
          catch(e){db.prepare(`UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?`).run(String(e.message||e),subscriptionId);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`reseller-refund:${id}`,actor:'system',note:`بازپرداخت خرید ناموفق ${id}`});return json(res,502,{error:'PROVISION_FAILED',refunded:true});}
        }
      }

      if (req.method === 'POST' && path === '/api/receipts') {
        const b = await readJson(req);
        const allowed = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
        const ext = allowed[b.mimeType];
        if (!ext || typeof b.data !== 'string') return json(res, 400, { error:'INVALID_RECEIPT' });
        const bytes = Buffer.from(b.data, 'base64');
        if (!bytes.length || bytes.length > 4 * 1024 * 1024) return json(res, 400, { error:'INVALID_RECEIPT_SIZE' });
        await mkdir(resolve('receipts'), { recursive:true });
        const name = `${randomUUID()}.${ext}`;
        await writeFile(resolve('receipts', name), bytes, { flag:'wx' });
        return json(res, 201, { url:`/receipts/${name}` });
      }

      // Bank-SMS ingest webhook (called by an SMS-forwarder app on the phone holding the
      // receiving SIM). Authenticated by a shared secret, NOT the admin token.
      if (req.method === 'POST' && path === '/api/sms/ingest') {
        const secret = process.env.SMS_WEBHOOK_SECRET;
        if (!secret) return json(res, 503, { error: 'SMS_INGEST_DISABLED' });
        const provided = req.headers['x-webhook-secret'] || url.searchParams.get('secret');
        if (provided !== secret) return json(res, 401, { error: 'UNAUTHORIZED' });
        const b = await readJson(req);
        const message = String(b.message || b.text || '').trim();
        if (!message) return json(res, 400, { error: 'EMPTY_MESSAGE' });
        const result = ingestBankMessage(db, { message, receivedAt: b.receivedAt || b.timestamp, sender: b.sender || b.from || '', source: 'sms', defaultUnit: autoReviewConfig.defaultSmsUnit });
        if (result.duplicate) return json(res, 200, { accepted: true, duplicate: true });
        let matched = null;
        if (result.usable) { const sweep = await handler.sweep(); matched = sweep; }
        return json(res, 201, { accepted: true, transactionId: result.id, usable: result.usable, direction: result.parsed.direction, amountRial: result.parsed.amountRial, matched });
      }

      if(req.method==='POST'&&path==='/api/admin/login'){
        const b=await readJson(req),username=String(b.username||'').trim(),password=String(b.password||'');
        if(!activeAdminUsername||!activeAdminPasswordSalt||!activeAdminPasswordHash)return json(res,503,{error:'ADMIN_CREDENTIALS_NOT_CONFIGURED'});
        const suppliedUser=Buffer.from(username),expectedUser=Buffer.from(activeAdminUsername);
        const validUser=suppliedUser.length===expectedUser.length&&timingSafeEqual(suppliedUser,expectedUser);
        if(!validUser||!verifyPassword(password,activeAdminPasswordSalt,activeAdminPasswordHash))return json(res,401,{error:'INVALID_CREDENTIALS'});
        audit('admin','login','admin_session','web');return json(res,200,{token:issueAdminSession(),expiresInHours:adminSessionHours});
      }

      if (path.startsWith('/api/admin/') && !isAdmin(req)) return json(res, 401, { error: 'UNAUTHORIZED' });

      if(req.method==='POST'&&path==='/api/admin/change-password'){
        const b=await readJson(req),currentPassword=String(b.currentPassword||''),newPassword=String(b.newPassword||'');
        if(!verifyPassword(currentPassword,activeAdminPasswordSalt,activeAdminPasswordHash))return json(res,400,{error:'CURRENT_PASSWORD_INCORRECT'});
        if(currentPassword===newPassword)return json(res,400,{error:'PASSWORD_UNCHANGED'});
        let password;try{password=hashPassword(newPassword)}catch(e){return json(res,400,{error:e.message});}
        adminSessionVersion=randomBytes(16).toString('hex');
        activeAdminPasswordSalt=password.salt;activeAdminPasswordHash=password.hash;
        settingSet('admin_username',activeAdminUsername);settingSet('admin_password_salt',password.salt);settingSet('admin_password_hash',password.hash);settingSet('admin_session_version',adminSessionVersion);
        audit('admin','change_password','admin_account','primary');
        return json(res,200,{changed:true});
      }

      if(req.method==='GET'&&path==='/api/admin/telegram-settings'){
        const c=telegramConfig();return json(res,200,{enabled:c.enabled,username:c.username,adminIds:c.adminIds.join(','),tokenConfigured:Boolean(c.token),tokenHint:c.token?`…${c.token.slice(-4)}`:'',webhookSecretConfigured:Boolean(c.secret),webhookUrl:'https://b.nivorali.com/api/telegram/webhook'});
      }
      if(req.method==='PATCH'&&path==='/api/admin/telegram-settings'){
        const b=await readJson(req);if(typeof b.enabled==='boolean')settingSet('telegram_enabled',b.enabled);if(b.adminIds!==undefined)settingSet('telegram_admin_ids',String(b.adminIds).split(',').map(x=>x.trim()).filter(x=>/^\\d+$/.test(x)).join(','));if(String(b.token||'').trim()){if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(b.token).trim()))return json(res,400,{error:'INVALID_TELEGRAM_TOKEN'});settingSet('telegram_token',encrypt(String(b.token).trim()));}if(b.rotateSecret===true||!telegramConfig().secret)settingSet('telegram_secret',encrypt(randomBytes(32).toString('base64url')));audit('admin','update','telegram_settings','telegram');return json(res,200,{saved:true});
      }
      if(req.method==='POST'&&path==='/api/admin/telegram-settings/webhook'){
        const c=telegramConfig();if(!c.enabled||!c.token||!c.secret)return json(res,400,{error:'TELEGRAM_SETTINGS_INCOMPLETE'});const me=await fetch(`https://api.telegram.org/bot${c.token}/getMe`).then(r=>r.json());if(!me.ok)return json(res,400,{error:'INVALID_TELEGRAM_TOKEN'});settingSet('telegram_username',me.result.username);const webhookUrl=`${String(process.env.PUBLIC_BASE_URL||`https://${req.headers.host}`).replace(/\/$/,``)}/api/telegram/webhook`,response=await fetch(`https://api.telegram.org/bot${c.token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:webhookUrl,secret_token:c.secret,drop_pending_updates:true})}),data=await response.json();if(!response.ok||!data.ok)return json(res,502,{error:'TELEGRAM_WEBHOOK_FAILED',detail:data.description});settingSet('telegram_webhook_url',webhookUrl);return json(res,200,{connected:true,url:webhookUrl});
      }
      if(req.method==='GET'&&path==='/api/admin/telegram-settings/status'){
        const c=telegramConfig();if(!c.token)return json(res,200,{connected:false});const response=await fetch(`https://api.telegram.org/bot${c.token}/getWebhookInfo`),data=await response.json();return json(res,200,{connected:Boolean(data.ok&&data.result?.url),url:data.result?.url||'',pending:data.result?.pending_update_count||0,lastError:data.result?.last_error_message||''});
      }

      if (req.method === 'GET' && path === '/api/admin/bank-transactions') {
        const status = url.searchParams.get('status');
        const select = 'SELECT id,amount_rial,tracking_code,card_last4,bank,direction,status,matched_order_id,source,received_at,created_at,raw_message FROM bank_transactions';
        const rows = status ? db.prepare(`${select} WHERE status=? ORDER BY received_at DESC LIMIT 300`).all(status) : db.prepare(`${select} ORDER BY received_at DESC LIMIT 300`).all();
        return json(res, 200, rows);
      }
      const autoReviewMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/auto-review$/);
      if (req.method === 'POST' && autoReviewMatch) {
        const decision = await evaluateOrder(db, autoReviewMatch[1], agentDeps());
        return json(res, 200, decision);
      }
      const orderReviewsMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/reviews$/);
      if (req.method === 'GET' && orderReviewsMatch) {
        return json(res, 200, db.prepare('SELECT * FROM order_reviews WHERE order_id=? ORDER BY created_at DESC LIMIT 50').all(orderReviewsMatch[1]));
      }

      if(req.method==='GET'&&path==='/api/admin/wallet-topups'){const status=url.searchParams.get('status');const select=`SELECT t.*,a.name customer_name,a.phone,COALESCE(w.balance_toman,0) balance_toman FROM wallet_topups t JOIN accounts a ON a.id=t.account_id LEFT JOIN wallet_accounts w ON w.account_id=a.id`;const rows=status?db.prepare(`${select} WHERE t.status=? ORDER BY t.created_at DESC`).all(status):db.prepare(`${select} ORDER BY t.created_at DESC`).all();return json(res,200,rows);}
      if(req.method==='GET'&&path==='/api/admin/financial-summary'){const sales=db.prepare(`SELECT COUNT(*) orders_count,COALESCE(SUM(amount_transferred_irr/10),0) sales_toman FROM orders WHERE status='approved'`).get(),wallets=db.prepare(`SELECT COALESCE(SUM(balance_toman),0) wallet_liability_toman FROM wallet_accounts`).get(),customers=db.prepare(`SELECT COUNT(*) customers_count FROM accounts WHERE role='customer'`).get(),pending=db.prepare(`SELECT COUNT(*) pending_topups,COALESCE(SUM(amount_toman),0) pending_topups_toman FROM wallet_topups WHERE status='under_review'`).get();return json(res,200,{...sales,...wallets,...customers,...pending});}
      const topupReview=path.match(/^\/api\/admin\/wallet-topups\/([^/]+)\/(approve|reject)$/);if(req.method==='POST'&&topupReview){const b=await readJson(req),topup=db.prepare(`SELECT t.*,a.name customer_name,a.phone FROM wallet_topups t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(topupReview[1]);if(!topup)return json(res,404,{error:'TOPUP_NOT_FOUND'});if(topup.status!=='under_review')return json(res,409,{error:'TOPUP_NOT_REVIEWABLE'});const now=new Date().toISOString(),action=topupReview[2];if(action==='reject'){db.prepare("UPDATE wallet_topups SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(b.note||null,b.reviewedBy||'admin',now,topup.id);audit('admin','reject','wallet_topup',topup.id,{note:b.note});return json(res,200,{id:topup.id,status:'rejected'});}db.prepare("UPDATE wallet_topups SET status='approved',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(b.note||null,b.reviewedBy||'admin',now,topup.id);try{const tx=postWalletTransaction(db,{accountId:topup.account_id,amountToman:topup.amount_toman,type:'transfer_in',reference:`wallet-topup:${topup.id}`,actor:'admin',note:`شارژ کیف پول با رسید ${topup.receipt_reference||''}`});audit('admin','approve','wallet_topup',topup.id,{amountToman:topup.amount_toman});return json(res,200,{id:topup.id,status:'approved',balanceToman:tx.balanceToman});}catch(e){db.prepare("UPDATE wallet_topups SET status='under_review',review_note=NULL,reviewed_by=NULL,reviewed_at=NULL WHERE id=?").run(topup.id);return json(res,400,{error:e.message});}}
      if(req.method==='GET'&&path==='/api/admin/discounts'){return json(res,200,db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions r WHERE r.discount_id=d.id) used_count,COALESCE((SELECT SUM(discount_toman) FROM discount_redemptions r WHERE r.discount_id=d.id),0) total_discount_toman FROM discount_codes d ORDER BY d.created_at DESC`).all());}
      if(req.method==='POST'&&path==='/api/admin/discounts'){const b=await readJson(req),code=String(b.code||'').trim().toUpperCase(),percent=Number(b.percent),maxUses=Math.max(Number(b.maxUses)||0,0),limit=Math.max(Number(b.perCustomerLimit)||1,1);if(!/^[A-Z0-9_-]{3,30}$/.test(code)||!Number.isInteger(percent)||percent<1||percent>100)return json(res,400,{error:'INVALID_DISCOUNT'});const id=randomUUID(),now=new Date().toISOString();try{db.prepare(`INSERT INTO discount_codes(id,code,percent,max_uses,per_customer_limit,expires_at,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`).run(id,code,percent,maxUses,limit,b.expiresAt||null,now,now);}catch{return json(res,409,{error:'DISCOUNT_EXISTS'});}return json(res,201,{id,code});}
      const discountMatch=path.match(/^\/api\/admin\/discounts\/([^/]+)$/);if(req.method==='PATCH'&&discountMatch){const old=db.prepare('SELECT * FROM discount_codes WHERE id=?').get(discountMatch[1]);if(!old)return json(res,404,{error:'DISCOUNT_NOT_FOUND'});const b=await readJson(req),percent=Number(b.percent??old.percent),maxUses=Number(b.maxUses??old.max_uses),limit=Number(b.perCustomerLimit??old.per_customer_limit);if(!Number.isInteger(percent)||percent<1||percent>100||maxUses<0||limit<1)return json(res,400,{error:'INVALID_DISCOUNT'});db.prepare('UPDATE discount_codes SET percent=?,max_uses=?,per_customer_limit=?,expires_at=?,active=?,updated_at=? WHERE id=?').run(percent,maxUses,limit,b.expiresAt??old.expires_at,(b.active??Boolean(old.active))?1:0,new Date().toISOString(),old.id);return json(res,200,{id:old.id});}
      if(req.method==='GET'&&path==='/api/admin/tickets'){return json(res,200,db.prepare(`SELECT t.*,a.name customer_name,a.phone,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t JOIN accounts a ON a.id=t.account_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,t.updated_at DESC`).all());}
      if(req.method==='GET'&&path==='/api/admin/notifications'){const openTickets=db.prepare("SELECT COUNT(*) count FROM support_tickets WHERE status='open'").get().count,pendingOrders=db.prepare("SELECT COUNT(*) count FROM orders WHERE status='under_review'").get().count,pendingTopups=db.prepare("SELECT COUNT(*) count FROM wallet_topups WHERE status='under_review'").get().count,pendingResets=db.prepare("SELECT COUNT(*) count FROM password_reset_requests WHERE status='pending'").get().count,latest=db.prepare(`SELECT 'ticket' type,t.subject title,a.name||' · '||COALESCE((SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1),'') body,t.updated_at created_at FROM support_tickets t JOIN accounts a ON a.id=t.account_id WHERE t.status='open' UNION ALL SELECT 'order','پرداخت در انتظار بررسی',customer_name||' · '||phone,created_at FROM orders WHERE status='under_review' UNION ALL SELECT 'topup','شارژ کیف پول در انتظار بررسی',a.name||' · '||w.amount_toman||' تومان',w.created_at FROM wallet_topups w JOIN accounts a ON a.id=w.account_id WHERE w.status='under_review' ORDER BY created_at DESC LIMIT 30`).all();return json(res,200,{counts:{openTickets,pendingOrders,pendingTopups,pendingResets},items:latest});}
      const adminTicket=path.match(/^\/api\/admin\/tickets\/([^/]+)$/);if(adminTicket&&req.method==='GET'){const ticket=db.prepare(`SELECT t.*,a.name customer_name,a.phone FROM support_tickets t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(adminTicket[1]);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(adminTicket&&req.method==='POST'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=?').get(adminTicket[1]),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(b.close===true){db.prepare("UPDATE support_tickets SET status='closed',updated_at=? WHERE id=?").run(new Date().toISOString(),ticket.id);notify(ticket.account_id,'تیکت بسته شد',ticket.subject);return json(res,200,{status:'closed'});}if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'admin',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='answered',updated_at=? WHERE id=?").run(now,ticket.id);notify(ticket.account_id,'پاسخ پشتیبانی',ticket.subject);return json(res,201,{sent:true});}

      if (req.method === 'GET' && path === '/api/admin/plans') {
        return json(res, 200, db.prepare('SELECT * FROM plans ORDER BY sort_order,name').all().map(planFromRow));
      }

      if (req.method === 'GET' && path === '/api/admin/cards') {
        return json(res, 200, db.prepare('SELECT * FROM payment_cards ORDER BY sort_order,created_at').all().map(c => ({
          id:c.id, cardNumber:c.card_number, cardHolder:c.card_holder, bankName:c.bank_name,
          sortOrder:c.sort_order, active:Boolean(c.active), createdAt:c.created_at, updatedAt:c.updated_at
        })));
      }
      if(req.method==='GET'&&path==='/api/admin/locations'){
        const rows=db.prepare(`SELECT l.*,n.name panel_node_name,COUNT(DISTINCT pl.plan_id) plan_count,
          (SELECT COUNT(*) FROM location_endpoints e WHERE e.location_id=l.id) endpoint_count,
          (SELECT COUNT(*) FROM location_endpoints e WHERE e.location_id=l.id AND e.active=1 AND e.health_status='online') online_endpoint_count
          FROM service_locations l LEFT JOIN panel_nodes n ON n.id=l.panel_node_id LEFT JOIN plan_locations pl ON pl.location_id=l.id GROUP BY l.id ORDER BY l.active DESC,l.name`).all();return json(res,200,rows);
      }
      const nodeFromBody=b=>({name:String(b.name||'').trim().slice(0,80),provider:String(b.provider||'').trim().slice(0,80),panelType:String(b.panelType||'3x-ui').trim().slice(0,30),baseUrl:String(b.baseUrl||'').trim().replace(/\/$/,'').slice(0,500),apiToken:String(b.apiToken||'').trim(),active:b.active!==false});
      const validNode=node=>node.name.length>=2&&node.panelType==='3x-ui'&&(!node.baseUrl||(()=>{try{const u=new URL(node.baseUrl);return u.protocol==='https:'||u.protocol==='http:'}catch{return false}})());
      if(req.method==='GET'&&path==='/api/admin/panel-nodes'){const rows=db.prepare('SELECT id,name,provider,panel_type,base_url,api_token_encrypted,active,created_at,updated_at FROM panel_nodes ORDER BY active DESC,name').all();return json(res,200,rows.map(n=>({id:n.id,name:n.name,provider:n.provider,panelType:n.panel_type,baseUrl:n.base_url,tokenConfigured:Boolean(decrypt(n.api_token_encrypted)),active:Boolean(n.active),createdAt:n.created_at,updatedAt:n.updated_at,locationCount:db.prepare('SELECT COUNT(*) count FROM service_locations WHERE panel_node_id=?').get(n.id).count})));}
      if(req.method==='POST'&&path==='/api/admin/panel-nodes'){const n=nodeFromBody(await readJson(req));if(!validNode(n))return json(res,400,{error:'INVALID_PANEL_NODE'});const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO panel_nodes(id,name,provider,panel_type,base_url,api_token_encrypted,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,n.name,n.provider,n.panelType,n.baseUrl,n.apiToken?encrypt(n.apiToken):'',n.active?1:0,now,now);audit('admin','create','panel_node',id,{name:n.name,baseUrl:n.baseUrl});return json(res,201,{id});}
      const panelNodeMatch=path.match(/^\/api\/admin\/panel-nodes\/([^/]+)$/);
      if(req.method==='PATCH'&&panelNodeMatch){const old=db.prepare('SELECT * FROM panel_nodes WHERE id=?').get(panelNodeMatch[1]);if(!old)return json(res,404,{error:'PANEL_NODE_NOT_FOUND'});const raw=await readJson(req),n=nodeFromBody({...old,name:raw.name??old.name,provider:raw.provider??old.provider,panelType:raw.panelType??old.panel_type,baseUrl:raw.baseUrl??old.base_url,apiToken:raw.apiToken??'',active:raw.active??Boolean(old.active)});if(!validNode(n))return json(res,400,{error:'INVALID_PANEL_NODE'});db.prepare('UPDATE panel_nodes SET name=?,provider=?,panel_type=?,base_url=?,api_token_encrypted=?,active=?,updated_at=? WHERE id=?').run(n.name,n.provider,n.panelType,n.baseUrl,n.apiToken?encrypt(n.apiToken):old.api_token_encrypted,n.active?1:0,new Date().toISOString(),old.id);audit('admin','update','panel_node',old.id,{name:n.name,baseUrl:n.baseUrl});return json(res,200,{id:old.id});}
      if(req.method==='DELETE'&&panelNodeMatch){const count=db.prepare('SELECT COUNT(*) count FROM service_locations WHERE panel_node_id=?').get(panelNodeMatch[1]).count;if(count)return json(res,409,{error:'PANEL_NODE_IN_USE'});db.prepare('DELETE FROM panel_nodes WHERE id=?').run(panelNodeMatch[1]);audit('admin','delete','panel_node',panelNodeMatch[1]);return json(res,200,{deleted:true});}
      if(req.method==='POST'&&path==='/api/admin/locations'){
        const b=await readJson(req),country=String(b.countryCode||'').trim().toUpperCase();if(!b.name?.trim()||!/^[A-Z]{2}$/.test(country))return json(res,400,{error:'INVALID_LOCATION'});
        const nodeId=String(b.panelNodeId||'').trim()||null;if(nodeId&&!db.prepare('SELECT id FROM panel_nodes WHERE id=?').get(nodeId))return json(res,400,{error:'INVALID_PANEL_NODE'});
        const flag=String(b.flagEmoji||'').trim().slice(0,16);
        const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO service_locations(id,name,country_code,flag_emoji,city,provider,panel_type,panel_node_id,panel_inbound_id,panel_cdn_inbound_id,capacity,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,b.name.trim(),country,flag,b.city?.trim()||'',b.provider?.trim()||'',b.panelType||'3x-ui',nodeId,b.panelInboundId||null,b.panelCdnInboundId||null,Math.max(Number(b.capacity)||0,0),b.active===false?0:1,now,now);audit('admin','create','location',id,{name:b.name,country,nodeId});return json(res,201,{id});
      }
      const locationEndpoints=path.match(/^\/api\/admin\/locations\/([^/]+)\/endpoints$/);
      if(req.method==='GET'&&locationEndpoints){const location=db.prepare('SELECT id FROM service_locations WHERE id=?').get(locationEndpoints[1]);if(!location)return json(res,404,{error:'LOCATION_NOT_FOUND'});const rows=db.prepare('SELECT * FROM location_endpoints WHERE location_id=? ORDER BY priority,created_at').all(location.id);return json(res,200,rows.map(endpoint=>({...endpoint,active:Boolean(endpoint.active),transportMode:endpoint.mode})));}
      if(req.method==='POST'&&locationEndpoints){const location=db.prepare('SELECT id FROM service_locations WHERE id=?').get(locationEndpoints[1]);if(!location)return json(res,404,{error:'LOCATION_NOT_FOUND'});const endpoint=endpointFromBody(await readJson(req));if(!validEndpoint(endpoint))return json(res,400,{error:'INVALID_ENDPOINT'});const id=randomUUID(),now=new Date().toISOString();try{db.prepare(`INSERT INTO location_endpoints(id,location_id,label,host,port,mode,server_name,source_url,priority,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,location.id,endpoint.label,endpoint.host,endpoint.port,endpoint.mode,endpoint.serverName||null,endpoint.sourceUrl||null,endpoint.priority,endpoint.active?1:0,now,now);}catch{return json(res,409,{error:'ENDPOINT_ALREADY_EXISTS'});}audit('admin','create','location_endpoint',id,{locationId:location.id,host:endpoint.host,port:endpoint.port,mode:endpoint.mode});return json(res,201,{id,...endpoint,transportMode:endpoint.mode});}
      const endpointImport=path.match(/^\/api\/admin\/locations\/([^/]+)\/endpoints\/import$/);
      if(req.method==='POST'&&endpointImport){
        const location=db.prepare('SELECT id,panel_cdn_inbound_id FROM service_locations WHERE id=?').get(endpointImport[1]);if(!location)return json(res,404,{error:'LOCATION_NOT_FOUND'});
        const b=await readJson(req),serverName=String(b.serverName||'').trim().toLowerCase(),sourceUrl=String(b.sourceUrl||'').trim(),raw=String(b.raw||''),limit=Math.max(1,Math.min(Number(b.limit)||20,100)),port=Number(b.port||443),prefix=String(b.labelPrefix||'Cloudflare').trim().slice(0,40);
        if(!validHost(serverName)||net.isIP(serverName)||!Number.isInteger(port)||port<1||port>65535||(!sourceUrl&&!raw))return json(res,400,{error:'INVALID_CLEAN_IP_IMPORT'});
        let ips;try{ips=sourceUrl?(await fetchCleanIpSource(sourceUrl,{limit})).ips:parseCleanIpList(raw,limit);}catch(error){return json(res,400,{error:error.message||'CLEAN_IP_IMPORT_FAILED'});}
        if(!ips.length)return json(res,400,{error:'NO_CLOUDFLARE_IPS_FOUND'});
        const now=new Date().toISOString(),insert=db.prepare(`INSERT OR IGNORE INTO location_endpoints(id,location_id,label,host,port,mode,server_name,source_url,priority,active,created_at,updated_at) VALUES(?,?,?,?,?,'cloudflare',?,?,?,1,?,?)`);let imported=0;
        for(const [index,host] of ips.entries()){const result=insert.run(randomUUID(),location.id,`${prefix} ${String(index+1).padStart(2,'0')}`,host,port,serverName,sourceUrl||null,(index+1)*10,now,now);imported+=Number(result.changes||0);}
        audit('admin','import','cloudflare_endpoints',location.id,{sourceUrl:sourceUrl||'manual',found:ips.length,imported,serverName});return json(res,201,{found:ips.length,imported,skipped:ips.length-imported});
      }
      const endpointTest=path.match(/^\/api\/admin\/location-endpoints\/([^/]+)\/test$/);
      if(req.method==='POST'&&endpointTest){const endpoint=db.prepare('SELECT * FROM location_endpoints WHERE id=?').get(endpointTest[1]);if(!endpoint)return json(res,404,{error:'ENDPOINT_NOT_FOUND'});const checkedAt=new Date().toISOString();try{const latencyMs=endpoint.mode==='cloudflare'?await measureCloudflareEndpoint(endpoint.host,endpoint.port,endpoint.server_name):await measureTcpEndpoint(endpoint.host,endpoint.port);db.prepare("UPDATE location_endpoints SET health_status='online',last_latency_ms=?,last_checked_at=?,updated_at=? WHERE id=?").run(latencyMs,checkedAt,checkedAt,endpoint.id);return json(res,200,{status:'online',latencyMs,checkedAt});}catch{db.prepare("UPDATE location_endpoints SET health_status='offline',last_latency_ms=NULL,last_checked_at=?,updated_at=? WHERE id=?").run(checkedAt,checkedAt,endpoint.id);return json(res,200,{status:'offline',latencyMs:null,checkedAt});}}
      const endpointMatch=path.match(/^\/api\/admin\/location-endpoints\/([^/]+)$/);
      if(req.method==='PATCH'&&endpointMatch){const old=db.prepare('SELECT * FROM location_endpoints WHERE id=?').get(endpointMatch[1]);if(!old)return json(res,404,{error:'ENDPOINT_NOT_FOUND'});const endpoint=endpointFromBody(await readJson(req),old);if(!validEndpoint(endpoint))return json(res,400,{error:'INVALID_ENDPOINT'});try{db.prepare("UPDATE location_endpoints SET label=?,host=?,port=?,mode=?,server_name=?,source_url=?,priority=?,active=?,health_status='unknown',last_latency_ms=NULL,last_checked_at=NULL,updated_at=? WHERE id=?").run(endpoint.label,endpoint.host,endpoint.port,endpoint.mode,endpoint.serverName||null,endpoint.sourceUrl||null,endpoint.priority,endpoint.active?1:0,new Date().toISOString(),old.id);}catch{return json(res,409,{error:'ENDPOINT_ALREADY_EXISTS'});}audit('admin','update','location_endpoint',old.id,{host:endpoint.host,port:endpoint.port,mode:endpoint.mode});return json(res,200,{id:old.id,...endpoint,transportMode:endpoint.mode});}
      if(req.method==='DELETE'&&endpointMatch){const endpoint=db.prepare('SELECT * FROM location_endpoints WHERE id=?').get(endpointMatch[1]);if(!endpoint)return json(res,404,{error:'ENDPOINT_NOT_FOUND'});db.prepare('DELETE FROM location_endpoints WHERE id=?').run(endpoint.id);audit('admin','delete','location_endpoint',endpoint.id,{host:endpoint.host});return json(res,200,{deleted:true});}
      const locationMatch=path.match(/^\/api\/admin\/locations\/([^/]+)$/);
      if(req.method==='PATCH'&&locationMatch){const old=db.prepare('SELECT * FROM service_locations WHERE id=?').get(locationMatch[1]);if(!old)return json(res,404,{error:'LOCATION_NOT_FOUND'});const b=await readJson(req),name=String(b.name??old.name).trim(),country=String(b.countryCode??old.country_code).trim().toUpperCase(),flag=String(b.flagEmoji??old.flag_emoji??'').trim().slice(0,16),directInbound=b.panelInboundId===undefined?old.panel_inbound_id:(Number(b.panelInboundId)||null),cdnInbound=b.panelCdnInboundId===undefined?old.panel_cdn_inbound_id:(Number(b.panelCdnInboundId)||null),nodeId=b.panelNodeId===undefined?old.panel_node_id:(String(b.panelNodeId||'').trim()||null);if(!name||!/^[A-Z]{2}$/.test(country)||(nodeId&&!db.prepare('SELECT id FROM panel_nodes WHERE id=?').get(nodeId)))return json(res,400,{error:'INVALID_LOCATION'});db.prepare(`UPDATE service_locations SET name=?,country_code=?,flag_emoji=?,city=?,provider=?,panel_type=?,panel_node_id=?,panel_inbound_id=?,panel_cdn_inbound_id=?,capacity=?,active=?,updated_at=? WHERE id=?`).run(name,country,flag,b.city??old.city,b.provider??old.provider,b.panelType??old.panel_type,nodeId,directInbound,cdnInbound,Math.max(Number(b.capacity??old.capacity),0),(b.active??Boolean(old.active))?1:0,new Date().toISOString(),locationMatch[1]);return json(res,200,{id:locationMatch[1]});}
      if(req.method==='DELETE'&&locationMatch){const count=db.prepare('SELECT COUNT(*) count FROM plan_locations WHERE location_id=?').get(locationMatch[1]).count;if(count)return json(res,409,{error:'LOCATION_IN_USE'});db.prepare('DELETE FROM service_locations WHERE id=?').run(locationMatch[1]);return json(res,200,{deleted:true});}
      const locationPlans=path.match(/^\/api\/admin\/locations\/([^/]+)\/plans$/);
      if(req.method==='GET'&&locationPlans){const rows=db.prepare(`SELECT p.id,p.name,CASE WHEN pl.plan_id IS NULL THEN 0 ELSE 1 END attached FROM plans p LEFT JOIN plan_locations pl ON pl.plan_id=p.id AND pl.location_id=? ORDER BY p.sort_order`).all(locationPlans[1]);return json(res,200,rows.map(p=>({...p,attached:Boolean(p.attached)})));}
      if(req.method==='POST'&&locationPlans){const b=await readJson(req);if(!Array.isArray(b.planIds))return json(res,400,{error:'INVALID_PLANS'});db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM plan_locations WHERE location_id=?').run(locationPlans[1]);const add=db.prepare('INSERT INTO plan_locations(plan_id,location_id) VALUES(?,?)');for(const id of b.planIds)add.run(id,locationPlans[1]);db.exec('COMMIT');return json(res,200,{success:true});}catch(e){db.exec('ROLLBACK');return json(res,400,{error:'INVALID_PLANS'});}}

      if (req.method === 'GET' && path === '/api/admin/accounts') {
        const role=url.searchParams.get('role');
        const base=`SELECT a.*,COALESCE(w.balance_toman,0) balance_toman FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id`;
        const rows=role?db.prepare(`${base} WHERE a.role=? ORDER BY a.created_at DESC`).all(role):db.prepare(`${base} ORDER BY a.created_at DESC`).all();
        return json(res,200,rows);
      }
      if(req.method==='GET'&&path==='/api/admin/password-reset-requests'){
        return json(res,200,db.prepare(`SELECT r.id,r.status,r.requested_at,r.resolved_at,a.id account_id,a.name,a.phone FROM password_reset_requests r JOIN accounts a ON a.id=r.account_id ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.requested_at DESC LIMIT 200`).all());
      }
      const passwordResetMatch=path.match(/^\/api\/admin\/password-reset-requests\/([^/]+)\/(resolve|dismiss)$/);
      if(req.method==='POST'&&passwordResetMatch){const request=db.prepare("SELECT r.*,a.phone FROM password_reset_requests r JOIN accounts a ON a.id=r.account_id WHERE r.id=? AND r.status='pending'").get(passwordResetMatch[1]);if(!request)return json(res,404,{error:'PASSWORD_RESET_NOT_FOUND'});const now=new Date().toISOString();if(passwordResetMatch[2]==='dismiss'){db.prepare("UPDATE password_reset_requests SET status='dismissed',resolved_at=?,resolved_by='admin' WHERE id=?").run(now,request.id);audit('admin','dismiss','password_reset',request.id);return json(res,200,{status:'dismissed'});}const b=await readJson(req);let password;try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(password.hash,password.salt,now,request.account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(request.account_id);db.prepare("UPDATE password_reset_requests SET status='resolved',resolved_at=?,resolved_by='admin' WHERE id=?").run(now,request.id);db.exec('COMMIT');audit('admin','resolve','password_reset',request.id,{accountId:request.account_id});return json(res,200,{status:'resolved'});}catch(e){db.exec('ROLLBACK');return json(res,500,{error:'PASSWORD_RESET_FAILED'});}}
      if (req.method === 'POST' && path === '/api/admin/accounts') {
        const b=await readJson(req);
        if(!b.name?.trim()||!['customer','reseller','staff'].includes(b.role)||!/^09\d{9}$/.test(b.phone||''))return json(res,400,{error:'INVALID_ACCOUNT'});
        let password;if(['customer','reseller'].includes(b.role)){try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}}
        const id=randomUUID(),now=new Date().toISOString();
        db.prepare('INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,password_hash,password_salt) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id,b.phone,b.name.trim(),b.role,'active',Math.min(Math.max(Number(b.defaultDiscountPercent)||0,0),100),now,now,password?.hash||null,password?.salt||null);
        db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),id,now);
        audit('admin','create','account',id,{role:b.role,phone:b.phone});
        return json(res,201,{id,phone:b.phone,name:b.name.trim(),role:b.role,status:'active',defaultDiscountPercent:Number(b.defaultDiscountPercent)||0});
      }
      const accountMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      if(req.method==='PATCH'&&accountMatch){
        const old=db.prepare('SELECT * FROM accounts WHERE id=?').get(accountMatch[1]);if(!old)return json(res,404,{error:'ACCOUNT_NOT_FOUND'});
        const b=await readJson(req),name=String(b.name??old.name).trim(),phone=String(b.phone??old.phone),status=b.status??old.status,discount=Number(b.defaultDiscountPercent??old.default_discount_percent);
        if(!name||!/^09\d{9}$/.test(phone)||!['active','suspended'].includes(status)||!Number.isInteger(discount)||discount<0||discount>100)return json(res,400,{error:'INVALID_ACCOUNT'});
        let password=null;if(b.password){try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}}
        try{db.prepare(`UPDATE accounts SET name=?,phone=?,status=?,default_discount_percent=?,password_hash=COALESCE(?,password_hash),password_salt=COALESCE(?,password_salt),updated_at=? WHERE id=?`).run(name,phone,status,discount,password?.hash||null,password?.salt||null,new Date().toISOString(),accountMatch[1]);}
        catch{return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}
        if(password)db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(accountMatch[1]);
        audit('admin','update','account',accountMatch[1],{status,discount,passwordChanged:Boolean(password)});return json(res,200,{id:accountMatch[1],name,phone,status,defaultDiscountPercent:discount,passwordChanged:Boolean(password)});
      }
      if(req.method==='DELETE'&&accountMatch){
        const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(accountMatch[1]);if(!account)return json(res,404,{error:'ACCOUNT_NOT_FOUND'});
        const ordersCount=db.prepare('SELECT COUNT(*) count FROM orders WHERE account_id=? OR reseller_id=?').get(account.id,account.id).count;
        const txCount=db.prepare(`SELECT COUNT(*) count FROM wallet_transactions t JOIN wallet_accounts w ON w.id=t.wallet_id WHERE w.account_id=?`).get(account.id).count;
        if(ordersCount||txCount)return json(res,409,{error:'ACCOUNT_HAS_HISTORY',canSuspend:true});
        db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(account.id);db.prepare('DELETE FROM reseller_plan_prices WHERE reseller_id=?').run(account.id);db.prepare('DELETE FROM wallet_accounts WHERE account_id=?').run(account.id);db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);db.exec('COMMIT');audit('admin','delete','account',account.id,{phone:account.phone});return json(res,200,{deleted:true});}catch(e){db.exec('ROLLBACK');return json(res,400,{error:'DELETE_FAILED'});}
      }
      const walletMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)\/wallet$/);
      if(req.method==='GET'&&walletMatch)return json(res,200,getWalletStatement(db,walletMatch[1],Number(url.searchParams.get('limit'))||50));
      if(req.method==='POST'&&walletMatch){
        const b=await readJson(req),amount=Number(b.amountToman);
        try{return json(res,201,postWalletTransaction(db,{accountId:walletMatch[1],amountToman:amount,type:amount>0?'manual_credit':'manual_debit',reference:b.reference||`admin-${randomUUID()}`,actor:'admin',note:b.note||null}));}
        catch(e){return json(res,400,{error:e.message});}
      }
      const priceMatch=path.match(/^\/api\/admin\/resellers\/([^/]+)\/prices$/);
      if(req.method==='GET'&&priceMatch){
        const reseller=db.prepare("SELECT id,default_discount_percent FROM accounts WHERE id=? AND role='reseller'").get(priceMatch[1]);if(!reseller)return json(res,404,{error:'RESELLER_NOT_FOUND'});
        const rows=db.prepare(`SELECT p.id plan_id,p.name,CAST(p.price_irr/10 AS INTEGER) retail_price_toman,r.price_toman,r.active
          FROM plans p LEFT JOIN reseller_plan_prices r ON r.plan_id=p.id AND r.reseller_id=? ORDER BY p.sort_order,p.name`).all(priceMatch[1]);
        return json(res,200,{defaultDiscountPercent:reseller.default_discount_percent,plans:rows.map(p=>({...p,effective_price_toman:p.price_toman??Math.round(p.retail_price_toman*(100-reseller.default_discount_percent)/100)}))});
      }
      if(req.method==='POST'&&priceMatch){const b=await readJson(req);if(!Array.isArray(b.prices))return json(res,400,{error:'INVALID_PRICES'});const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{const upsert=db.prepare(`INSERT INTO reseller_plan_prices(reseller_id,plan_id,price_toman,active,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(reseller_id,plan_id) DO UPDATE SET price_toman=excluded.price_toman,active=excluded.active,updated_at=excluded.updated_at`);for(const p of b.prices)upsert.run(priceMatch[1],p.planId,Number(p.priceToman),p.active===false?0:1,now);db.exec('COMMIT');return json(res,200,{success:true});}catch(e){db.exec('ROLLBACK');return json(res,400,{error:'INVALID_PRICES'});}}

      if (req.method === 'POST' && path === '/api/admin/cards') {
        const b = await readJson(req), digits = String(b.cardNumber || '').replace(/\D/g, '');
        if (digits.length !== 16 || !b.cardHolder?.trim()) return json(res, 400, { error:'INVALID_CARD' });
        const id=randomUUID(), now=new Date().toISOString();
        db.prepare(`INSERT INTO payment_cards(id,card_number,card_holder,bank_name,sort_order,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(id,digits,b.cardHolder.trim(),b.bankName?.trim()||'',b.sortOrder||0,b.active===false?0:1,now,now);
        audit('admin','create','payment_card',id,{cardNumber:`****${digits.slice(-4)}`});
        return json(res,201,{id,cardNumber:digits,cardHolder:b.cardHolder.trim(),bankName:b.bankName?.trim()||'',sortOrder:b.sortOrder||0,active:b.active!==false});
      }

      const cardMatch = path.match(/^\/api\/admin\/cards\/([^/]+)$/);
      if (req.method === 'PATCH' && cardMatch) {
        const old=db.prepare('SELECT * FROM payment_cards WHERE id=?').get(cardMatch[1]);
        if(!old)return json(res,404,{error:'CARD_NOT_FOUND'});
        const incoming=await readJson(req), digits=String(incoming.cardNumber??old.card_number).replace(/\D/g,'');
        const holder=String(incoming.cardHolder??old.card_holder).trim();
        if(digits.length!==16||!holder)return json(res,400,{error:'INVALID_CARD'});
        const now=new Date().toISOString();
        db.prepare('UPDATE payment_cards SET card_number=?,card_holder=?,bank_name=?,sort_order=?,active=?,updated_at=? WHERE id=?')
          .run(digits,holder,incoming.bankName??old.bank_name,incoming.sortOrder??old.sort_order,(incoming.active??Boolean(old.active))?1:0,now,cardMatch[1]);
        audit('admin','update','payment_card',cardMatch[1],{cardNumber:`****${digits.slice(-4)}`});
        return json(res,200,{id:cardMatch[1],cardNumber:digits,cardHolder:holder,bankName:incoming.bankName??old.bank_name,sortOrder:incoming.sortOrder??old.sort_order,active:incoming.active??Boolean(old.active)});
      }

      if (req.method === 'POST' && path === '/api/admin/plans') {
        const b = await readJson(req);
        if (!validPlan(b)) return json(res, 400, { error: 'INVALID_PLAN' });
        const id = randomUUID(), now = new Date().toISOString();
        db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,sort_order,active,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, b.name.trim(), b.description || '', b.priceIrr * 10, b.trafficGb, b.durationDays,
          b.deviceLimit, b.sortOrder || 0, b.active === false ? 0 : 1, now, now);
        audit('admin', 'create', 'plan', id, b);
        return json(res, 201, planFromRow(db.prepare('SELECT * FROM plans WHERE id=?').get(id)));
      }

      const planMatch = path.match(/^\/api\/admin\/plans\/([^/]+)$/);
      if (req.method === 'PATCH' && planMatch) {
        const old = db.prepare('SELECT * FROM plans WHERE id=?').get(planMatch[1]);
        if (!old) return json(res, 404, { error: 'PLAN_NOT_FOUND' });
        const b = { ...planFromRow(old), ...(await readJson(req)) };
        if (!validPlan(b)) return json(res, 400, { error: 'INVALID_PLAN' });
        const now = new Date().toISOString();
        db.prepare(`UPDATE plans SET name=?,description=?,price_irr=?,traffic_gb=?,duration_days=?,device_limit=?,sort_order=?,active=?,updated_at=? WHERE id=?`)
          .run(b.name.trim(), b.description || '', b.priceIrr * 10, b.trafficGb, b.durationDays, b.deviceLimit, b.sortOrder || 0, b.active ? 1 : 0, now, planMatch[1]);
        audit('admin', 'update', 'plan', planMatch[1], b);
        return json(res, 200, planFromRow(db.prepare('SELECT * FROM plans WHERE id=?').get(planMatch[1])));
      }

      if (req.method === 'POST' && path === '/api/orders') {
        const b = await readJson(req);
        const plan = db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(b.planId);
        if (!plan || !b.customerName?.trim() || !/^09\d{9}$/.test(b.phone || ''))
          return json(res, 400, { error: 'INVALID_ORDER' });
        const hasReceipt = Boolean(b.receiptReference || b.receiptImageUrl);
        const id = randomUUID(), trackingToken = randomUUID().replace(/-/g, '');
        db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,receipt_reference,receipt_image_url,created_at,tracking_token)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, b.customerName.trim(), b.phone, plan.id, hasReceipt ? 'under_review' : 'awaiting_receipt',
          b.amountTransferredIrr ? b.amountTransferredIrr * 10 : null, b.receiptReference || null, b.receiptImageUrl || null, new Date().toISOString(), trackingToken);
        audit(b.phone, 'create', 'order', id);
        if (hasReceipt) await triggerReview(id);
        return json(res, 201, { id, trackingToken, status: hasReceipt ? 'under_review' : 'awaiting_receipt', expectedAmountIrr: Math.round(plan.price_irr / 10) });
      }

      const statusMatch = path.match(/^\/api\/orders\/([^/]+)$/);
      if (req.method === 'GET' && statusMatch) {
        const row = db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.customer_name,o.phone,o.status,o.created_at,o.review_note,p.name plan_name,CAST(p.price_irr/10 AS INTEGER) price_toman,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token
          FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id
          WHERE o.id=? AND o.tracking_token=?`).get(statusMatch[1], url.searchParams.get('token'));
        if (!row) return json(res, 404, { error:'ORDER_NOT_FOUND' });
        return json(res, 200, exposeSubscription(req,row));
      }
      const customerRenewMatch=path.match(/^\/api\/orders\/([^/]+)\/renew$/);
      if(req.method==='POST'&&customerRenewMatch){
        const token=url.searchParams.get('token'),original=db.prepare(`SELECT o.*,p.price_irr,s.status subscription_status,s.panel_client_id,s.subscription_url FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.tracking_token=? AND o.order_kind='purchase' AND s.status='active'`).get(customerRenewMatch[1],token);
        if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});const b=await readJson(req);if(!b.receiptReference&&!b.receiptImageUrl)return json(res,400,{error:'RECEIPT_REQUIRED'});
        const id=randomUUID(),trackingToken=randomUUID().replace(/-/g,''),now=new Date().toISOString();db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,receipt_reference,receipt_image_url,created_at,tracking_token,location_id,order_kind,parent_order_id) VALUES(?,?,?,?,'under_review',?,?,?,?,?,?,'renewal',?)`).run(id,original.customer_name,original.phone,original.plan_id,b.amountTransferredIrr?Number(b.amountTransferredIrr)*10:original.price_irr,b.receiptReference||null,b.receiptImageUrl||null,now,trackingToken,original.location_id,original.id);
        audit(original.phone,'create','renewal_order',id,{parentOrderId:original.id});await triggerReview(id);return json(res,201,{id,trackingToken,status:'under_review',expectedAmountToman:Math.round(original.price_irr/10)});
      }

      if (req.method === 'GET' && path === '/api/admin/orders') {
        const rows = db.prepare(`SELECT o.*,CAST(o.amount_transferred_irr/10 AS INTEGER) amount_transferred_irr,p.name plan_name,CAST(p.price_irr/10 AS INTEGER) price_irr,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.provision_error,l.name location_name
          FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id ORDER BY o.created_at DESC`).all();
        return json(res, 200, rows.map(row=>exposeSubscription(req,row)));
      }

      const reviewMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/(approve|reject)$/);
      if (req.method === 'POST' && reviewMatch) {
        const [_, id, action] = reviewMatch;
        const order = db.prepare(`SELECT o.*,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(id);
        if (!order) return json(res, 404, { error: 'ORDER_NOT_FOUND' });
        if (order.status !== 'under_review') return json(res, 409, { error: 'ORDER_NOT_REVIEWABLE' });
        const b = await readJson(req), now = new Date().toISOString();
        db.prepare('UPDATE orders SET status=?,review_note=?,reviewed_by=?,reviewed_at=? WHERE id=?')
          .run(action === 'approve' ? 'approved' : 'rejected', b.note || null, b.reviewedBy || 'admin', now, id);
        if (action === 'reject') { audit('admin', 'reject', 'order', id, b); return json(res, 200, { id, status: 'rejected' }); }
        order.status = 'approved';
        const result = await finalizeApprovedOrder(order, { actor: b.reviewedBy || 'admin' });
        if (!result.ok) {
          if (result.code === 'RENEW_FAILED') return json(res, 502, { error: 'RENEW_FAILED' });
          db.prepare("UPDATE orders SET status='under_review',review_note=?,reviewed_at=NULL WHERE id=?").run(result.note || null, id);
          return json(res, 409, { error: result.code });
        }
        return json(res, 200, exposeSubscription(req, result.subscription));
      }

      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      return json(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'BAD_REQUEST', message: e.message });
    }
  };
  handler.sweep = () => sweepPendingOrders(db, agentDeps());
  return handler;
}
