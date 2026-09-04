import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { getWalletStatement, postWalletTransaction, transferWalletBalance } from './wallet.js';
import { accountFromRequest, createSession, hashPassword, verifyPassword } from './auth.js';
import { selectLocationForPlan, selectLocationsForPlan } from './capacity.js';
import { createKeyedRateLimiter, createRequestGuard } from './security.js';
import { enrichSubscription, readPanelStats } from './subscription-stats.js';
import { buildMultiEndpointSubscription, fetchCleanIpSource, fetchSubscriptionText, keepStableRealityRoutes, measureCloudflareEndpoint, measureTcpEndpoint, parseCleanIpList } from './multi-endpoint.js';
import { approveWalletTopup, evaluateOrder, sweepPendingPayments, ingestBankMessage, loadAutoReviewConfig } from './auto-review.js';
import { HTTPSMS_EVENT_TYPE, HttpSmsWebhookError, normalizeHttpSmsOwner, parseHttpSmsEvent, verifyHttpSmsJwt } from './httpsms-webhook.js';
import { BankAgentError, verifyBankAgentRequest } from './nivora-bank-agent.js';
import { extractReceiptFields } from './receipt-ocr.js';
import net from 'node:net';
import { createHash, randomInt, randomBytes, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { sendSms } from './sms.js';
import { createTelegramRecovery } from './telegram-bot.js';
import { createThreeXuiProvisioner } from './providers/three-x-ui.js';
import { createHysteriaTicketService, HysteriaAuthError } from './hysteria-auth.js';
import { claimCustomerDevice as claimDevice, deviceErrorBody, deviceSummary, hashDeviceId, listAccountDevices, readDeviceId, resetAccountDevices, revokeAccountDevice, setDeviceLimitOverride } from './device-bindings.js';
import { deviceRecoveryErrorBody, deviceRecoveryStatus, listDeviceRecoveryRequests, requestDeviceRecovery, resolveDeviceRecovery } from './device-recovery.js';
import { createEmergencyPool, EmergencyPoolError, normalizeEmergencyConfig } from './emergency-pool.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const privatePageHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive'
};

const robotsTxt = `User-agent: *
Allow: /
`;

const readJson = async (req, maxBytes = 6_000_000) => {
  let raw = '', receivedBytes = 0;
  for await (const chunk of req) {
    receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (receivedBytes > maxBytes) throw new Error('BODY_TOO_LARGE');
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
};

const validJpeg = bytes => {
  if(bytes.length<20||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)return false;
  const sof=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  for(let offset=2;offset+3<bytes.length;){
    if(bytes[offset]!==0xff){offset++;continue}
    while(bytes[offset]===0xff)offset++;
    const marker=bytes[offset++];
    if(marker===0xd9||marker===0xda)return false;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(offset+1>=bytes.length)return false;
    const length=bytes.readUInt16BE(offset);
    if(length<2||offset+length>bytes.length)return false;
    if(sof.has(marker))return length>=7&&bytes.readUInt16BE(offset+3)>0&&bytes.readUInt16BE(offset+5)>0;
    offset+=length;
  }
  return false;
};

const receiptType = bytes => {
  if(validJpeg(bytes))return { mimeType:'image/jpeg', extension:'jpg' };
  const pngEnd=Buffer.from([0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]);
  if(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))&&bytes.readUInt32BE(8)===13&&bytes.subarray(12,16).toString('ascii')==='IHDR'&&bytes.subarray(-12).equals(pngEnd))return { mimeType:'image/png', extension:'png' };
  const webpChunk=bytes.length>=30?bytes.subarray(12,16).toString('ascii'):'';
  const webpShape=webpChunk==='VP8X'||webpChunk==='VP8L'&&bytes[20]===0x2f||webpChunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a;
  if(bytes.length>=30&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.subarray(8,12).toString('ascii')==='WEBP'&&webpShape)return { mimeType:'image/webp', extension:'webp' };
  return null;
};

const decodeReceiptBase64 = value => {
  if (typeof value !== 'string' || !value.length || value.length > 5_700_000 || value.length % 4 !== 0) return null;
  const padding=value.endsWith('==')?2:value.endsWith('=')?1:0,content=padding?value.slice(0,-padding):value;
  if(content.includes('=')||/[^A-Za-z0-9+/]/.test(content))return null;
  const bytes=Buffer.from(value,'base64');
  return bytes.toString('base64') === value ? bytes : null;
};

const MAX_PAYMENT_BODY_BYTES = 24 * 1024;
const MAX_PAYMENT_TOMAN = 1_000_000_000;
const MAX_PENDING_PAYMENTS = 5;
const PAYMENT_PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECEIPT_ORPHAN_RETENTION_MS = Math.max(1, Math.min(Number(process.env.RECEIPT_ORPHAN_RETENTION_MINUTES) || 30, 30)) * 60 * 1000;
const MAX_UNLINKED_RECEIPTS = 100;
const MAX_UNLINKED_RECEIPT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_RECEIPTS = 5_000;
const MAX_TOTAL_RECEIPT_BYTES = 1024 * 1024 * 1024;
const LINKED_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RECEIPT_FILENAME = /^[a-f0-9-]{20,80}\.(?:jpg|jpeg|png|webp)$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

class PaymentRequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const paymentString = (value, { field, min = 1, max }) => {
  if (typeof value !== 'string') throw new PaymentRequestError(`INVALID_${field}`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || CONTROL_CHARACTERS.test(normalized))
    throw new PaymentRequestError(`INVALID_${field}`);
  return normalized;
};

const optionalReceiptReference = value => {
  if (value === undefined || value === null || value === '') return null;
  return paymentString(value, { field:'RECEIPT_REFERENCE', min:1, max:100 });
};

const optionalPaymentAmount = (value, { minimum = 1 } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_PAYMENT_TOMAN)
    throw new PaymentRequestError('INVALID_PAYMENT_AMOUNT');
  return value;
};

const receiptCapabilityFromUrl = (value, req) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 600 || CONTROL_CHARACTERS.test(value))
    throw new PaymentRequestError('INVALID_RECEIPT_URL');
  let capability, expectedOrigin;
  try {
    expectedOrigin = new URL(publicOrigin(req));
    capability = new URL(value.trim(), expectedOrigin);
  } catch {
    throw new PaymentRequestError('INVALID_RECEIPT_URL');
  }
  if (capability.origin !== expectedOrigin.origin || capability.hash || [...capability.searchParams.keys()].some(key => key !== 'access'))
    throw new PaymentRequestError('INVALID_RECEIPT_URL');
  const match = capability.pathname.match(/^\/receipts\/([^/]+)$/i), tokens = capability.searchParams.getAll('access');
  if (!match || !RECEIPT_FILENAME.test(match[1]) || tokens.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(tokens[0]))
    throw new PaymentRequestError('INVALID_RECEIPT_URL');
  return { filename:match[1], accessToken:tokens[0], url:`/receipts/${match[1]}?access=${encodeURIComponent(tokens[0])}` };
};

const receiptTokenMatches = (upload, token) => {
  const actual = createHash('sha256').update(token).digest(), expected = Buffer.from(String(upload?.access_token_hash || ''), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const claimReceipt = (db, capability, { entityType, entityId, accountId = null, guest = false }) => {
  if (!capability) return null;
  const upload = db.prepare('SELECT * FROM receipt_uploads WHERE filename=?').get(capability.filename);
  if (!upload || !receiptTokenMatches(upload, capability.accessToken)) throw new PaymentRequestError('RECEIPT_NOT_AVAILABLE', 403);
  if (guest ? upload.account_id !== null : upload.account_id !== accountId) throw new PaymentRequestError('RECEIPT_NOT_AVAILABLE', 403);
  if (upload.linked_entity_type || upload.linked_entity_id) throw new PaymentRequestError('RECEIPT_ALREADY_USED', 409);
  const result = db.prepare(`UPDATE receipt_uploads SET linked_entity_type=?,linked_entity_id=?,linked_at=?
    WHERE filename=? AND linked_entity_type IS NULL AND linked_entity_id IS NULL`).run(entityType, entityId, new Date().toISOString(), capability.filename);
  if (result.changes !== 1) throw new PaymentRequestError('RECEIPT_ALREADY_USED', 409);
  return capability.url;
};

const paymentRequestError = (res, error, fallback = 'INVALID_PAYMENT_REQUEST') => {
  if (error instanceof PaymentRequestError) return json(res, error.status, { error:error.code });
  if (error?.message === 'BODY_TOO_LARGE') return json(res, 413, { error:'PAYMENT_BODY_TOO_LARGE' });
  if (error instanceof SyntaxError) return json(res, 400, { error:'INVALID_JSON' });
  return json(res, 400, { error:fallback });
};

const cleanupOrphanReceiptUploads = async db => {
  const removeFile=async filename=>{try{await unlink(resolve('receipts',filename));return true}catch(error){return error?.code==='ENOENT'}};
  const cutoff = new Date(Date.now() - RECEIPT_ORPHAN_RETENTION_MS).toISOString();
  const stale = db.prepare(`SELECT filename FROM receipt_uploads
    WHERE linked_entity_type IS NULL AND linked_entity_id IS NULL AND created_at<?
    ORDER BY created_at LIMIT 500`).all(cutoff);
  const remove = db.prepare(`DELETE FROM receipt_uploads
    WHERE filename=? AND linked_entity_type IS NULL AND linked_entity_id IS NULL AND created_at<?`);
  for (const row of stale) {
    if(await removeFile(row.filename))remove.run(row.filename,cutoff);
  }
  const linkedCutoff=new Date(Date.now()-LINKED_RECEIPT_RETENTION_MS).toISOString();
  const finalized=db.prepare(`SELECT r.filename FROM receipt_uploads r
    LEFT JOIN orders o ON r.linked_entity_type='order' AND o.id=r.linked_entity_id
    LEFT JOIN wallet_topups t ON r.linked_entity_type='wallet_topup' AND t.id=r.linked_entity_id
    WHERE (r.linked_entity_type='order' AND o.status IN ('approved','rejected') AND COALESCE(o.reviewed_at,o.created_at)<?)
       OR (r.linked_entity_type='wallet_topup' AND t.status IN ('approved','rejected') AND COALESCE(t.reviewed_at,t.created_at)<?)
    ORDER BY r.linked_at LIMIT 500`).all(linkedCutoff,linkedCutoff);
  const removeFinalized=db.prepare('DELETE FROM receipt_uploads WHERE filename=? AND linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL');
  for(const row of finalized){
    if(await removeFile(row.filename))removeFinalized.run(row.filename);
  }
};

const planFromRow = row => row && ({
  id: row.id, name: row.name, description: row.description,
  priceIrr: Math.round(row.price_irr / 10), trafficGb: row.traffic_gb,
  durationDays: row.duration_days, deviceLimit: row.device_limit,
  locationMode: row.location_mode === 'multi' ? 'multi' : 'single',
  bundleSize: row.location_mode === 'multi' ? Math.max(2, Number(row.bundle_size) || 3) : 1,
  sortOrder: row.sort_order, active: Boolean(row.active),
  locations: row.locations ? row.locations.split('|').map(x => { const [id,name,countryCode,city,flagEmoji] = x.split('~'); return {id,name,countryCode,city,flagEmoji:flagEmoji||''}; }) : [],
  createdAt: row.created_at, updatedAt: row.updated_at
});

function validPlan(body) {
  const required = ['name', 'priceIrr', 'trafficGb', 'durationDays', 'deviceLimit'];
  const locationMode = body.locationMode || 'single';
  const bundleSize = body.bundleSize === undefined ? (locationMode === 'multi' ? 3 : 1) : Number(body.bundleSize);
  return required.every(k => body[k] !== undefined) && body.name.trim() &&
    [body.priceIrr, body.trafficGb, body.durationDays, body.deviceLimit].every(Number.isInteger) &&
    body.priceIrr >= 0 && body.trafficGb > 0 && body.durationDays > 0 && body.deviceLimit > 0 &&
    ['single','multi'].includes(locationMode) && Number.isInteger(bundleSize) &&
    (locationMode === 'single' ? bundleSize === 1 : bundleSize >= 2 && bundleSize <= 10);
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
const exposeSubscription = (req, row) => {
  if (!row) return row;
  const sequence = Number(row.location_sequence || 0);
  const locationName = row.location_name && sequence > 0 ? `${row.location_name} ${sequence.toLocaleString('fa-IR')}` : row.location_name;
  return {
    ...row,
    location_name: locationName,
    subscription_label: locationName || row.plan_name || null,
    subscription_url: publicSubscriptionUrl(req, row.subscription_access_token || row.access_token, row.subscription_url)
  };
};

const locationSequenceSql = `CASE WHEN o.order_kind='purchase' AND o.location_id IS NOT NULL THEN (
  SELECT COUNT(*) FROM orders previous
  WHERE previous.order_kind='purchase' AND previous.location_id=o.location_id
    AND (
      (o.account_id IS NOT NULL AND previous.account_id=o.account_id) OR
      (o.account_id IS NULL AND o.reseller_id IS NOT NULL AND previous.account_id IS NULL AND previous.reseller_id=o.reseller_id AND COALESCE(previous.reseller_customer_id,previous.phone)=COALESCE(o.reseller_customer_id,o.phone)) OR
      (o.account_id IS NULL AND o.reseller_id IS NULL AND previous.account_id IS NULL AND previous.reseller_id IS NULL AND previous.phone=o.phone)
    )
    AND (previous.created_at<o.created_at OR (previous.created_at=o.created_at AND previous.id<=o.id))
) END`;

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

export function createApp(db, { adminToken = process.env.ADMIN_TOKEN || 'dev-only-change-me', adminUsername = process.env.ADMIN_USERNAME || '', adminPasswordSalt = process.env.ADMIN_PASSWORD_SALT || '', adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '', provisioner = null, neuralMeshManifest = null, emergencyPool: suppliedEmergencyPool = null, enforceDeviceGateway = process.env.ENFORCE_DEVICE_GATEWAY === 'true', hysteriaTicketSecret = process.env.HYSTERIA2_TICKET_SECRET || '', hysteriaTicketTtlSeconds = process.env.HYSTERIA2_TICKET_TTL_SECONDS || 45, hysteriaResumeSeconds = process.env.HYSTERIA2_RESUME_SECONDS || 43_200, hysteriaStatsMaxAgeSeconds = process.env.HYSTERIA2_STATS_MAX_AGE_SECONDS || 180, panelStatsReader = readPanelStats } = {}) {
  // 3x-ui subscription rendering is deterministic but its HTTPS endpoint can
  // be slow. Keep a short-lived in-memory copy so cold devices do not queue on
  // the panel; server-side client expiry/traffic enforcement remains intact.
  const upstreamSubscriptionCache=new Map();
  const cachedUpstream=async(upstream,options)=>{
    const key=`${upstream}|${options.rejectUnauthorized}`;
    const cached=upstreamSubscriptionCache.get(key);
    if(cached&&Date.now()-cached.at<60_000)return cached.raw;
    const raw=await fetchSubscriptionText(upstream,options);
    upstreamSubscriptionCache.set(key,{raw,at:Date.now()});
    if(upstreamSubscriptionCache.size>500){
      const oldest=[...upstreamSubscriptionCache.entries()].sort((a,b)=>a[1].at-b[1].at).slice(0,100);
      oldest.forEach(([cacheKey])=>upstreamSubscriptionCache.delete(cacheKey));
    }
    return raw;
  };
  const renderSubscriptionBundle=async subscription=>{
    const upstream=subscription.upstream_subscription_url||subscription.subscription_url;
    if(!upstream){const error=new Error('SUBSCRIPTION_NOT_READY');error.status=404;throw error;}
    const endpoints=subscription.location_id?db.prepare(`SELECT label,host,port,mode,server_name,priority,active FROM location_endpoints WHERE location_id=? AND active=1 ORDER BY priority,created_at`).all(subscription.location_id):[];
    // A separately registered x-ui node can legitimately use a self-signed
    // listener. The public Nivora endpoint remains TLS-protected.
    const rejectUnauthorized=subscription.panel_node_id?false:process.env.PANEL_TLS_REJECT_UNAUTHORIZED!=='false';
    const raw=await cachedUpstream(upstream,{rejectUnauthorized});
    // Experimental transports stay out of customer profiles. Only routes that
    // passed the production Reality+Vision policy are offered to clients.
    const productionRaw=keepStableRealityRoutes(raw);
    const rendered=buildMultiEndpointSubscription(productionRaw,endpoints.map(endpoint=>({...endpoint,active:Boolean(endpoint.active)})));
    return {rendered,endpoints};
  };
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
  const deviceHash = req => hashDeviceId(readDeviceId(req));
  const claimCustomerDevice = (account, req, options) => claimDevice(db,account,req,options);
  const codeHash = code => createHash('sha256').update(String(code)).digest('hex');
  const settingGet=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
  const settingSet=(key,value)=>db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(value),new Date().toISOString());
  const settingsKey=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||adminToken).digest();
  const encrypt=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',settingsKey,iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`};
  const decrypt=value=>{try{const [a,b,c]=value.split('.'),iv=Buffer.from(a,'base64url'),dec=createDecipheriv('aes-256-gcm',settingsKey,iv);dec.setAuthTag(Buffer.from(b,'base64url'));return Buffer.concat([dec.update(Buffer.from(c,'base64url')),dec.final()]).toString('utf8')}catch{return ''}};
  const emergencyConfig=()=>normalizeEmergencyConfig({
    enabled:settingGet('emergency_enabled')==='true',
    sources:(()=>{try{return JSON.parse(settingGet('emergency_sources')||'[]')}catch{return []}})(),
    maxNodes:Number(settingGet('emergency_max_nodes')||8),
    refreshMinutes:Number(settingGet('emergency_refresh_minutes')||30)
  });
  const emergencyPool=suppliedEmergencyPool||createEmergencyPool({
    getConfig:emergencyConfig,
    readCache:()=>decrypt(settingGet('emergency_cache')||''),
    writeCache:value=>settingSet('emergency_cache',encrypt(value))
  });
  const emergencyStatsMaxAgeMs=Math.max(30,Number(hysteriaStatsMaxAgeSeconds)||180)*1000;
  const hasEmergencyEntitlement=async(accountId,suppliedStats=null)=>{
    const rows=db.prepare(`SELECT s.panel_client_id,s.activated_at,s.hysteria_started_at,s.hysteria_expires_at,s.hysteria_traffic_limit_bytes,s.hysteria_used_bytes,p.traffic_gb
      FROM orders o JOIN subscriptions s ON s.order_id=o.id JOIN plans p ON p.id=o.plan_id
      WHERE o.account_id=? AND o.order_kind='purchase' AND o.status='approved' AND s.status='active' AND COALESCE(s.control_status,'active')='active'`).all(accountId);
    if(!rows.length)return false;
    let stats=suppliedStats;try{if(!stats)stats=await panelStatsReader()||{};}catch{stats={}}
    const clock=Date.now();
    return rows.some(row=>{
      const panel=stats[row.panel_client_id];
      const panelKnown=Boolean(panel);
      const panelTotal=Number(panel?.totalBytes||0);
      const panelUsed=Number(panel?.upBytes||0)+Number(panel?.downBytes||0);
      const panelExpiry=Number(panel?.expiryTime||0);
      const panelSyncedAt=Number(panel?.syncedAt||0),panelFresh=panelKnown&&panelSyncedAt>0&&panelSyncedAt<=clock+60_000&&clock-panelSyncedAt<=emergencyStatsMaxAgeMs;
      const hysteriaKnown=Boolean(row.hysteria_started_at||row.hysteria_expires_at||Number(row.hysteria_traffic_limit_bytes||0)>0||Number(row.hysteria_used_bytes||0)>0);
      const hysteriaExpiry=row.hysteria_expires_at?Date.parse(row.hysteria_expires_at):0;
      const hysteriaLimit=Number(row.hysteria_traffic_limit_bytes||0),hysteriaUsed=Number(row.hysteria_used_bytes||0);
      // Match hysteria-auth.js exactly: panel traffic and external Hysteria
      // traffic share the panel-reported allowance. Count each source once;
      // the Hysteria-only limit remains a separate guard below.
      const combinedUsed=panelUsed+hysteriaUsed;
      const panelDenied=panelKnown&&(panel.enabled===false||(panelExpiry>0&&panelExpiry<=clock)||(panelTotal>0&&combinedUsed>=panelTotal));
      const panelAuthoritativeDenied=panelFresh&&panelDenied;
      const panelEligible=panelFresh&&!panelDenied;
      const hysteriaDenied=hysteriaKnown&&((row.hysteria_expires_at&&(!Number.isFinite(hysteriaExpiry)||hysteriaExpiry<=clock))||(hysteriaLimit>0&&hysteriaUsed>=hysteriaLimit));
      const hysteriaEligible=hysteriaKnown&&!hysteriaDenied;
      const activatedAt=Date.parse(row.activated_at||'');
      const newlyProvisioned=Number.isFinite(activatedAt)&&activatedAt<=clock+60_000&&clock-activatedAt<=15*60_000;
      // Fresh panel telemetry is the authoritative billing state. An older
      // Hysteria window must never revive a panel-disabled, expired or exhausted
      // subscription. Stale panel data is not authoritative and follows the
      // existing Hysteria/provisioning fallback policy below.
      if(panelAuthoritativeDenied)return false;
      if(panelEligible||hysteriaEligible)return true;
      if(panelDenied||hysteriaDenied)return false;
      return newlyProvisioned;
    });
  };
  const telegramConfig=()=>({enabled:settingGet('telegram_enabled')==='true',token:decrypt(settingGet('telegram_token')||'')||process.env.TELEGRAM_BOT_TOKEN,secret:decrypt(settingGet('telegram_secret')||'')||process.env.TELEGRAM_WEBHOOK_SECRET,username:settingGet('telegram_username')||'',channel:settingGet('telegram_channel')||'',latestReleaseUrl:settingGet('telegram_latest_release_url')||'',adminUrl:`${String(process.env.PUBLIC_BASE_URL||'https://b.nivorali.com').replace(/\/$/,'')}/admin`,adminIds:(settingGet('telegram_admin_ids')||'').split(',').map(x=>x.trim()).filter(Boolean),groupIds:(settingGet('telegram_group_ids')||'').split(',').map(x=>x.trim()).filter(Boolean),groupAiEnabled:settingGet('telegram_group_ai_enabled')==='true',groupAutoReply:settingGet('telegram_group_auto_reply')==='true',publicContext:settingGet('telegram_public_context')||''});
  const telegramAdminAlert=async(text,replyMarkup)=>{const c=telegramConfig();if(!c.enabled||!c.token||!c.adminIds.length)return;await Promise.allSettled(c.adminIds.map(chat=>fetch(`https://api.telegram.org/bot${c.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text,...(replyMarkup?{reply_markup:replyMarkup}:{})})})));};
  const aiConfig=()=>({enabled:settingGet('ai_enabled')==='true',token:decrypt(settingGet('ai_hetzner_token')||'')||process.env.HETZNER_INFERENCE_TOKEN||'',model:settingGet('ai_model')||'Qwen/Qwen3.6-35B-A3B-FP8',baseUrl:'https://inference.hetzner.com/api/v1'});
  const redactForAi=value=>String(value||'').replace(/(?:vless|vmess|trojan|ss|hysteria2):\/\/\S+/gi,'[لینک اشتراک حذف شد]').replace(/https?:\/\/\S+/gi,'[نشانی حذف شد]').replace(/\b(?:\+?98|0)?9\d{9}\b/g,'[شماره حذف شد]').replace(/\b[a-f0-9]{24,}\b/gi,'[شناسه محرمانه حذف شد]').replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[کلید حذف شد]').slice(0,7000);
  const aiCompletion=async({system,user,maxTokens=500})=>{const c=aiConfig();if(!c.enabled||!c.token){const error=new Error('AI_NOT_CONFIGURED');error.status=400;throw error;}const response=await fetch(`${c.baseUrl}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${c.token}`,'content-type':'application/json'},body:JSON.stringify({model:c.model,messages:[{role:'system',content:system},{role:'user',content:redactForAi(user)}],temperature:.25,max_tokens:maxTokens,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(30000)}),data=await response.json().catch(()=>({}));if(!response.ok){const code=response.status===429?'AI_RATE_LIMITED':response.status===401?'INVALID_AI_TOKEN':response.status===503?'AI_PROVIDER_UNAVAILABLE':'AI_PROVIDER_ERROR',error=new Error(code);error.status=response.status===429?429:response.status===503?503:502;throw error;}const text=String(data?.choices?.[0]?.message?.content||'').trim();if(!text){const error=new Error('AI_EMPTY_RESPONSE');error.status=502;throw error;}return text.slice(0,2000);};
  const operationsStats=()=>db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE role='customer') customers,(SELECT COUNT(*) FROM accounts WHERE role='customer' AND status='active') active_customers,(SELECT COUNT(*) FROM accounts WHERE role='reseller' AND status='active') active_resellers,(SELECT COUNT(*) FROM orders WHERE status='under_review') pending_orders,(SELECT COUNT(*) FROM wallet_topups WHERE status='under_review') pending_topups,(SELECT COUNT(*) FROM support_tickets WHERE status<>'closed') open_tickets,(SELECT COUNT(*) FROM subscriptions WHERE status='active') active_subscriptions,(SELECT COUNT(*) FROM subscriptions WHERE status='failed' AND created_at>=datetime('now','-1 day')) failed_subscriptions_24h,(SELECT COALESCE(SUM(amount_toman),0) FROM reseller_debts WHERE status IN ('open','payment_reported')) open_debt_toman`).get();
  const aiOperationsSummary=()=>aiCompletion({system:'شما دستیار تحلیل عملیات Nivora هستید. فقط بر اساس آمار تجمیعی داده‌شده، یک گزارش کوتاه فارسی شامل وضعیت، اولویت‌های امروز و هشدارها بنویسید. چیزی را حدس نزنید، اقدام خودکار یا وعده قطعی پیشنهاد نکنید و حداکثر ۸ خط بنویسید.',user:JSON.stringify(operationsStats()),maxTokens:500});
  const aiPublicAnswer=question=>aiCompletion({system:'شما دستیار عمومی فارسی Nivora در گروه تلگرام هستید. فقط درباره معرفی سرویس، نصب برنامه، خرید، اتصال و راه‌های تماس پاسخ کوتاه و محترمانه بدهید. از اطلاعات زمینه عمومی فراتر نروید؛ قیمت یا وضعیت لحظه‌ای را حدس نزنید. هرگز رمز، شماره، لینک اشتراک، توکن، IP، دامنه فنی یا اطلاعات حساب را درخواست یا افشا نکنید. برای پرداخت، بازیابی رمز، مشکل حساب یا موضوع نامطمئن، کاربر را به گفت‌وگوی خصوصی ربات و پشتیبان انسانی هدایت کنید. از ادعای سرعت یا تضمین قطعی پرهیز کنید. حداکثر ۶ خط.',user:`اطلاعات عمومی تأییدشده مدیر: ${telegramConfig().publicContext||'اطلاعات تکمیلی ثبت نشده است.'}\nپرسش عمومی: ${question}`,maxTokens:420});
  const telegramRecovery=createTelegramRecovery(db,{getConfig:telegramConfig,aiOperationsSummary,aiPublicAnswer});
  const settingOrEnv=(settingKey,envKey,fallback='')=>settingGet(settingKey)??process.env[envKey]??fallback;
  const autoReviewConfig=()=>loadAutoReviewConfig({
    ...process.env,
    AUTO_REVIEW_ENABLED:settingOrEnv('auto_review_enabled','AUTO_REVIEW_ENABLED','false'),
    AUTO_REVIEW_ALLOW_AMOUNT_ONLY:settingOrEnv('auto_review_allow_amount_only','AUTO_REVIEW_ALLOW_AMOUNT_ONLY','false'),
    AUTO_REVIEW_TRUSTED_AGENT_ONLY:settingOrEnv('auto_review_trusted_agent_only','AUTO_REVIEW_TRUSTED_AGENT_ONLY','true'),
    AUTO_REVIEW_AMOUNT_TOLERANCE_RIAL:settingOrEnv('auto_review_amount_tolerance_rial','AUTO_REVIEW_AMOUNT_TOLERANCE_RIAL','0'),
    AUTO_REVIEW_LOOKBACK_HOURS:settingOrEnv('auto_review_lookback_hours','AUTO_REVIEW_LOOKBACK_HOURS','2'),
    BANK_SMS_DEFAULT_UNIT:settingOrEnv('bank_sms_default_unit','BANK_SMS_DEFAULT_UNIT','rial'),
    RECEIPT_OCR_ENABLED:settingOrEnv('receipt_ocr_enabled','RECEIPT_OCR_ENABLED','false')
  });
  const httpsmsConfig=req=>{
    let allowedSenders=[],rawSenders=settingGet('httpsms_allowed_senders')??process.env.HTTPSMS_ALLOWED_SENDERS??'[]';
    try{allowedSenders=JSON.parse(rawSenders);}catch{allowedSenders=String(rawSenders).split(',');}
    return {
      enabled:settingOrEnv('httpsms_enabled','HTTPSMS_ENABLED','false')==='true',
      signingKey:decrypt(settingGet('httpsms_signing_key')||'')||process.env.HTTPSMS_SIGNING_KEY||'',
      issuer:settingOrEnv('httpsms_issuer','HTTPSMS_ISSUER','api.httpsms.com'),
      expectedSubject:settingOrEnv('httpsms_expected_subject','HTTPSMS_EXPECTED_SUBJECT',''),
      expectedOwner:settingOrEnv('httpsms_expected_owner','HTTPSMS_EXPECTED_OWNER',''),
      expectedSim:settingOrEnv('httpsms_expected_sim','HTTPSMS_EXPECTED_SIM','').toUpperCase(),
      allowedSenders:Array.isArray(allowedSenders)?allowedSenders.map(x=>String(x).trim().toLowerCase()).filter(Boolean):[],
      webhookUrl:`${publicOrigin(req)}/api/webhooks/httpsms`
    };
  };
  const bankAgentConfig=req=>{
    let allowedSenders=[];try{allowedSenders=JSON.parse(settingGet('bank_agent_allowed_senders')||'[]')}catch{}
    return {enabled:settingGet('bank_agent_enabled')==='true',agentId:settingGet('bank_agent_id')||'',secret:decrypt(settingGet('bank_agent_secret')||''),allowedSenders:Array.isArray(allowedSenders)?allowedSenders.map(x=>String(x).trim().toLowerCase()).filter(Boolean):[],webhookUrl:`${publicOrigin(req)}/api/webhooks/nivora-bank-agent`};
  };
  const nodeProvisioners = new Map();
  const provisionerForLocation = location => {
    if (!location?.panel_node_id) return provisioner;
    const node = db.prepare('SELECT * FROM panel_nodes WHERE id=? AND active=1').get(location.panel_node_id);
    const apiToken = node && decrypt(node.api_token_encrypted);
    if (!node || !apiToken || !node.subscription_base_url) return null;
    const fingerprint = [node.id,node.base_url,node.subscription_base_url,node.vision_inbound_ids,node.cdn_inbound_ids,node.hysteria_inbound_ids,node.panel_inbound_id,location.panel_inbound_id,location.panel_cdn_inbound_id].join('|');
    if (!nodeProvisioners.has(fingerprint)) nodeProvisioners.set(fingerprint, createThreeXuiProvisioner({
      baseUrl: node.base_url,
      apiToken,
      inboundId: location.panel_inbound_id,
      visionInboundIds: node.vision_inbound_ids,
      cdnInboundIds: node.cdn_inbound_ids || (location.panel_cdn_inbound_id ? String(location.panel_cdn_inbound_id) : ''),
      hysteriaInboundIds: node.hysteria_inbound_ids,
      subscriptionBaseUrl: node.subscription_base_url,
      rejectUnauthorized: false,
      disableIpLimit: true
    }));
    return nodeProvisioners.get(fingerprint);
  };
  const guard=createRequestGuard();
  const guestReceiptLimiter=createKeyedRateLimiter({limit:8,windowMs:60*60_000});
  const accountReceiptLimiter=createKeyedRateLimiter({limit:12,windowMs:60*60_000});
  const requestIp=req=>String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  const emergencyFailureIpLimiter=createKeyedRateLimiter({limit:300,windowMs:60_000});
  const emergencySubscriptionAccountLimiter=createKeyedRateLimiter({limit:20,windowMs:60_000});
  const emergencySubscriptionDeviceLimiter=createKeyedRateLimiter({limit:10,windowMs:60_000});
  const emergencyLeaseAccountLimiter=createKeyedRateLimiter({limit:60,windowMs:60_000});
  const emergencyLeaseDeviceLimiter=createKeyedRateLimiter({limit:30,windowMs:60_000});
  const hysteriaTickets=createHysteriaTicketService(db,{
    secret:hysteriaTicketSecret,
    ttlSeconds:hysteriaTicketTtlSeconds,
    resumeSeconds:hysteriaResumeSeconds,
    statsMaxAgeSeconds:hysteriaStatsMaxAgeSeconds,
    statsReader:panelStatsReader
  });
  const subscriptionRow = id => db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
  const purchaseLocationsForPlan=plan=>{
    const planId=plan.plan_id||plan.id;
    if(plan.location_mode==='multi')return selectLocationsForPlan(db,planId,Math.max(2,Number(plan.bundle_size)||3));
    const location=selectLocationForPlan(db,planId);return location?[location]:null;
  };
  const provisionPurchaseEntries=async(plan,entries)=>{
    const provisioned=[];
    try{
      for(const entry of entries){
        const order={id:entry.id,phone:entry.phone,plan_name:plan.name,traffic_gb:plan.traffic_gb,duration_days:plan.duration_days,device_limit:plan.device_limit,panel_inbound_id:entry.location.panel_inbound_id,panel_cdn_inbound_id:entry.location.panel_cdn_inbound_id,location_name:entry.location.name};
        const selectedProvisioner=provisionerForLocation(entry.location);
        if(!selectedProvisioner)throw new Error('LOCATION_PROVISIONER_NOT_CONFIGURED');
        const result=await selectedProvisioner(order);
        db.prepare(`UPDATE subscriptions SET status='active',panel_client_id=?,subscription_url=?,upstream_subscription_url=?,activated_at=? WHERE id=?`).run(result.panelClientId,result.subscriptionUrl,result.subscriptionUrl,new Date().toISOString(),entry.subscriptionId);
        provisioned.push({...entry,panelClientId:result.panelClientId,upstreamUrl:result.subscriptionUrl,selectedProvisioner});
      }
      return {ok:true,items:provisioned};
    }catch(error){
      const message=String(error?.message||error);
      db.prepare(`UPDATE subscriptions SET status='failed',provision_error=? WHERE id IN (${entries.map(()=>'?').join(',')})`).run(message,...entries.map(entry=>entry.subscriptionId));
      for(const item of provisioned.reverse())try{if(item.selectedProvisioner?.remove)await item.selectedProvisioner.remove({panelClientId:item.panelClientId})}catch{}
      return {ok:false,error:message};
    }
  };

  // Shared approval → provisioning path used by both the admin review routes and the
  // auto-review agent. The order's status must already be set to 'approved'.
  async function finalizeApprovedOrder(order, { actor = 'admin' } = {}) {
    const now = new Date().toISOString();
    const subscriptionId = randomUUID();
    if (order.order_kind === 'renewal') {
      const parent = db.prepare(`SELECT s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM subscriptions s WHERE s.order_id=? AND s.status='active'`).get(order.parent_order_id);
      const renewalLocation = db.prepare('SELECT * FROM service_locations WHERE id=?').get(order.location_id);
      const renewalProvisioner = provisionerForLocation(renewalLocation);
      if (!parent || !renewalProvisioner?.renew) return { ok: false, code: 'RENEW_TARGET_UNAVAILABLE', note: 'Renewal target unavailable' };
      db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(subscriptionId, order.id, parent.panel_client_id, parent.subscription_url, parent.upstream_subscription_url || parent.subscription_url, now);
      audit(actor, 'approve', 'renewal_order', order.id);
      try {
        await renewalProvisioner.renew({ panelClientId: parent.panel_client_id, addDays: order.duration_days, addTrafficGb: order.traffic_gb });
        db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(), subscriptionId);
        const row = subscriptionRow(subscriptionId); row.subscription_access_token = parent.subscription_access_token;
        return { ok: true, subscription: row };
      } catch (e) {
        db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message || e), subscriptionId);
        return { ok: false, code: 'RENEW_FAILED' };
      }
    }
    if(order.location_mode==='multi'&&!order.bundle_id){
      const locations=purchaseLocationsForPlan(order);
      if(!locations)return {ok:false,code:'NO_CAPACITY',note:`At least ${Number(order.bundle_size)||3} active locations are required`};
      const bundleId=randomUUID(),entries=locations.map((location,index)=>({id:index===0?order.id:randomUUID(),subscriptionId:randomUUID(),accessToken:subscriptionToken(),trackingToken:index===0?order.tracking_token:randomUUID().replace(/-/g,''),location,phone:order.phone,index:index+1}));
      try{
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE orders SET location_id=?,bundle_id=?,bundle_index=1,bundle_size=? WHERE id=?').run(locations[0].id,bundleId,entries.length,order.id);
        for(const entry of entries){
          if(entry.index>1)db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,account_id,reseller_id,location_id,order_kind,reseller_customer_id,reseller_sale_price_toman,bundle_id,bundle_index,bundle_size,review_note,reviewed_by,reviewed_at) VALUES(?,?,?,?,'approved',0,?,?,?,?,?,'purchase',?,?,?, ?,?,?,?,?)`).run(entry.id,order.customer_name,order.phone,order.plan_id,order.created_at,entry.trackingToken,order.account_id||null,order.reseller_id||null,entry.location.id,order.reseller_customer_id||null,0,bundleId,entry.index,entries.length,order.review_note||null,order.reviewed_by||actor,order.reviewed_at||now);
          db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(entry.subscriptionId,entry.id,entry.accessToken,now);
        }
        db.exec('COMMIT');
      }catch(error){try{db.exec('ROLLBACK')}catch{}return {ok:false,code:'BUNDLE_CREATE_FAILED',note:String(error?.message||error)};}
      const provisioned=await provisionPurchaseEntries(order,entries);
      if(!provisioned.ok){
        db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM subscriptions WHERE order_id IN (SELECT id FROM orders WHERE bundle_id=?)').run(bundleId);db.prepare('DELETE FROM orders WHERE bundle_id=? AND id<>?').run(bundleId,order.id);db.prepare('UPDATE orders SET location_id=NULL,bundle_id=NULL,bundle_index=NULL,bundle_size=NULL WHERE id=?').run(order.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');}
        return {ok:false,code:'PROVISION_FAILED',note:provisioned.error};
      }
      audit(actor,'approve','order_bundle',bundleId,{orderId:order.id,subscriptionCount:entries.length});
      const first=subscriptionRow(entries[0].subscriptionId);first.subscription_access_token=entries[0].accessToken;first.bundle_id=bundleId;first.bundle_size=entries.length;
      return {ok:true,subscription:first,subscriptions:provisioned.items};
    }
    const location = order.location_id ? db.prepare('SELECT * FROM service_locations WHERE id=? AND active=1').get(order.location_id) : selectLocationForPlan(db, order.plan_id);
    if (!location) return { ok: false, code: 'NO_CAPACITY', note: 'No server capacity' };
    db.prepare('UPDATE orders SET location_id=? WHERE id=?').run(location.id, order.id);
    order.location_id = location.id; order.location_name = location.name; order.panel_inbound_id = location.panel_inbound_id; order.panel_cdn_inbound_id = location.panel_cdn_inbound_id;
    const accessToken = subscriptionToken();
    db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(subscriptionId, order.id, accessToken, now);
    audit(actor, 'approve', 'order', order.id);
    const selectedProvisioner = provisionerForLocation(location);
    if (selectedProvisioner) {
      try {
        const result = await selectedProvisioner(order);
        db.prepare(`UPDATE subscriptions SET status='active',panel_client_id=?,subscription_url=?,upstream_subscription_url=?,activated_at=? WHERE id=?`).run(result.panelClientId, result.subscriptionUrl, result.subscriptionUrl, new Date().toISOString(), subscriptionId);
      } catch (e) {
        db.prepare(`UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?`).run(String(e.message || e), subscriptionId);
      }
    }
    return { ok: true, subscription: subscriptionRow(subscriptionId) };
  }

  // Load an approved order with the plan fields the provisioner needs, then provision it.
  async function provisionApprovedById(orderId, actor = 'agent') {
    const order = db.prepare(`SELECT o.*,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,p.location_mode,p.bundle_size FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(orderId);
    if (!order) return { ok: false, code: 'ORDER_NOT_FOUND' };
    return finalizeApprovedOrder(order, { actor });
  }
  const agentDeps = () => {
    const config=autoReviewConfig();
    return {
      config,
      provisionApproved:id=>provisionApprovedById(id,'agent'),
      ocrExtract:config.ocrEnabled?(imageUrl=>extractReceiptFields(imageUrl)):null,
      actor:'httpsms-agent',
      onApproved:topup=>{
        notify(topup.account_id,'شارژ کیف پول تأیید شد',`${Number(topup.amount_toman).toLocaleString('fa-IR')} تومان به کیف پول شما افزوده شد.`);
        audit('httpsms-agent','approve','wallet_topup',topup.id,{amountToman:topup.amount_toman});
      },
      onRejected:item=>{
        if(item.account_id)notify(item.account_id,'پرداخت تأیید نشد','در مهلت بررسی، پیامک واریز معتبر و مطابق با مبلغ واردشده دریافت نشد. در صورت کسر وجه با پشتیبانی تماس بگیرید.');
        audit('httpsms-agent','reject',item.amount_toman!=null?'wallet_topup':'order',item.id,{reason:'BANK_MATCH_TIMEOUT'});
        telegramAdminAlert(`⏱ پرداخت پس از پایان مهلت رد شد\nشناسه: ${item.id}`);
      },
      onManual:item=>{
        if(item.account_id)notify(item.account_id,'پرداخت در صف بررسی مدیر است','تطبیق خودکار کامل نشد؛ نتیجه پس از بررسی مدیر اعلام می‌شود.');
        const isTopup=item.entityType==='wallet_topup';
        const title=isTopup?'شارژ کیف پول':'خرید اشتراک';
        const buttons=isTopup?{inline_keyboard:[[{text:'✅ تأیید و شارژ',callback_data:`topup:approve:${item.id}`},{text:'❌ رد',callback_data:`topup:reject:${item.id}`}]]}:undefined;
        telegramAdminAlert(`⚠️ ${title} نیازمند بررسی دستی\nشناسه: ${item.id}\nدلیل: ${item.reason}`,buttons);
      }
    };
  };
  const schedulePaymentSweep=()=>setImmediate(()=>Promise.resolve(handler.sweep()).catch(error=>console.error(JSON.stringify({time:new Date().toISOString(),event:'payment_sweep_error',message:String(error?.message||error)}))));
  const triggerReview = orderId => {
    const config=autoReviewConfig();
    return config.enabled?evaluateOrder(db,orderId,{...agentDeps(),config}).catch(()=>{}):Promise.resolve();
  };

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
      if(req.method==='GET'&&path==='/api/connectivity/204'){
        res.writeHead(204,{'cache-control':'no-store','x-nivora-probe':'1'});return res.end();
      }
      if(req.method==='GET'&&path==='/api/connectivity/payload'){
        const size=Math.max(1024,Math.min(Number(url.searchParams.get('bytes'))||65536,262144));
        const payload=Buffer.alloc(size,0x4e);
        res.writeHead(200,{'content-type':'application/octet-stream','content-length':payload.length,'cache-control':'no-store','x-nivora-probe':'1'});return res.end(payload);
      }
      if(req.method==='GET'&&path==='/api/app-release/android'){
        const audience=url.searchParams.get('audience')==='partner'?'partner':'customer';
        const prefix=`android_${audience}_`;
        return json(res,200,{audience,versionCode:Number(settingGet(`${prefix}version_code`)||0),versionName:settingGet(`${prefix}version_name`)||'',downloadUrl:settingGet(`${prefix}download_url`)||'',releaseNotes:settingGet(`${prefix}release_notes`)||'',forceUpdate:settingGet(`${prefix}force_update`)==='true',publishedAt:settingGet(`${prefix}published_at`)||null});
      }
      const hysteriaNodeAuth=path.match(/^\/internal\/v1\/hysteria\/auth\/([A-Za-z0-9_.-]{2,80})$/);
      if(req.method==='POST'&&hysteriaNodeAuth){
        const nodeSecret=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]||'';
        const body=await readJson(req);
        try{
          const result=await hysteriaTickets.authenticate({routeId:hysteriaNodeAuth[1],nodeSecret,token:String(body.auth||'')});
          return json(res,200,result);
        }catch(error){
          if(error instanceof HysteriaAuthError){
            if(error.code==='INVALID_NODE_CREDENTIALS'||error.code==='HYSTERIA2_NOT_CONFIGURED')return json(res,error.status,{error:error.code});
            return json(res,200,{ok:false,id:''});
          }
          throw error;
        }
      }
      const hysteriaNodeUsage=path.match(/^\/internal\/v1\/hysteria\/usage\/([A-Za-z0-9_.-]{2,80})$/);
      if(req.method==='POST'&&hysteriaNodeUsage){
        const nodeSecret=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]||'';
        const body=await readJson(req);
        try{return json(res,200,hysteriaTickets.recordUsage({routeId:hysteriaNodeUsage[1],nodeSecret,clients:body.clients}));}
        catch(error){if(error instanceof HysteriaAuthError)return json(res,error.status,{error:error.code});throw error;}
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
        const html = await readFile(resolve('public/landing.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (req.method === 'GET' && (path === '/store' || path === '/store/')) {
        const html = await readFile(resolve('public/index.html'));
        res.writeHead(200, privatePageHeaders); return res.end(html);
      }
      if (req.method === 'GET' && path === '/landing.css') {
        const css = await readFile(resolve('public/landing.css'));
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(css);
      }
      if (req.method === 'GET' && path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
        return res.end(robotsTxt);
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
        const upload=db.prepare('SELECT * FROM receipt_uploads WHERE filename=?').get(receiptFile[1]);
        if(!upload)return json(res,404,{error:'RECEIPT_NOT_FOUND'});
        const supplied=String(url.searchParams.get('access')||''),account=accountFromRequest(db,req),owner=account?.id===upload.account_id;
        const hasAccess=Boolean(supplied)&&receiptTokenMatches(upload,supplied);
        if(!isAdmin(req)&&!owner&&!hasAccess)return json(res,403,{error:'RECEIPT_ACCESS_DENIED'});
        let file;try{file=await readFile(resolve('receipts', receiptFile[1]));}catch(error){if(error?.code==='ENOENT')return json(res,404,{error:'RECEIPT_NOT_FOUND'});throw error;}
        const type = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[extname(receiptFile[1]).toLowerCase()];
        res.writeHead(200, { 'content-type':type, 'cache-control':'private, max-age=3600', 'x-content-type-options':'nosniff', 'x-robots-tag':'noindex, nofollow, noarchive' }); return res.end(file);
      }
      if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
        const html = await readFile(resolve('public/admin.html'));
        res.writeHead(200, privatePageHeaders); return res.end(html);
      }
      if (req.method === 'GET' && (path === '/reseller' || path === '/reseller/')) {
        const html=await readFile(resolve('public/reseller.html'));res.writeHead(200,privatePageHeaders);return res.end(html);
      }
      if(req.method==='GET'&&(path==='/account'||path==='/account/')){const html=await readFile(resolve('public/account.html'));res.writeHead(200,privatePageHeaders);return res.end(html);}
      if(req.method==='GET'&&path==='/account.css'){const css=await readFile(resolve('public/account.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/account-extra.css'){const css=await readFile(resolve('public/account-extra.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/account.js'){const js=await readFile(resolve('public/account.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/account-recovery.js'){const js=await readFile(resolve('public/account-recovery.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});return res.end(js);}
      if(req.method==='GET'&&path==='/web-notifications.js'){const js=await readFile(resolve('public/web-notifications.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/reseller.css'){const css=await readFile(resolve('public/reseller.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8'});return res.end(css);}
      if(req.method==='GET'&&path==='/reseller.js'){const js=await readFile(resolve('public/reseller.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/studio-mark.svg'){const svg=await readFile(resolve('public/studio-mark.svg'));res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'public, max-age=86400'});return res.end(svg);}
      if(req.method==='GET'&&path==='/brand-mark.png'){const png=await readFile(resolve('public/brand-mark.png'));res.writeHead(200,{'content-type':'image/png','cache-control':'public, max-age=86400','content-length':png.length});return res.end(png);}
      if(req.method==='GET'&&path==='/brand-mark.svg'){const svg=await readFile(resolve('public/brand-mark.svg'));res.writeHead(200,{'content-type':'image/svg+xml; charset=utf-8','cache-control':'public, max-age=86400'});return res.end(svg);}
      if(req.method==='GET'&&path==='/download/nivora-android.apk'){const apk=await readFile(resolve('public/releases/Nivora-Customer-latest.apk'));res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-disposition':'attachment; filename="Nivora-Customer-0.23.2.apk"','cache-control':'public, max-age=3600','content-length':apk.length,'x-robots-tag':'noindex, nofollow, noarchive'});return res.end(apk);}
      if(req.method==='GET'&&path==='/download/nivora-partner.apk'){const apk=await readFile(resolve('public/releases/Nivora-Partner-latest.apk'));res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-disposition':'attachment; filename="Nivora-Partner-0.21.0.apk"','cache-control':'public, max-age=3600','content-length':apk.length,'x-robots-tag':'noindex, nofollow, noarchive'});return res.end(apk);}
      if(req.method==='GET'&&path==='/download/nivora-bank-agent.apk'){const apk=await readFile(resolve('public/releases/Nivora-Bank-Agent-latest.apk'));res.writeHead(200,{'content-type':'application/vnd.android.package-archive','content-disposition':'attachment; filename="Nivora-Bank-Agent-1.0.0.apk"','cache-control':'private, no-store','content-length':apk.length,'x-robots-tag':'noindex, nofollow, noarchive'});return res.end(apk);}
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
      if (req.method === 'GET' && path === '/admin-tunnels.js') {
        const js=await readFile(resolve('public/admin-tunnels.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);
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
      if(req.method==='GET'&&path==='/admin-httpsms.js'){const js=await readFile(resolve('public/admin-httpsms.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-ai.js'){const js=await readFile(resolve('public/admin-ai.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if(req.method==='GET'&&path==='/admin-emergency.js'){const js=await readFile(resolve('public/admin-emergency.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js);}
      if (req.method === 'GET' && path === '/admin.js') {
        const js = await readFile(resolve('public/admin.js'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control':'no-store' }); return res.end(js);
      }
      if (req.method === 'GET' && path === '/health') {db.prepare('SELECT 1 ok').get();return json(res, 200, { ok:true,service:'nivora',uptimeSeconds:Math.floor(process.uptime()),database:'ok',time:new Date().toISOString() });}

      const iosImportMatch=path.match(/^\/ios\/import\/([A-Za-z0-9_-]{40,100})$/);
      if(req.method==='GET'&&iosImportMatch){
        const now=new Date().toISOString(),tokenHash=createHash('sha256').update(iosImportMatch[1]).digest('hex');
        let subscription;
        db.exec('BEGIN IMMEDIATE');
        try{
          subscription=db.prepare(`SELECT t.id,t.fetch_count,t.max_fetches,t.expires_at,t.revoked_at,
              s.upstream_subscription_url,s.subscription_url,s.status subscription_status,
              COALESCE(s.control_status,'active') control_status,s.deleted_at,
              o.status order_status,o.location_id,o.account_id,l.panel_node_id,
              a.status account_status,d.status device_status
            FROM subscription_import_tokens t
            JOIN subscriptions s ON s.id=t.subscription_id
            JOIN orders o ON o.id=s.order_id
            JOIN accounts a ON a.id=t.account_id AND a.id=o.account_id
            JOIN account_devices d ON d.id=t.device_id AND d.account_id=t.account_id
            LEFT JOIN service_locations l ON l.id=o.location_id
            WHERE t.token_hash=?`).get(tokenHash);
          const usable=subscription&&!subscription.revoked_at&&subscription.expires_at>now&&Number(subscription.fetch_count)<Number(subscription.max_fetches)&&subscription.account_status==='active'&&subscription.device_status==='active'&&subscription.order_status==='approved'&&subscription.subscription_status==='active'&&subscription.control_status==='active'&&!subscription.deleted_at;
          if(!usable){db.exec('ROLLBACK');res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');return json(res,410,{error:'IMPORT_LINK_EXPIRED'});}
          db.prepare('UPDATE subscription_import_tokens SET fetch_count=fetch_count+1,last_fetched_at=? WHERE id=?').run(now,subscription.id);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        try{
          const {rendered,endpoints}=await renderSubscriptionBundle(subscription);
          res.writeHead(200,{
            'content-type':'text/plain; charset=utf-8',
            'content-disposition':'inline; filename="nivora.txt"',
            'cache-control':'no-store',
            'referrer-policy':'no-referrer',
            'x-content-type-options':'nosniff',
            'x-robots-tag':'noindex, nofollow, noarchive',
            'x-nivora-routes':String(endpoints.length)
          });
          return res.end(rendered);
        }catch(error){
          res.writeHead(error.status||502,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
          return res.end(error.message==='SUBSCRIPTION_NOT_READY'?'SUBSCRIPTION_NOT_READY':'SUBSCRIPTION_UPSTREAM_UNAVAILABLE');
        }
      }

      const publicSubscriptionMatch = path.match(/^\/sub\/([a-f0-9]{32})$/i);
      if (req.method === 'GET' && publicSubscriptionMatch) {
        const subscription = db.prepare(`SELECT s.upstream_subscription_url,s.subscription_url,o.location_id,o.account_id,l.panel_node_id
          FROM subscriptions s JOIN orders o ON o.id=s.order_id
          LEFT JOIN service_locations l ON l.id=o.location_id
          WHERE s.access_token=? AND s.status='active'`).get(publicSubscriptionMatch[1]);
        if (!subscription) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('SUBSCRIPTION_NOT_FOUND'); }
        const account = accountFromRequest(db, req, { requireDevice:enforceDeviceGateway });
        const subscriptionAccount = subscription.account_id && db.prepare('SELECT role FROM accounts WHERE id=?').get(subscription.account_id);
        if (enforceDeviceGateway && subscriptionAccount?.role === 'customer' && (!account || account.role !== 'customer' || account.id !== subscription.account_id)) { res.writeHead(401, {'content-type':'text/plain; charset=utf-8'}); return res.end('AUTH_REQUIRED'); }
        try {
          const {rendered,endpoints}=await renderSubscriptionBundle(subscription);
          const etag=`"${createHash('sha256').update(rendered).digest('base64url')}"`;
          if(req.headers['if-none-match']===etag){res.writeHead(304,{etag,'cache-control':'private, max-age=60'});return res.end();}
          res.writeHead(200, {
            'content-type':'text/plain; charset=utf-8',
            'cache-control':'private, max-age=60',
            etag,
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
      if(req.method==='POST'&&path==='/api/device-recovery/request'){
        const body=await readJson(req),phone=normalizePhone(body.phone);
        if(!/^09\d{9}$/.test(phone)||typeof body.password!=='string')return json(res,401,{error:'INVALID_CREDENTIALS'});
        const account=db.prepare("SELECT * FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(phone);
        if(!account||!verifyPassword(body.password,account.password_salt,account.password_hash))return json(res,401,{error:'INVALID_CREDENTIALS'});
        const requestedHash=deviceHash(req);if(!requestedHash)return json(res,403,{error:'DEVICE_REQUIRED'});
        try{
          const request=requestDeviceRecovery(db,{accountId:account.id,deviceHash:requestedHash});
          if(request.created){
            audit(account.id,'request','device_recovery',request.id,{phone:account.phone});
            if(account.managed_by_reseller_id)notify(account.managed_by_reseller_id,'درخواست آزادسازی دستگاه',`${account.name} درخواست فعال‌سازی روی دستگاه جدید را ارسال کرد.`);
          }
          return json(res,202,request);
        }catch(error){return json(res,error.status||400,deviceRecoveryErrorBody(error));}
      }
      const publicDeviceRecovery=path.match(/^\/api\/device-recovery\/request\/([A-Za-z0-9-]{20,80})$/);
      if(req.method==='GET'&&publicDeviceRecovery){
        try{return json(res,200,deviceRecoveryStatus(db,publicDeviceRecovery[1]));}
        catch(error){return json(res,error.status||400,deviceRecoveryErrorBody(error));}
      }
      if(req.method==='POST'&&path==='/api/customer/register'){
        const b=await readJson(req),phone=normalizePhone(b.phone);if(!b.name?.trim()||!/^09\d{9}$/.test(phone))return json(res,400,{error:'INVALID_ACCOUNT'});
        let password;try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}
        const id=randomUUID(),now=new Date().toISOString();try{db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,password_hash,password_salt) VALUES(?,?,?,'customer','active',0,?,?,?,?)`).run(id,phone,b.name.trim(),now,now,password.hash,password.salt);db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),id,now);}catch{return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}
        const account=db.prepare('SELECT * FROM accounts WHERE id=?').get(id);let claimed=null;try{claimed=claimCustomerDevice(account,req);}catch(error){return json(res,error.status||403,deviceErrorBody(error));}const session=createSession(db,id,undefined,claimed?.id||null);audit(phone,'register','account',id);return json(res,201,{...session,account:{id,name:b.name.trim(),phone}});
      }
      if(req.method==='POST'&&path==='/api/customer/login'){
        const b=await readJson(req),phone=normalizePhone(b.phone);if(!/^09\d{9}$/.test(phone)||typeof b.password!=='string')return json(res,401,{error:'INVALID_CREDENTIALS'});const account=db.prepare("SELECT * FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(phone);if(!account||!verifyPassword(b.password,account.password_salt,account.password_hash))return json(res,401,{error:'INVALID_CREDENTIALS'});let claimed=null;try{claimed=claimCustomerDevice(account,req)}catch(error){return json(res,error.status||403,deviceErrorBody(error))}const session=createSession(db,account.id,undefined,claimed?.id||null);return json(res,200,{...session,account:{id:account.id,name:account.name,phone:account.phone}});
      }
      if(req.method==='POST'&&path==='/api/customer/device/bind'){
        const account=accountFromRequest(db,req);if(!account||account.role!=='customer')return json(res,401,{error:'UNAUTHORIZED'});
        try{const claimed=claimCustomerDevice(account,req,{required:true});return json(res,200,{bound:true,deviceId:claimed.id,...deviceSummary(db,account.id)});}catch(error){return json(res,error.status||403,deviceErrorBody(error))}
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
        let password;try{password=hashPassword(b.newPassword)}catch(e){return json(res,400,{error:e.message});}const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,device_binding_hash=NULL,device_bound_at=NULL,updated_at=? WHERE id=?').run(password.hash,password.salt,now,row.account_id);db.prepare("UPDATE account_devices SET status='revoked',revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,'password-reset') WHERE account_id=? AND status='active'").run(now,row.account_id);db.prepare("UPDATE hysteria_tickets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND revoked_at IS NULL").run(now,row.account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(row.account_id);db.prepare('UPDATE password_reset_codes SET consumed_at=? WHERE id=?').run(now,row.id);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return json(res,500,{error:'PASSWORD_RESET_FAILED'});}audit(phone,'confirm','password_reset_code',row.id);return json(res,200,{reset:true});
      }
      if(req.method==='POST'&&path==='/api/customer/password-reset-requests'){
        const b=await readJson(req),phone=String(b.phone||'').trim();
        if(!/^09\d{9}$/.test(phone))return json(res,400,{error:'INVALID_PHONE'});
        const account=db.prepare("SELECT id FROM accounts WHERE phone=? AND role='customer' AND status='active'").get(phone);
        if(account){const pending=db.prepare("SELECT id FROM password_reset_requests WHERE account_id=? AND status='pending'").get(account.id);if(!pending){const id=randomUUID(),now=new Date().toISOString();db.prepare("INSERT INTO password_reset_requests(id,account_id,status,requested_at) VALUES(?,?,'pending',?)").run(id,account.id,now);audit(phone,'request','password_reset',id);}}
        return json(res,202,{accepted:true,message:'اگر حسابی با این شماره وجود داشته باشد، درخواست برای مدیر ارسال می‌شود.'});
      }
      if(path.startsWith('/api/customer/')){
        const emergencySubscription=req.method==='GET'&&path==='/api/customer/emergency/subscription';
        const emergencyLease=req.method==='GET'&&path==='/api/customer/emergency/lease';
        const emergencyRequest=emergencySubscription||emergencyLease;
        const requestIp=emergencyRequest?String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim():'';
        const setEmergencyLimitHeaders=(limit,scope)=>{
          res.setHeader('x-ratelimit-scope',scope);
          res.setHeader('x-ratelimit-limit',limit.limit);
          res.setHeader('x-ratelimit-remaining',limit.remaining);
        };
        const emergencyLimitResponse=(limit,scope,error)=>{
          setEmergencyLimitHeaders(limit,scope);
          res.setHeader('retry-after',limit.retryAfterSeconds);
          return json(res,429,{error,retryAfterSeconds:limit.retryAfterSeconds});
        };
        const account=accountFromRequest(db,req);
        if(!account||account.role!=='customer'){
          if(emergencyRequest){
            const preAuthLimit=emergencyFailureIpLimiter(requestIp);
            setEmergencyLimitHeaders(preAuthLimit,'failure-ip');
            if(preAuthLimit.blocked){
              const error=emergencyLease?'EMERGENCY_LEASE_PREAUTH_RATE_LIMITED':'EMERGENCY_SUBSCRIPTION_PREAUTH_RATE_LIMITED';
              return emergencyLimitResponse(preAuthLimit,'failure-ip',error);
            }
          }
          return json(res,401,{error:'UNAUTHORIZED'});
        }
        if(emergencyRequest){
          const rawDeviceHash=deviceHash(req);
          // Invalid/missing device input is a failure path and consumes the
          // shared abuse bucket, but a valid bound device never consults that
          // bucket (so another subscriber behind the same CGNAT is unaffected).
          if(!rawDeviceHash){
            const failureLimit=emergencyFailureIpLimiter(requestIp);
            if(failureLimit.blocked){
              const error=emergencyLease?'EMERGENCY_LEASE_DEVICE_RATE_LIMITED':'EMERGENCY_SUBSCRIPTION_DEVICE_RATE_LIMITED';
              return emergencyLimitResponse(failureLimit,'failure-ip',error);
            }
          }
          // Both in-memory guards run before claimCustomerDevice, which opens a
          // write transaction and updates last_seen_at. The per-account ceiling
          // prevents rotating syntactically valid device IDs around the device
          // bucket.
          const accountLimiter=emergencyLease?emergencyLeaseAccountLimiter:emergencySubscriptionAccountLimiter;
          const deviceLimiter=emergencyLease?emergencyLeaseDeviceLimiter:emergencySubscriptionDeviceLimiter;
          const accountLimit=accountLimiter(account.id);
          if(accountLimit.blocked){
            const error=emergencyLease?'EMERGENCY_LEASE_ACCOUNT_RATE_LIMITED':'EMERGENCY_SUBSCRIPTION_ACCOUNT_RATE_LIMITED';
            return emergencyLimitResponse(accountLimit,'account',error);
          }
          if(rawDeviceHash){
            const deviceLimit=deviceLimiter(`${account.id}:${rawDeviceHash}`);
            setEmergencyLimitHeaders(deviceLimit,'account-device');
            if(deviceLimit.blocked){
              const error=emergencyLease?'EMERGENCY_LEASE_RATE_LIMITED':'EMERGENCY_SUBSCRIPTION_RATE_LIMITED';
              return emergencyLimitResponse(deviceLimit,'account-device',error);
            }
          }
          let claimedDevice;
          try{claimedDevice=claimCustomerDevice(account,req,{required:true});}
          catch(error){
            // Valid-format but unauthorized device IDs fail inside claim. Count
            // those failures by IP as well; the account ceiling above bounds how
            // many claim transactions device-ID rotation can trigger.
            if(rawDeviceHash){
              const failureLimit=emergencyFailureIpLimiter(requestIp);
              if(failureLimit.blocked){
                const code=emergencyLease?'EMERGENCY_LEASE_DEVICE_RATE_LIMITED':'EMERGENCY_SUBSCRIPTION_DEVICE_RATE_LIMITED';
                return emergencyLimitResponse(failureLimit,'failure-ip',code);
              }
            }
            return json(res,error.status||403,deviceErrorBody(error));
          }
          if(!await hasEmergencyEntitlement(account.id))return json(res,403,{error:'EMERGENCY_SUBSCRIPTION_REQUIRED'});
          if(emergencyLease){
            const status=emergencyPool.status();
            if(!status.enabled||!status.ready)return json(res,403,{error:'EMERGENCY_DISABLED'});
            return json(res,200,{valid:true,leaseSeconds:180});
          }
          try{
            const emergency=await emergencyPool.getBundle();
            res.writeHead(200,{
              'content-type':'text/plain; charset=utf-8',
              'cache-control':'no-store',
              'vary':'Authorization, X-Nivora-Device',
              'x-nivora-emergency':'third-party-public',
              'x-nivora-routes':String(emergency.nodeCount),
              'x-nivora-lease-seconds':'180'
            });
            return res.end(emergency.bundle);
          }catch(error){
            const code=error instanceof EmergencyPoolError?error.code:'EMERGENCY_POOL_UNAVAILABLE';
            return json(res,error.status||503,{error:code});
          }
        }
        const iosImportRequest=path.match(/^\/api\/customer\/orders\/([^/]+)\/ios-import$/);
        if(req.method==='POST'&&iosImportRequest){
          const subscription=db.prepare(`SELECT s.id subscription_id,s.status subscription_status,
              COALESCE(s.control_status,'active') control_status,s.deleted_at,
              s.upstream_subscription_url,s.subscription_url,
              o.id order_id,o.status order_status,o.order_kind,o.location_id,
              p.name plan_name,l.name location_name
            FROM orders o
            JOIN plans p ON p.id=o.plan_id
            LEFT JOIN subscriptions s ON s.order_id=o.id
            LEFT JOIN service_locations l ON l.id=o.location_id
            WHERE o.id=? AND o.account_id=? AND o.order_kind='purchase'`).get(iosImportRequest[1],account.id);
          if(!subscription)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
          if(subscription.order_status!=='approved'||subscription.subscription_status!=='active'||subscription.control_status!=='active'||subscription.deleted_at)return json(res,409,{error:'SUBSCRIPTION_NOT_ACTIVE'});
          if(!subscription.upstream_subscription_url&&!subscription.subscription_url)return json(res,409,{error:'SUBSCRIPTION_NOT_READY'});
          let claimed;
          try{claimed=claimCustomerDevice(account,req,{required:true});}
          catch(error){return json(res,error.status||403,deviceErrorBody(error));}
          const now=new Date(),nowIso=now.toISOString(),windowStart=new Date(now.getTime()-10*60_000).toISOString();
          const issued=Number(db.prepare('SELECT COUNT(*) count FROM subscription_import_tokens WHERE account_id=? AND created_at>?').get(account.id,windowStart).count);
          if(issued>=5){res.setHeader('retry-after','600');return json(res,429,{error:'IMPORT_RATE_LIMITED'});}
          const rawToken=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(rawToken).digest('hex'),expiresAt=new Date(now.getTime()+120_000).toISOString(),id=randomUUID();
          db.exec('BEGIN IMMEDIATE');
          try{
            db.prepare('UPDATE subscription_import_tokens SET revoked_at=? WHERE account_id=? AND subscription_id=? AND platform=? AND revoked_at IS NULL').run(nowIso,account.id,subscription.subscription_id,'ios');
            db.prepare(`INSERT INTO subscription_import_tokens(id,token_hash,account_id,subscription_id,device_id,platform,expires_at,max_fetches,fetch_count,created_at)
              VALUES(?,?,?,?,?,'ios',?,3,0,?)`).run(id,tokenHash,account.id,subscription.subscription_id,claimed.id,expiresAt,nowIso);
            db.prepare("DELETE FROM subscription_import_tokens WHERE expires_at<? AND created_at<?").run(nowIso,new Date(now.getTime()-24*60*60_000).toISOString());
            db.prepare("UPDATE account_devices SET label='آیفون / مرورگر',platform='iOS',last_seen_at=? WHERE id=?").run(nowIso,claimed.id);
            db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
          audit(account.id,'issue','ios_subscription_import',subscription.subscription_id,{orderId:subscription.order_id,expiresAt,maxFetches:3});
          res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
          return json(res,201,{
            subscriptionUrl:`${publicOrigin(req)}/ios/import/${rawToken}`,
            profileName:`Nivora · ${subscription.plan_name}${subscription.location_name?` · ${subscription.location_name}`:''}`,
            expiresAt,expiresInSeconds:120,maxFetches:3
          });
        }
        const hysteriaTicket=path.match(/^\/api\/customer\/subscriptions\/([^/]+)\/connect-ticket$/);
        if(req.method==='POST'&&hysteriaTicket){
          const hash=deviceHash(req);if(!hash)return json(res,403,{error:'DEVICE_REQUIRED'});
          try{claimCustomerDevice(account,req,{required:true});}catch(error){return json(res,error.status||403,deviceErrorBody(error));}
          const body=await readJson(req),routeId=String(body.routeId||'auto').trim();
          if(routeId!=='auto'&&!/^[A-Za-z0-9_.-]{2,80}$/.test(routeId))return json(res,400,{error:'INVALID_HYSTERIA2_ROUTE'});
          try{
            const ticket=await hysteriaTickets.issue({orderId:hysteriaTicket[1],accountId:account.id,deviceBindingHash:hash,routeId});
            return json(res,201,ticket);
          }catch(error){
            if(error instanceof HysteriaAuthError)return json(res,error.status,{error:error.code});
            throw error;
          }
        }
        if(req.method==='GET'&&path==='/api/customer/me'){
          let panelStats={};try{panelStats=await panelStatsReader()||{};}catch{}
          const wallet=getWalletStatement(db,account.id,25);
        const rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.bundle_id,o.bundle_index,o.bundle_size,o.status,o.created_at,o.tracking_token,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,s.access_token subscription_access_token,s.panel_client_id,l.name location_name,l.country_code,l.flag_emoji,l.city,${locationSequenceSql} location_sequence,(SELECT COUNT(*) FROM location_endpoints e WHERE e.location_id=o.location_id AND e.active=1) route_count FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.account_id=? AND o.order_kind='purchase' ORDER BY o.created_at DESC LIMIT 100`).all(account.id);
          const orders=rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats));
          const topups=db.prepare('SELECT id,amount_toman,receipt_reference,receipt_image_url,status,review_note,created_at,reviewed_at FROM wallet_topups WHERE account_id=? ORDER BY created_at DESC LIMIT 50').all(account.id),notifications=db.prepare('SELECT id,title,body,read_at,created_at FROM notifications WHERE account_id=? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 30').all(account.id),debts=db.prepare(`SELECT d.id,d.amount_toman,d.note,d.status,d.created_at,d.payment_reported_at,a.name reseller_name FROM reseller_debts d JOIN accounts a ON a.id=d.reseller_id WHERE d.customer_account_id=? AND d.status IN ('open','payment_reported') ORDER BY d.created_at DESC`).all(account.id);
          const emergency=emergencyPool.status(),emergencyEntitled=await hasEmergencyEntitlement(account.id,panelStats);
          return json(res,200,{id:account.id,name:account.name,phone:account.phone,balanceToman:wallet.balanceToman,transactions:wallet.transactions,orders,topups,notifications,debts,device:deviceSummary(db,account.id),emergency:{enabled:Boolean(emergency.enabled&&emergencyEntitled),ready:Boolean(emergency.ready&&emergencyEntitled),nodeCount:emergencyEntitled?Number(emergency.nodeCount||0):0,updatedAt:emergencyEntitled?emergency.updatedAt||null:null}});
        }
        if(req.method==='PATCH'&&path==='/api/customer/profile'){
          const b=await readJson(req),name=String(b.name||'').trim().replace(/\s+/g,' ');
          if(name.length<3||name.length>80||/[<>\u0000-\u001f]/.test(name))return json(res,400,{error:'INVALID_NAME'});
          const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
          try{db.prepare('UPDATE accounts SET name=?,updated_at=? WHERE id=?').run(name,now,account.id);db.prepare('UPDATE reseller_customers SET name=?,updated_at=? WHERE account_id=?').run(name,now,account.id);db.exec('COMMIT');}
          catch(error){db.exec('ROLLBACK');return json(res,500,{error:'PROFILE_UPDATE_FAILED'});}
          audit(account.id,'update','profile',account.id,{fields:['name']});return json(res,200,{id:account.id,name,phone:account.phone});
        }
        const debtPayment=path.match(/^\/api\/customer\/debts\/([^/]+)\/report-payment$/);
        if(debtPayment&&req.method==='POST'){
          const debt=db.prepare("SELECT * FROM reseller_debts WHERE id=? AND customer_account_id=? AND status='open'").get(debtPayment[1],account.id);if(!debt)return json(res,404,{error:'DEBT_NOT_FOUND'});const now=new Date().toISOString();db.prepare("UPDATE reseller_debts SET status='payment_reported',payment_reported_at=?,updated_at=? WHERE id=?").run(now,now,debt.id);notify(debt.reseller_id,'اعلام پرداخت بدهی',`${account.name} پرداخت بدهی ${debt.amount_toman.toLocaleString('fa-IR')} تومان را اعلام کرد.`);audit(account.id,'report_payment','reseller_debt',debt.id);return json(res,200,{status:'payment_reported'});
        }
        if(req.method==='POST'&&path==='/api/customer/discount/validate'){const b=await readJson(req),code=String(b.code||'').trim().toUpperCase(),discount=db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id) used,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id AND account_id=?) customer_used FROM discount_codes d WHERE d.code=? AND d.active=1`).get(account.id,code);if(!discount||(discount.expires_at&&discount.expires_at<=new Date().toISOString())||(discount.max_uses&&discount.used>=discount.max_uses)||discount.customer_used>=discount.per_customer_limit)return json(res,404,{error:'DISCOUNT_NOT_AVAILABLE'});return json(res,200,{code:discount.code,percent:discount.percent});}
        if(req.method==='POST'&&path==='/api/customer/change-password'){
          const b=await readJson(req);
          if(!verifyPassword(b.currentPassword,account.password_salt,account.password_hash))return json(res,400,{error:'INVALID_CURRENT_PASSWORD'});
          if(b.currentPassword===b.newPassword)return json(res,400,{error:'PASSWORD_UNCHANGED'});
          let password;try{password=hashPassword(b.newPassword)}catch(error){return json(res,400,{error:error.message});}
          const rawToken=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],tokenHash=rawToken?createHash('sha256').update(rawToken).digest('hex'):'';
          if(!tokenHash)return json(res,401,{error:'UNAUTHORIZED'});
          const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');
          try{
            db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(password.hash,password.salt,now,account.id);
            db.prepare('DELETE FROM account_sessions WHERE account_id=? AND token_hash<>?').run(account.id,tokenHash);
            db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');return json(res,500,{error:'PASSWORD_CHANGE_FAILED'});}
          audit(account.id,'change_password','account',account.id);return json(res,200,{changed:true,otherSessionsRevoked:true});
        }
        if(req.method==='GET'&&path==='/api/customer/tickets'){const tickets=db.prepare(`SELECT t.*,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t WHERE account_id=? AND owner_archived_at IS NULL ORDER BY updated_at DESC`).all(account.id);return json(res,200,tickets);}
        if(req.method==='POST'&&path==='/api/customer/tickets'){const b=await readJson(req),subject=String(b.subject||'').trim(),body=String(b.body||'').trim();if(subject.length<3||body.length<3)return json(res,400,{error:'INVALID_TICKET'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO support_tickets(id,account_id,subject,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)`).run(id,account.id,subject,now,now);db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),id,body,now);return json(res,201,{id,status:'open'});}
        const customerTicket=path.match(/^\/api\/customer\/tickets\/([^/]+)$/);if(customerTicket&&req.method==='GET'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=? AND account_id=?').get(customerTicket[1],account.id);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(customerTicket&&req.method==='POST'){const ticket=db.prepare("SELECT * FROM support_tickets WHERE id=? AND account_id=? AND status<>'closed'").get(customerTicket[1],account.id),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='open',owner_archived_at=NULL,updated_at=? WHERE id=?").run(now,ticket.id);return json(res,201,{sent:true});}
        if(req.method==='POST'&&path==='/api/customer/notifications/read'){db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE account_id=?').run(new Date().toISOString(),account.id);return json(res,200,{success:true});}
        if(req.method==='DELETE'&&path==='/api/customer/notifications'){const now=new Date().toISOString(),result=db.prepare('UPDATE notifications SET dismissed_at=?,read_at=COALESCE(read_at,?) WHERE account_id=? AND dismissed_at IS NULL').run(now,now,account.id);return json(res,200,{cleared:Number(result.changes)});}
        if(req.method==='DELETE'&&path==='/api/customer/tickets'){const now=new Date().toISOString(),result=db.prepare('UPDATE support_tickets SET owner_archived_at=? WHERE account_id=? AND owner_archived_at IS NULL').run(now,account.id);return json(res,200,{cleared:Number(result.changes)});}
        if(req.method==='POST'&&path==='/api/customer/ai/support'){
          const b=await readJson(req),question=String(b.question||'').trim();if(question.length<3||question.length>600)return json(res,400,{error:'INVALID_AI_QUESTION'});
          const context=db.prepare(`SELECT COALESCE(w.balance_toman,0) balance_toman,(SELECT COUNT(*) FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.account_id=a.id AND s.status='active') active_subscriptions,(SELECT COUNT(*) FROM wallet_topups t WHERE t.account_id=a.id AND t.status='under_review') pending_payments FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id WHERE a.id=?`).get(account.id)||{};
          try{const answer=await aiCompletion({system:'شما دستیار پشتیبانی فارسی Nivora هستید. فقط درباره استفاده از برنامه، حساب، کیف پول، خرید، تمدید، اتصال و رفع اشکال عمومی پاسخ کوتاه و روشن بدهید. رمز، توکن، لینک خصوصی یا تنظیمات محرمانه درخواست نکنید. هیچ پرداختی را تأیید یا رد نکنید و درباره وضعیت مالی فقط از زمینه داده‌شده استفاده کنید. اگر مسئله نیازمند دسترسی مدیر، بررسی پرداخت یا تشخیص قطعی شبکه است، صریحاً پیشنهاد ساخت تیکت انسانی بدهید. حداکثر ۸ خط.',user:`زمینه حساب: ${JSON.stringify(context)}\nپرسش مشتری: ${question}`,maxTokens:500});return json(res,200,{answer});}catch(error){return json(res,error.status||503,{error:error.message||'AI_PROVIDER_UNAVAILABLE'});}
        }
        if(req.method==='POST'&&path==='/api/customer/wallet/topups'){
          let b,amount,receiptReference,receiptCapability;
          try{
            b=await readJson(req,MAX_PAYMENT_BODY_BYTES);
            if(!b||Array.isArray(b)||typeof b!=='object')throw new PaymentRequestError('INVALID_TOPUP');
            amount=optionalPaymentAmount(b.amountToman,{minimum:1000});
            if(amount===null)throw new PaymentRequestError('INVALID_PAYMENT_AMOUNT');
            receiptReference=optionalReceiptReference(b.receiptReference);
            receiptCapability=receiptCapabilityFromUrl(b.receiptImageUrl,req);
          }catch(error){return paymentRequestError(res,error,'INVALID_TOPUP');}
          const id=randomUUID(),now=new Date().toISOString();
          try{
            db.exec('BEGIN IMMEDIATE');
            const pending=db.prepare("SELECT COUNT(*) count FROM wallet_topups WHERE account_id=? AND status='under_review'").get(account.id).count;
            if(pending>=MAX_PENDING_PAYMENTS)throw new PaymentRequestError('TOO_MANY_PENDING_TOPUPS',429);
            const receiptImageUrl=claimReceipt(db,receiptCapability,{entityType:'wallet_topup',entityId:id,accountId:account.id});
            db.prepare(`INSERT INTO wallet_topups(id,account_id,amount_toman,receipt_reference,receipt_image_url,status,created_at) VALUES(?,?,?,?,?,'under_review',?)`).run(id,account.id,amount,receiptReference,receiptImageUrl,now);
            db.exec('COMMIT');
          }catch(error){try{db.exec('ROLLBACK')}catch{}if(error instanceof PaymentRequestError){if(error.status===429)res.setHeader('retry-after','3600');return paymentRequestError(res,error);}throw error;}
          audit(account.id,'create','wallet_topup',id,{amountToman:amount,receiptProvided:Boolean(receiptCapability)});schedulePaymentSweep();setTimeout(()=>{const pending=db.prepare("SELECT t.id,t.amount_toman,a.name,a.phone FROM wallet_topups t JOIN accounts a ON a.id=t.account_id WHERE t.id=? AND t.status='under_review'").get(id);if(pending)telegramAdminAlert(`🧾 پرداخت نیازمند بررسی\n${pending.name} — ${pending.phone}\n${Number(pending.amount_toman).toLocaleString('fa-IR')} تومان`,{inline_keyboard:[[{text:'✅ تأیید و شارژ',callback_data:`topup:approve:${pending.id}`},{text:'❌ رد',callback_data:`topup:reject:${pending.id}`}]]});},2000).unref();return json(res,201,{id,status:'under_review',amountToman:amount,receiptRequired:false});
        }
        if(req.method==='POST'&&path==='/api/customer/wallet/purchase'){
          const b=await readJson(req),plan=db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(b.planId);if(!plan)return json(res,404,{error:'PLAN_NOT_FOUND'});
          const locations=purchaseLocationsForPlan(plan);if(!locations)return json(res,409,{error:'NO_CAPACITY',requiredLocations:plan.location_mode==='multi'?Number(plan.bundle_size)||3:1});
          const basePrice=Math.round(plan.price_irr/10),code=String(b.discountCode||'').trim().toUpperCase();let discount=null;if(code){discount=db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id) used,(SELECT COUNT(*) FROM discount_redemptions WHERE discount_id=d.id AND account_id=?) customer_used FROM discount_codes d WHERE d.code=? AND d.active=1`).get(account.id,code);if(!discount||(discount.expires_at&&discount.expires_at<=new Date().toISOString())||(discount.max_uses&&discount.used>=discount.max_uses)||discount.customer_used>=discount.per_customer_limit)return json(res,400,{error:'DISCOUNT_NOT_AVAILABLE'});}
          const discountToman=discount?Math.floor(basePrice*discount.percent/100):0,price=basePrice-discountToman,bundleId=locations.length>1?randomUUID():null,now=new Date().toISOString(),entries=locations.map((location,index)=>({id:randomUUID(),subscriptionId:randomUUID(),accessToken:subscriptionToken(),trackingToken:randomUUID().replace(/-/g,''),location,phone:account.phone,index:index+1})),primary=entries[0];
          try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`customer-order:${primary.id}`,actor:account.id,note:`خرید ${plan.name}${locations.length>1?` (${locations.length} لوکیشن)`:''}`});}catch(e){return json(res,400,{error:e.message});}
          try{db.exec('BEGIN IMMEDIATE');for(const entry of entries){db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,account_id,location_id,bundle_id,bundle_index,bundle_size) VALUES(?,?,?,?,'approved',?,?,?,?,?,?,?,?)`).run(entry.id,account.name,account.phone,plan.id,entry.index===1?price*10:0,now,entry.trackingToken,account.id,entry.location.id,bundleId,entry.index,entries.length);db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(entry.subscriptionId,entry.id,entry.accessToken,now);}if(discount)db.prepare('INSERT INTO discount_redemptions(id,discount_id,account_id,order_id,discount_toman,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),discount.id,account.id,primary.id,discountToman,now);db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK')}catch{}postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`customer-refund:${primary.id}`,actor:'system',note:'بازپرداخت ثبت ناموفق خرید'});throw error;}
          const provisioned=await provisionPurchaseEntries(plan,entries);if(!provisioned.ok){postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`customer-refund:${primary.id}`,actor:'system',note:'بازپرداخت خرید ناموفق'});if(discount)db.prepare('DELETE FROM discount_redemptions WHERE order_id=?').run(primary.id);notify(account.id,'بازپرداخت انجام شد','ساخت کامل اشتراک‌ها ناموفق بود و مبلغ به کیف پول برگشت.');return json(res,502,{error:'PROVISION_FAILED',refunded:true});}
          const subscriptions=provisioned.items.map(item=>({id:item.id,locationId:item.location.id,locationName:item.location.name,subscriptionUrl:publicSubscriptionUrl(req,item.accessToken,item.upstreamUrl)}));notify(account.id,'اشتراک فعال شد',locations.length>1?`${locations.length} اشتراک پلن ${plan.name} در لوکیشن‌های مختلف ساخته شد.`:`پلن ${plan.name} با موفقیت ساخته شد.`);return json(res,201,{id:primary.id,orderIds:entries.map(entry=>entry.id),bundleId,status:'active',subscriptionCount:subscriptions.length,subscriptions,trackingToken:primary.trackingToken,subscriptionUrl:subscriptions[0].subscriptionUrl,balanceToman:getWalletStatement(db,account.id,1).balanceToman,discountToman});
        }
        const walletRenew=path.match(/^\/api\/customer\/orders\/([^/]+)\/renew$/);if(req.method==='POST'&&walletRenew){
          const original=db.prepare(`SELECT o.*,p.name plan_name,p.price_irr,p.traffic_gb,p.duration_days,s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.account_id=? AND o.order_kind='purchase' AND s.status='active'`).get(walletRenew[1],account.id);if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});const price=Math.round(original.price_irr/10),id=randomUUID(),now=new Date().toISOString();try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`customer-renew:${id}`,actor:account.id,note:`تمدید ${original.plan_name}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,account_id,location_id,order_kind,parent_order_id) VALUES(?,?,?,?,'approved',?,?,?,?,?,'renewal',?)`).run(id,account.name,account.phone,original.plan_id,price*10,now,randomUUID().replace(/-/g,''),account.id,original.location_id,original.id);const sid=randomUUID();db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(sid,id,original.panel_client_id,original.subscription_url,original.upstream_subscription_url||original.subscription_url,now);const renewalLocation=db.prepare('SELECT * FROM service_locations WHERE id=?').get(original.location_id),renewalProvisioner=provisionerForLocation(renewalLocation);try{if(!renewalProvisioner?.renew)throw new Error('RENEW_NOT_SUPPORTED');await renewalProvisioner.renew({panelClientId:original.panel_client_id,addDays:original.duration_days,addTrafficGb:original.traffic_gb});db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(),sid);return json(res,201,{id,status:'active',subscriptionUrl:publicSubscriptionUrl(req,original.subscription_access_token,original.subscription_url),balanceToman:getWalletStatement(db,account.id,1).balanceToman});}catch(e){db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message||e),sid);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`customer-renew-refund:${id}`,actor:'system',note:'بازپرداخت تمدید ناموفق'});return json(res,502,{error:'RENEW_FAILED',refunded:true});}
        }
      }
      if(req.method==='POST'&&path==='/api/reseller/login'){
        const b=await readJson(req),phone=normalizePhone(b.phone);if(!/^09\d{9}$/.test(phone)||typeof b.password!=='string')return json(res,401,{error:'INVALID_CREDENTIALS'});const account=db.prepare("SELECT * FROM accounts WHERE phone=? AND role='reseller' AND status='active'").get(phone);
        if(!account||!verifyPassword(b.password,account.password_salt,account.password_hash))return json(res,401,{error:'INVALID_CREDENTIALS'});
        const session=createSession(db,account.id);return json(res,200,{...session,account:{id:account.id,name:account.name,phone:account.phone}});
      }
      if(path.startsWith('/api/reseller/')){
        const account=accountFromRequest(db,req);if(!account||account.role!=='reseller')return json(res,401,{error:'UNAUTHORIZED'});
        if(req.method==='GET'&&path==='/api/reseller/me'){
          const wallet=getWalletStatement(db,account.id,25),summary=db.prepare(`SELECT
            (SELECT COUNT(*) FROM reseller_customers WHERE reseller_id=? AND status='active') customers_count,
            (SELECT COUNT(*) FROM orders WHERE reseller_id=? AND order_kind='purchase' AND (bundle_id IS NULL OR bundle_index=1)) sales_count,
            (SELECT COUNT(*) FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.reseller_id=? AND o.order_kind='purchase' AND s.status='active' AND COALESCE(s.control_status,'active')='active') active_subscriptions,
            (SELECT COALESCE(SUM(reseller_sale_price_toman),0) FROM orders WHERE reseller_id=? AND status='approved') total_revenue_toman,
            (SELECT COALESCE(SUM(CAST(amount_transferred_irr/10 AS INTEGER)),0) FROM orders WHERE reseller_id=? AND status='approved') total_cost_toman`).get(account.id,account.id,account.id,account.id,account.id);
          const notifications=db.prepare('SELECT id,title,body,read_at,created_at FROM notifications WHERE account_id=? AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 30').all(account.id);
          const debts=db.prepare(`SELECT d.id,d.customer_account_id,d.amount_toman,d.note,d.status,d.created_at,d.payment_reported_at,a.name customer_name,a.phone customer_phone FROM reseller_debts d JOIN accounts a ON a.id=d.customer_account_id WHERE d.reseller_id=? AND d.status IN ('open','payment_reported') ORDER BY d.created_at DESC LIMIT 100`).all(account.id);
          const walletTransfers=db.prepare(`SELECT t.id,t.customer_account_id,t.amount_toman,t.reversed_amount_toman,t.note,t.status,t.created_at,a.name customer_name,a.phone customer_phone FROM reseller_wallet_transfers t JOIN accounts a ON a.id=t.customer_account_id WHERE t.reseller_id=? ORDER BY t.created_at DESC LIMIT 100`).all(account.id);
          return json(res,200,{id:account.id,name:account.name,phone:account.phone,balanceToman:wallet.balanceToman,transactions:wallet.transactions,notifications,debts,walletTransfers,customersCount:summary.customers_count,salesCount:summary.sales_count,activeSubscriptions:summary.active_subscriptions,totalRevenueToman:summary.total_revenue_toman,totalProfitToman:summary.total_revenue_toman-summary.total_cost_toman});
        }
        if(req.method==='GET'&&path==='/api/reseller/plans'){
          const rows=db.prepare(`SELECT p.id,p.name,p.description,p.traffic_gb,p.duration_days,p.device_limit,p.location_mode,p.bundle_size,CAST(p.price_irr/10 AS INTEGER) retail_price_toman,r.price_toman,
            GROUP_CONCAT(l.name,'، ') locations FROM plans p LEFT JOIN reseller_plan_prices r ON r.plan_id=p.id AND r.reseller_id=? AND r.active=1 LEFT JOIN plan_locations pl ON pl.plan_id=p.id LEFT JOIN service_locations l ON l.id=pl.location_id AND l.active=1 WHERE p.active=1 GROUP BY p.id ORDER BY p.sort_order`).all(account.id);
          return json(res,200,rows.map(p=>({...p,price_toman:p.price_toman??Math.round(p.retail_price_toman*(100-account.default_discount_percent)/100)})));
        }
        if(req.method==='GET'&&path==='/api/reseller/customers'){
          const q=String(url.searchParams.get('q')||'').trim(),like=`%${q}%`;
          const rows=db.prepare(`SELECT rc.id,rc.name,rc.phone,rc.note,rc.account_id,rc.created_at,rc.updated_at,
            COUNT(DISTINCT CASE WHEN o.order_kind='purchase' THEN o.id END) subscription_count,
            COUNT(DISTINCT CASE WHEN o.order_kind='purchase' AND s.status='active' AND COALESCE(s.control_status,'active')='active' THEN o.id END) active_subscriptions,
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
          const suppliedPassword=String(body.password||''),temporaryPassword=suppliedPassword?'':`Nv-${randomBytes(6).toString('base64url')}`;
          let password;try{password=hashPassword(suppliedPassword||temporaryPassword)}catch(e){return json(res,400,{error:e.message});}
          if(db.prepare('SELECT id FROM accounts WHERE phone=?').get(customer.phone)||db.prepare('SELECT id FROM reseller_customers WHERE phone=?').get(customer.phone))return json(res,409,{error:'PHONE_ALREADY_EXISTS'});
          const id=randomUUID(),customerAccountId=randomUUID(),now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare(`INSERT INTO accounts(id,phone,name,role,status,default_discount_percent,created_at,updated_at,password_hash,password_salt,managed_by_reseller_id) VALUES(?,?,?,'customer','active',0,?,?,?,?,?)`).run(customerAccountId,customer.phone,customer.name,now,now,password.hash,password.salt,account.id);db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),customerAccountId,now);db.prepare("INSERT INTO reseller_customers(id,reseller_id,name,phone,note,status,created_at,updated_at,account_id) VALUES(?,?,?,?,?,'active',?,?,?)").run(id,account.id,customer.name,customer.phone,customer.note,now,now,customerAccountId);db.exec('COMMIT');}catch{db.exec('ROLLBACK');return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}audit(account.id,'create','reseller_customer',id,{accountId:customerAccountId});notify(customerAccountId,'حساب شما ساخته شد','همکار فروش نیورا حساب کاربری شما را ایجاد کرد.');return json(res,201,{id,...customer,account_id:customerAccountId,created_at:now,updated_at:now,...(temporaryPassword?{temporaryPassword}:{})});
        }
        const managedDeviceCustomer=id=>db.prepare(`SELECT rc.id,a.id account_id FROM reseller_customers rc
          JOIN accounts a ON a.id=rc.account_id AND a.role='customer' AND a.managed_by_reseller_id=rc.reseller_id
          WHERE rc.id=? AND rc.reseller_id=? AND rc.status='active'`).get(id,account.id);
        if(req.method==='GET'&&path==='/api/reseller/device-recovery-requests'){
          return json(res,200,listDeviceRecoveryRequests(db,{resellerId:account.id,status:url.searchParams.get('status')||null}));
        }
        const resellerDeviceRecoveryAction=path.match(/^\/api\/reseller\/device-recovery-requests\/([^/]+)\/(approve|reject)$/);
        if(req.method==='POST'&&resellerDeviceRecoveryAction){
          const request=db.prepare('SELECT account_id FROM device_recovery_requests WHERE id=?').get(resellerDeviceRecoveryAction[1]);
          try{
            const result=resolveDeviceRecovery(db,resellerDeviceRecoveryAction[1],{action:resellerDeviceRecoveryAction[2],actor:account.id,resellerId:account.id});
            if(request&&result.resolvedNow){notify(request.account_id,result.status==='approved'?'دستگاه جدید تأیید شد':'درخواست دستگاه رد شد',result.message);audit(account.id,resellerDeviceRecoveryAction[2],'device_recovery',resellerDeviceRecoveryAction[1]);}
            return json(res,200,result);
          }catch(error){return json(res,error.status||400,deviceRecoveryErrorBody(error));}
        }
        const resellerDevicesMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/devices$/);
        if(req.method==='GET'&&resellerDevicesMatch){
          const customer=managedDeviceCustomer(resellerDevicesMatch[1]);if(!customer)return json(res,403,{error:'CUSTOMER_DEVICE_NOT_MANAGED'});
          const recoveryRequests=listDeviceRecoveryRequests(db,{resellerId:account.id}).filter(request=>request.account_id===customer.account_id&&request.status==='pending');
          return json(res,200,{...deviceSummary(db,customer.account_id),devices:listAccountDevices(db,customer.account_id),recoveryRequests});
        }
        const resellerDeviceLimitMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/device-limit$/);
        if(req.method==='PATCH'&&resellerDeviceLimitMatch){
          const customer=managedDeviceCustomer(resellerDeviceLimitMatch[1]);if(!customer)return json(res,403,{error:'CUSTOMER_DEVICE_NOT_MANAGED'});
          const body=await readJson(req),limit=body.deviceLimit===undefined?body.limit:body.deviceLimit;try{const result=setDeviceLimitOverride(db,customer.account_id,limit);audit(account.id,'set_device_limit','reseller_customer',customer.id,{limit:result.deviceLimitOverride});return json(res,200,result);}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
        }
        const resellerDeviceMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/devices\/([^/]+)$/);
        if(req.method==='DELETE'&&resellerDeviceMatch){
          const customer=managedDeviceCustomer(resellerDeviceMatch[1]);if(!customer)return json(res,403,{error:'CUSTOMER_DEVICE_NOT_MANAGED'});
          try{const result=revokeAccountDevice(db,customer.account_id,resellerDeviceMatch[2],account.id);audit(account.id,'revoke_device','reseller_customer',customer.id,{deviceId:resellerDeviceMatch[2]});return json(res,200,result);}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
        }
        const resellerDeviceResetMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/device-reset$/);
        if(req.method==='POST'&&resellerDeviceResetMatch){
          const customer=managedDeviceCustomer(resellerDeviceResetMatch[1]);if(!customer)return json(res,403,{error:'CUSTOMER_DEVICE_NOT_MANAGED'});
          try{resetAccountDevices(db,customer.account_id,account.id);audit(account.id,'reset_device','reseller_customer',customer.id);notify(customer.account_id,'دستگاه‌های حساب آزاد شد','اکنون می‌توانید حساب را روی دستگاه جدید فعال کنید.');return json(res,200,{deviceBound:false,sessionsRevoked:true});}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
        }
        const resellerResetMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)\/reset-password$/);
        if(resellerResetMatch&&req.method==='POST'){
          const customer=db.prepare(`SELECT rc.*,a.id managed_account_id FROM reseller_customers rc JOIN accounts a ON a.id=rc.account_id AND a.managed_by_reseller_id=rc.reseller_id WHERE rc.id=? AND rc.reseller_id=? AND rc.status='active'`).get(resellerResetMatch[1],account.id);if(!customer)return json(res,403,{error:'CUSTOMER_PASSWORD_NOT_MANAGED'});
          const body=await readJson(req);let password;try{password=hashPassword(body.password)}catch(e){return json(res,400,{error:e.message});}const now=new Date().toISOString();db.prepare('UPDATE accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(password.hash,password.salt,now,customer.managed_account_id);db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(customer.managed_account_id);notify(customer.managed_account_id,'رمز عبور تغییر کرد','رمز حساب شما توسط همکار فروش تغییر داده شد.');audit(account.id,'reset_password','reseller_customer',customer.id);return json(res,200,{reset:true});
        }
        if(req.method==='POST'&&path==='/api/reseller/notifications/read'){db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE account_id=?').run(new Date().toISOString(),account.id);return json(res,200,{success:true});}
        if(req.method==='GET'&&path==='/api/reseller/customer-directory'){
          const q=String(url.searchParams.get('q')||'').trim(),like=`%${q}%`;
          if(q.length<3)return json(res,400,{error:'SEARCH_QUERY_TOO_SHORT'});
          const rows=db.prepare(`SELECT a.id,a.name,a.phone,COALESCE(w.balance_toman,0) balance_toman FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id WHERE a.role='customer' AND a.status='active' AND (?='' OR a.name LIKE ? OR a.phone LIKE ?) ORDER BY a.updated_at DESC LIMIT 80`).all(q,like,like);
          return json(res,200,rows);
        }
        const resellerWalletTransfer=path.match(/^\/api\/reseller\/customers\/([^/]+)\/wallet$/);
        if(resellerWalletTransfer&&req.method==='POST'){
          const target=db.prepare("SELECT id,name,phone FROM accounts WHERE id=? AND role='customer' AND status='active'").get(resellerWalletTransfer[1]);
          const body=await readJson(req),amount=Number(body.amountToman),note=String(body.note||'شارژ توسط همکار فروش').trim();
          if(!target)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});if(!Number.isInteger(amount)||amount<=0)return json(res,400,{error:'INVALID_AMOUNT'});
          const transferId=randomUUID();try{
            const moved=transferWalletBalance(db,{fromAccountId:account.id,toAccountId:target.id,amountToman:amount,reference:`reseller-wallet:${transferId}`,actor:account.id,fromNote:`شارژ کیف پول ${target.phone}`,toNote:note,onTransfer:result=>{attachExistingCustomerToReseller(db,account.id,target,result.createdAt);db.prepare("INSERT INTO reseller_wallet_transfers(id,reseller_id,customer_account_id,amount_toman,note,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)").run(transferId,account.id,target.id,amount,note,result.createdAt,result.createdAt);}});
            notify(target.id,'کیف پول شارژ شد',`${amount.toLocaleString('fa-IR')} تومان توسط همکار فروش به کیف پول شما افزوده شد.`);audit(account.id,'wallet_transfer','customer',target.id,{transferId,amount,note});return json(res,201,{transferId,balanceToman:moved.toBalanceToman,resellerBalanceToman:moved.fromBalanceToman});
          }catch(e){return json(res,400,{error:e.message});}
        }
        const resellerWalletReversal=path.match(/^\/api\/reseller\/wallet-transfers\/([^/]+)\/reverse$/);
        if(resellerWalletReversal&&req.method==='POST'){
          const transfer=db.prepare("SELECT t.*,a.name customer_name,a.phone customer_phone FROM reseller_wallet_transfers t JOIN accounts a ON a.id=t.customer_account_id WHERE t.id=? AND t.reseller_id=? AND t.status IN ('active','partially_reversed')").get(resellerWalletReversal[1],account.id);
          if(!transfer)return json(res,404,{error:'WALLET_TRANSFER_NOT_FOUND'});
          const body=await readJson(req),remaining=transfer.amount_toman-transfer.reversed_amount_toman,amount=body.amountToman===undefined?remaining:Number(body.amountToman),reason=String(body.reason||'برگشت شارژ توسط همکار فروش').trim();
          if(!Number.isInteger(amount)||amount<=0||amount>remaining)return json(res,400,{error:'INVALID_REVERSAL_AMOUNT'});
          try{
            const reversalId=randomUUID(),moved=transferWalletBalance(db,{fromAccountId:transfer.customer_account_id,toAccountId:account.id,amountToman:amount,reference:`reseller-wallet-reversal:${reversalId}`,actor:account.id,fromNote:reason,toNote:`برگشت شارژ ${transfer.customer_phone}`,onTransfer:result=>{const reversed=transfer.reversed_amount_toman+amount,status=reversed===transfer.amount_toman?'reversed':'partially_reversed';db.prepare('UPDATE reseller_wallet_transfers SET reversed_amount_toman=?,status=?,updated_at=? WHERE id=?').run(reversed,status,result.createdAt,transfer.id);}});
            notify(transfer.customer_account_id,'اصلاح کیف پول',`${amount.toLocaleString('fa-IR')} تومان از شارژ ثبت‌شده توسط همکار فروش برگشت داده شد. ${reason}`);audit(account.id,'reverse_wallet_transfer','customer',transfer.customer_account_id,{transferId:transfer.id,reversalId,amount,reason});return json(res,200,{transferId:transfer.id,reversedAmountToman:transfer.reversed_amount_toman+amount,remainingAmountToman:remaining-amount,balanceToman:moved.fromBalanceToman,resellerBalanceToman:moved.toBalanceToman});
          }catch(e){return json(res,400,{error:e.message});}
        }
        const resellerDebt=path.match(/^\/api\/reseller\/customers\/([^/]+)\/debts$/);
        if(resellerDebt&&req.method==='POST'){
          const customer=db.prepare("SELECT id,name,phone FROM accounts WHERE id=? AND role='customer' AND status='active'").get(resellerDebt[1]);
          const body=await readJson(req),amount=Number(body.amountToman),note=String(body.note||'').trim();
          if(!customer)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});if(!Number.isInteger(amount)||amount<=0||note.length<3)return json(res,400,{error:'INVALID_DEBT'});
          const now=new Date().toISOString(),id=randomUUID();db.prepare("INSERT INTO reseller_debts(id,reseller_id,customer_account_id,amount_toman,note,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(id,account.id,customer.id,amount,note,now,now);attachExistingCustomerToReseller(db,account.id,customer,now);notify(customer.id,'بدهی جدید به همکار فروش',`${amount.toLocaleString('fa-IR')} تومان · ${note}`);audit(account.id,'create','reseller_debt',id,{customerId:customer.id,amount});return json(res,201,{id,status:'open'});
        }
        const resellerDebtAction=path.match(/^\/api\/reseller\/debts\/([^/]+)\/(settle|cancel)$/);
        if(resellerDebtAction&&req.method==='POST'){
          const debt=db.prepare("SELECT d.*,a.name customer_name FROM reseller_debts d JOIN accounts a ON a.id=d.customer_account_id WHERE d.id=? AND d.reseller_id=? AND d.status IN ('open','payment_reported')").get(resellerDebtAction[1],account.id);if(!debt)return json(res,404,{error:'DEBT_NOT_FOUND'});const now=new Date().toISOString(),action=resellerDebtAction[2];db.prepare("UPDATE reseller_debts SET status=?,settled_at=?,settled_by=?,updated_at=? WHERE id=?").run(action==='settle'?'settled':'cancelled',now,account.id,now,debt.id);notify(debt.customer_account_id,action==='settle'?'پرداخت بدهی تأیید شد':'بدهی لغو شد',debt.note);audit(account.id,action,'reseller_debt',debt.id);return json(res,200,{status:action==='settle'?'settled':'cancelled'});
        }
        if(req.method==='GET'&&path==='/api/reseller/tickets'){const tickets=db.prepare(`SELECT t.*,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t WHERE account_id=? AND owner_archived_at IS NULL ORDER BY updated_at DESC`).all(account.id);return json(res,200,tickets);}
        if(req.method==='POST'&&path==='/api/reseller/tickets'){const b=await readJson(req),subject=String(b.subject||'').trim(),body=String(b.body||'').trim();if(subject.length<3||body.length<3)return json(res,400,{error:'INVALID_TICKET'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO support_tickets(id,account_id,subject,status,created_at,updated_at) VALUES(?,?,?,'open',?,?)`).run(id,account.id,subject,now,now);db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),id,body,now);return json(res,201,{id,status:'open'});}
        const resellerTicket=path.match(/^\/api\/reseller\/tickets\/([^/]+)$/);if(resellerTicket&&req.method==='GET'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=? AND account_id=?').get(resellerTicket[1],account.id);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(resellerTicket&&req.method==='POST'){const ticket=db.prepare("SELECT * FROM support_tickets WHERE id=? AND account_id=? AND status<>'closed'").get(resellerTicket[1],account.id),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'customer',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='open',owner_archived_at=NULL,updated_at=? WHERE id=?").run(now,ticket.id);return json(res,201,{sent:true});}
        if(req.method==='DELETE'&&path==='/api/reseller/notifications'){const now=new Date().toISOString(),result=db.prepare('UPDATE notifications SET dismissed_at=?,read_at=COALESCE(read_at,?) WHERE account_id=? AND dismissed_at IS NULL').run(now,now,account.id);return json(res,200,{cleared:Number(result.changes)});}
        if(req.method==='DELETE'&&path==='/api/reseller/tickets'){const now=new Date().toISOString(),result=db.prepare('UPDATE support_tickets SET owner_archived_at=? WHERE account_id=? AND owner_archived_at IS NULL').run(now,account.id);return json(res,200,{cleared:Number(result.changes)});}
        const resellerCustomerMatch=path.match(/^\/api\/reseller\/customers\/([^/]+)$/);
        if(resellerCustomerMatch&&req.method==='GET'){
          const customer=db.prepare("SELECT rc.*,CASE WHEN a.managed_by_reseller_id=rc.reseller_id THEN 1 ELSE 0 END password_managed FROM reseller_customers rc LEFT JOIN accounts a ON a.id=rc.account_id WHERE rc.id=? AND rc.reseller_id=? AND rc.status='active'").get(resellerCustomerMatch[1],account.id);if(!customer)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});
          const panelStats=await readPanelStats(),rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.bundle_id,o.bundle_index,o.bundle_size,o.customer_name,o.phone,o.status,o.created_at,o.amount_transferred_irr,o.reseller_sale_price_toman,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.panel_client_id,l.name location_name,l.country_code,l.flag_emoji,l.city,${locationSequenceSql} location_sequence FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.reseller_id=? AND o.reseller_customer_id=? ORDER BY o.created_at DESC LIMIT 200`).all(account.id,customer.id);
          const walletBalanceToman=customer.account_id?getWalletStatement(db,customer.account_id,1).balanceToman:0;
          const walletTransfers=customer.account_id?db.prepare('SELECT id,amount_toman,reversed_amount_toman,note,status,created_at,updated_at FROM reseller_wallet_transfers WHERE reseller_id=? AND customer_account_id=? ORDER BY created_at DESC LIMIT 100').all(account.id,customer.account_id):[];
          const debts=customer.account_id?db.prepare("SELECT id,amount_toman,note,status,created_at,payment_reported_at,settled_at FROM reseller_debts WHERE reseller_id=? AND customer_account_id=? ORDER BY created_at DESC LIMIT 100").all(account.id,customer.account_id):[];
          return json(res,200,{...customer,walletBalanceToman,walletTransfers,debts,orders:rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats))});
        }
        if(resellerCustomerMatch&&req.method==='PATCH'){
          const current=db.prepare("SELECT * FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(resellerCustomerMatch[1],account.id);if(!current)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});const body=await readJson(req),customer=resellerCustomerFromBody({...body,phone:normalizePhone(body.phone)});if(customer.name.length<2||!/^09\d{9}$/.test(customer.phone))return json(res,400,{error:'INVALID_CUSTOMER'});
          const duplicate=db.prepare('SELECT id FROM reseller_customers WHERE reseller_id=? AND phone=? AND id<>?').get(account.id,customer.phone,current.id);if(duplicate)return json(res,409,{error:'CUSTOMER_ALREADY_EXISTS'});
          const linked=current.account_id?db.prepare("SELECT id,managed_by_reseller_id FROM accounts WHERE id=? AND role='customer'").get(current.account_id):null;
          if(linked&&linked.managed_by_reseller_id!==account.id&&customer.phone!==current.phone)return json(res,403,{error:'CUSTOMER_PHONE_NOT_MANAGED'});
          if(linked?.managed_by_reseller_id===account.id&&db.prepare('SELECT id FROM accounts WHERE phone=? AND id<>?').get(customer.phone,linked.id))return json(res,409,{error:'PHONE_ALREADY_EXISTS'});
          const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE reseller_customers SET name=?,phone=?,note=?,updated_at=? WHERE id=?').run(customer.name,customer.phone,customer.note,now,current.id);db.prepare('UPDATE orders SET customer_name=?,phone=? WHERE reseller_customer_id=?').run(customer.name,customer.phone,current.id);if(linked?.managed_by_reseller_id===account.id)db.prepare('UPDATE accounts SET name=?,phone=?,updated_at=? WHERE id=?').run(customer.name,customer.phone,now,linked.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');return json(res,409,{error:'CUSTOMER_UPDATE_FAILED'});}audit(account.id,'update','reseller_customer',current.id);return json(res,200,{id:current.id,...customer,updated_at:now});
        }
        if(resellerCustomerMatch&&req.method==='DELETE'){
          const current=db.prepare("SELECT id FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(resellerCustomerMatch[1],account.id);if(!current)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});db.prepare("UPDATE reseller_customers SET status='archived',updated_at=? WHERE id=?").run(new Date().toISOString(),current.id);audit(account.id,'archive','reseller_customer',current.id);return json(res,200,{archived:true});
        }
        if(req.method==='GET'&&path==='/api/reseller/orders'){
          const panelStats=await readPanelStats(),rows=db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.bundle_id,o.bundle_index,o.bundle_size,o.reseller_customer_id,o.customer_name,o.phone,o.status,o.created_at,o.amount_transferred_irr,o.reseller_sale_price_toman,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.panel_client_id,s.provision_error,l.name location_name,l.country_code,l.flag_emoji,l.city,${locationSequenceSql} location_sequence FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.reseller_id=? ORDER BY o.created_at DESC LIMIT 300`).all(account.id);return json(res,200,rows.map(row=>enrichSubscription(exposeSubscription(req,row),panelStats)));
        }
        const renewMatch=path.match(/^\/api\/reseller\/orders\/([^/]+)\/renew$/);
        if(req.method==='POST'&&renewMatch){
          const body=await readJson(req);
          const original=db.prepare(`SELECT o.*,p.name plan_name,p.price_irr,p.traffic_gb,p.duration_days,p.device_limit,s.panel_client_id,s.subscription_url,s.upstream_subscription_url,s.access_token subscription_access_token FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.reseller_id=? AND o.order_kind='purchase' AND s.status='active'`).get(renewMatch[1],account.id);
          if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
          const override=db.prepare('SELECT price_toman FROM reseller_plan_prices WHERE reseller_id=? AND plan_id=? AND active=1').get(account.id,original.plan_id),price=override?.price_toman??Math.round((original.price_irr/10)*(100-account.default_discount_percent)/100);
          const salePrice=Number.isInteger(body.salePriceToman)&&body.salePriceToman>=0?body.salePriceToman:(original.reseller_sale_price_toman??Math.round(original.price_irr/10)),id=randomUUID(),now=new Date().toISOString();try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`reseller-renew:${id}`,actor:account.id,note:`تمدید ${original.plan_name} برای ${original.phone}`});}catch(e){return json(res,400,{error:e.message});}
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,reseller_id,account_id,location_id,order_kind,parent_order_id,reseller_customer_id,reseller_sale_price_toman) VALUES(?,?,?,?,'approved',?,?,?,?,?,?,'renewal',?,?,?)`).run(id,original.customer_name,original.phone,original.plan_id,price*10,now,randomUUID().replace(/-/g,''),account.id,original.account_id||null,original.location_id,original.id,original.reseller_customer_id,salePrice);
          const sid=randomUUID();db.prepare(`INSERT INTO subscriptions(id,order_id,status,panel_client_id,subscription_url,upstream_subscription_url,created_at) VALUES(?,?,'pending_provision',?,?,?,?)`).run(sid,id,original.panel_client_id,original.subscription_url,original.upstream_subscription_url||original.subscription_url,now);
          const renewalLocation=db.prepare('SELECT * FROM service_locations WHERE id=?').get(original.location_id),renewalProvisioner=provisionerForLocation(renewalLocation);
          try{if(!renewalProvisioner?.renew)throw new Error('RENEW_NOT_SUPPORTED');await renewalProvisioner.renew({panelClientId:original.panel_client_id,addDays:original.duration_days,addTrafficGb:original.traffic_gb});db.prepare("UPDATE subscriptions SET status='active',activated_at=? WHERE id=?").run(new Date().toISOString(),sid);notify(account.id,'تمدید موفق',`${original.plan_name} برای ${original.customer_name} تمدید شد.`);if(original.account_id)notify(original.account_id,'اشتراک تمدید شد',`اشتراک ${original.plan_name} توسط همکار فروش تمدید شد.`);return json(res,201,{orderId:id,status:'active',subscriptionUrl:publicSubscriptionUrl(req,original.subscription_access_token,original.subscription_url),balanceToman:getWalletStatement(db,account.id,1).balanceToman});}
          catch(e){db.prepare("UPDATE subscriptions SET status='failed',provision_error=? WHERE id=?").run(String(e.message||e),sid);postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`reseller-renew-refund:${id}`,actor:'system',note:`بازپرداخت تمدید ناموفق ${id}`});return json(res,502,{error:'RENEW_FAILED',refunded:true});}
        }
        const controlMatch=path.match(/^\/api\/reseller\/orders\/([^/]+)\/(suspend|resume|delete)$/);
        if(req.method==='POST'&&controlMatch){
          const body=await readJson(req),action=controlMatch[2],row=db.prepare(`SELECT o.id,o.account_id,o.location_id,o.customer_name,s.id subscription_id,s.status,s.control_status,s.panel_client_id FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.reseller_id=? AND o.order_kind='purchase'`).get(controlMatch[1],account.id);if(!row)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
          const reason=String(body.reason||'').trim();if(action==='suspend'&&reason.length<3)return json(res,400,{error:'SUSPENSION_REASON_REQUIRED'});if(action==='delete'&&body.confirm!==true)return json(res,400,{error:'DELETE_CONFIRMATION_REQUIRED'});
          const currentControl=row.control_status||'active';if(row.status!=='active'||currentControl==='deleted'||(action==='suspend'&&currentControl!=='active')||(action==='resume'&&currentControl!=='suspended'))return json(res,409,{error:'INVALID_SUBSCRIPTION_STATE'});
          const controlLocation=db.prepare('SELECT * FROM service_locations WHERE id=?').get(row.location_id),controlProvisioner=provisionerForLocation(controlLocation);
          try{if(action==='suspend'){if(!controlProvisioner?.suspend)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.suspend({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='suspended',suspension_reason=?,suspended_at=? WHERE id=?").run(reason,new Date().toISOString(),row.subscription_id);}else if(action==='resume'){if(!controlProvisioner?.resume)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.resume({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='active',suspension_reason=NULL,suspended_at=NULL WHERE id=?").run(row.subscription_id);}else{if(!controlProvisioner?.remove)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.remove({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='deleted',deleted_at=?,suspension_reason=? WHERE id=?").run(new Date().toISOString(),reason||'حذف توسط همکار',row.subscription_id);}if(row.account_id)notify(row.account_id,action==='suspend'?'اشتراک تعلیق شد':action==='resume'?'اشتراک فعال شد':'اشتراک حذف شد',reason||'درخواست توسط همکار فروش انجام شد.');audit(account.id,action,'subscription',row.subscription_id,{reason});return json(res,200,{status:action==='resume'?'active':action==='suspend'?'suspended':'deleted'});}catch(e){return json(res,502,{error:'PANEL_CONTROL_FAILED',detail:String(e.message||e)});}
        }
        if(req.method==='POST'&&path==='/api/reseller/purchase'){
          const b=await readJson(req),plan=db.prepare(`SELECT p.*,r.price_toman reseller_price FROM plans p LEFT JOIN reseller_plan_prices r ON r.plan_id=p.id AND r.reseller_id=? AND r.active=1 WHERE p.id=? AND p.active=1`).get(account.id,b.planId);
          if(!plan)return json(res,400,{error:'INVALID_PURCHASE'});let customer;
          if(b.customerId)customer=db.prepare("SELECT * FROM reseller_customers WHERE id=? AND reseller_id=? AND status='active'").get(b.customerId,account.id);
          else if(b.customerAccountId){const existing=db.prepare("SELECT id,name,phone FROM accounts WHERE id=? AND role='customer' AND status='active'").get(b.customerAccountId);if(existing)customer=attachExistingCustomerToReseller(db,account.id,existing);}
          else try{customer=createOrRestoreResellerCustomer(db,account.id,b);}catch{return json(res,400,{error:'INVALID_CUSTOMER'});}
          if(!customer)return json(res,404,{error:'CUSTOMER_NOT_FOUND'});
          const locations=purchaseLocationsForPlan(plan);if(!locations)return json(res,409,{error:'NO_CAPACITY',requiredLocations:plan.location_mode==='multi'?Number(plan.bundle_size)||3:1});
          const price=plan.reseller_price??Math.round((plan.price_irr/10)*(100-account.default_discount_percent)/100),salePrice=Number.isInteger(b.salePriceToman)&&b.salePriceToman>=0?b.salePriceToman:Math.round(plan.price_irr/10),bundleId=locations.length>1?randomUUID():null,now=new Date().toISOString(),entries=locations.map((location,index)=>({id:randomUUID(),subscriptionId:randomUUID(),accessToken:subscriptionToken(),trackingToken:randomUUID().replace(/-/g,''),location,phone:customer.phone,index:index+1})),primary=entries[0];
          try{postWalletTransaction(db,{accountId:account.id,amountToman:-price,type:'purchase',reference:`reseller-order:${primary.id}`,actor:account.id,note:`خرید ${plan.name}${locations.length>1?` (${locations.length} لوکیشن)`:''} برای ${customer.phone}`});}catch(e){return json(res,400,{error:e.message});}
          try{db.exec('BEGIN IMMEDIATE');for(const entry of entries){db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,created_at,tracking_token,reseller_id,account_id,location_id,reseller_customer_id,reseller_sale_price_toman,bundle_id,bundle_index,bundle_size) VALUES(?,?,?,?,'approved',?,?,?,?,?,?,?,?,?,?,?)`).run(entry.id,customer.name,customer.phone,plan.id,entry.index===1?price*10:0,now,entry.trackingToken,account.id,customer.account_id||null,entry.location.id,customer.id,entry.index===1?salePrice:0,bundleId,entry.index,entries.length);db.prepare(`INSERT INTO subscriptions(id,order_id,status,access_token,created_at) VALUES(?,?,'pending_provision',?,?)`).run(entry.subscriptionId,entry.id,entry.accessToken,now);}db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK')}catch{}postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`reseller-refund:${primary.id}`,actor:'system',note:'بازپرداخت ثبت ناموفق خرید'});throw error;}
          const provisioned=await provisionPurchaseEntries(plan,entries);if(!provisioned.ok){postWalletTransaction(db,{accountId:account.id,amountToman:price,type:'refund',reference:`reseller-refund:${primary.id}`,actor:'system',note:`بازپرداخت خرید ناموفق ${primary.id}`});return json(res,502,{error:'PROVISION_FAILED',refunded:true});}
          const subscriptions=provisioned.items.map(item=>({orderId:item.id,locationId:item.location.id,locationName:item.location.name,subscriptionUrl:publicSubscriptionUrl(req,item.accessToken,item.upstreamUrl)}));notify(account.id,'فروش موفق',locations.length>1?`${locations.length} اشتراک ${plan.name} برای ${customer.name} ساخته شد.`:`${plan.name} برای ${customer.name} ساخته شد.`);if(customer.account_id)notify(customer.account_id,'اشتراک فعال شد',locations.length>1?`${locations.length} اشتراک پلن ${plan.name} توسط همکار فروش برای شما فعال شد.`:`پلن ${plan.name} توسط همکار فروش برای شما فعال شد.`);return json(res,201,{orderId:primary.id,orderIds:entries.map(entry=>entry.id),bundleId,customerId:customer.id,status:'active',subscriptionCount:subscriptions.length,subscriptions,subscriptionUrl:subscriptions[0].subscriptionUrl,balanceToman:getWalletStatement(db,account.id,1).balanceToman});
        }
      }

      if (req.method === 'POST' && path === '/api/receipts') {
        const uploader=accountFromRequest(db,req);
        if(req.headers.authorization&&!uploader)return json(res,401,{error:'UNAUTHORIZED'});
        if(uploader&&!['customer','reseller','staff'].includes(uploader.role))return json(res,403,{error:'RECEIPT_UPLOAD_FORBIDDEN'});
        const uploadLimit=uploader?accountReceiptLimiter(uploader.id):guestReceiptLimiter(requestIp(req));
        res.setHeader('x-ratelimit-limit',uploadLimit.limit);res.setHeader('x-ratelimit-remaining',uploadLimit.remaining);
        if(uploadLimit.blocked){res.setHeader('retry-after',uploadLimit.retryAfterSeconds);return json(res,429,{error:'RECEIPT_RATE_LIMITED'});}
        await cleanupOrphanReceiptUploads(db);
        let b;
        try{b=await readJson(req,5_700_000);}catch(error){return json(res,error.message==='BODY_TOO_LARGE'?413:400,{error:error.message==='BODY_TOO_LARGE'?'RECEIPT_TOO_LARGE':'INVALID_RECEIPT'});}
        if(!b||Array.isArray(b)||typeof b!=='object')return json(res,400,{error:'INVALID_RECEIPT'});
        const bytes=decodeReceiptBase64(b.data);
        if(!bytes)return json(res,400,{error:'INVALID_RECEIPT'});
        if(bytes.length>4*1024*1024)return json(res,413,{error:'RECEIPT_TOO_LARGE'});
        // Android camera/gallery providers sometimes report a stale or generic
        // MIME type (for example JPEG for a PNG screenshot). Trust the verified
        // file signature, not client metadata; the stored extension/MIME below
        // always comes from this server-side detection.
        const detected=receiptType(bytes);
        if(!detected)return json(res,400,{error:'INVALID_RECEIPT_TYPE'});
        await mkdir(resolve('receipts'), { recursive:true });
        const name = `${randomUUID()}.${detected.extension}`,accessToken=randomBytes(32).toString('base64url');
        try{
          db.exec('BEGIN IMMEDIATE');
          const usage=db.prepare(`SELECT COUNT(*) total_count,COALESCE(SUM(byte_size),0) total_bytes,
            SUM(CASE WHEN linked_entity_type IS NULL AND linked_entity_id IS NULL THEN 1 ELSE 0 END) unlinked_count,
            COALESCE(SUM(CASE WHEN linked_entity_type IS NULL AND linked_entity_id IS NULL THEN byte_size ELSE 0 END),0) unlinked_bytes
            FROM receipt_uploads`).get();
          if(Number(usage.total_count)>=MAX_TOTAL_RECEIPTS||Number(usage.total_bytes)+bytes.length>MAX_TOTAL_RECEIPT_BYTES||
             Number(usage.unlinked_count)>=MAX_UNLINKED_RECEIPTS||Number(usage.unlinked_bytes)+bytes.length>MAX_UNLINKED_RECEIPT_BYTES)
            throw new PaymentRequestError('RECEIPT_STORAGE_BUSY',503);
          db.prepare('INSERT INTO receipt_uploads(filename,account_id,access_token_hash,mime_type,byte_size,created_at) VALUES(?,?,?,?,?,?)').run(name,uploader?.id||null,createHash('sha256').update(accessToken).digest('hex'),detected.mimeType,bytes.length,new Date().toISOString());
          db.exec('COMMIT');
        }catch(error){try{db.exec('ROLLBACK')}catch{}if(error instanceof PaymentRequestError)return json(res,error.status,{error:error.code});return json(res,500,{error:'RECEIPT_STORAGE_FAILED'});}
        try{await writeFile(resolve('receipts', name), bytes, { flag:'wx' });}
        catch(error){let removable=false;try{await unlink(resolve('receipts',name));removable=true}catch(unlinkError){removable=unlinkError?.code==='ENOENT'}if(removable)db.prepare('DELETE FROM receipt_uploads WHERE filename=? AND linked_entity_type IS NULL').run(name);return json(res,500,{error:'RECEIPT_STORAGE_FAILED'});}
        return json(res, 201, { url:`/receipts/${name}?access=${encodeURIComponent(accessToken)}` });
      }

      // Private Nivora Bank Agent. Each event is authenticated independently,
      // time-bound and replay protected. Raw SMS text is never stored.
      if (req.method === 'POST' && path === '/api/webhooks/nivora-bank-agent') {
        const config=bankAgentConfig(req);
        if(!config.enabled||!config.agentId||!config.secret||!config.allowedSenders.length)return json(res,503,{error:'BANK_AGENT_DISABLED'});
        let body,event;
        try{body=await readJson(req,64_000);event=verifyBankAgentRequest({headers:req.headers,body,secret:config.secret,expectedAgentId:config.agentId});}
        catch(error){if(error instanceof BankAgentError)return json(res,error.status,{error:error.code});throw error;}
        const sender=event.sender.toLowerCase();
        if(!config.allowedSenders.includes(sender))return json(res,200,{accepted:true,ignored:true,reason:'SENDER'});
        try{
          db.exec('BEGIN IMMEDIATE');
          db.prepare("DELETE FROM bank_agent_nonces WHERE created_at<datetime('now','-1 day')").run();
          db.prepare('INSERT INTO bank_agent_nonces(agent_id,nonce,created_at) VALUES(?,?,?)').run(event.agentId,event.nonce,new Date().toISOString());
          db.exec('COMMIT');
        }catch(error){try{db.exec('ROLLBACK')}catch{}if(String(error.message).includes('UNIQUE'))return json(res,409,{error:'BANK_AGENT_REPLAY'});throw error;}
        const result=ingestBankMessage(db,{message:event.message,receivedAt:event.receivedAt,sender:event.sender,source:'nivora-agent',defaultUnit:autoReviewConfig().defaultSmsUnit,providerEventId:event.eventId,requireExplicitUnit:true});
        settingSet('bank_agent_last_event_at',new Date().toISOString());
        if(!result.duplicate)audit('nivora-bank-agent','ingest','bank_transaction',result.id,{eventId:event.eventId,usable:result.usable,direction:result.parsed.direction,amountRial:result.parsed.amountRial||0});
        if(result.usable)schedulePaymentSweep();
        return json(res,200,{accepted:true,duplicate:result.duplicate,usable:result.usable});
      }

      // Official httpSMS webhook. httpSMS signs a short-lived HS256 JWT whose
      // audience is the exact callback URL. Processing is queued after the 200
      // response so provider retries never wait on provisioning work.
      if (req.method === 'POST' && path === '/api/webhooks/httpsms') {
        const config=httpsmsConfig(req);
        if(!config.enabled||!config.signingKey||!config.expectedOwner||!config.allowedSenders.length)return json(res,503,{error:'HTTPSMS_DISABLED'});
        const bearer=String(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1]||'';
        let claims;
        try{claims=verifyHttpSmsJwt(bearer,{signingKey:config.signingKey,audience:config.webhookUrl,issuer:config.issuer,expectedSubject:config.expectedSubject});}
        catch(error){if(error instanceof HttpSmsWebhookError)return json(res,error.status,{error:error.code});throw error;}
        const eventType=String(req.headers['x-event-type']||'');
        if(eventType!==HTTPSMS_EVENT_TYPE)return json(res,200,{accepted:true,ignored:true,reason:'EVENT_TYPE'});
        let event;
        try{event=parseHttpSmsEvent(await readJson(req,256_000),{eventTypeHeader:eventType,expectedOwner:config.expectedOwner});}
        catch(error){if(error instanceof HttpSmsWebhookError)return json(res,error.status,{accepted:error.status===200,ignored:error.status===200,error:error.code});throw error;}
        if(claims.sub!==event.userId)return json(res,401,{error:'HTTPSMS_EVENT_SUBJECT_MISMATCH'});
        if(config.expectedSim&&event.sim!==config.expectedSim)return json(res,200,{accepted:true,ignored:true,reason:'SIM'});
        const sender=event.sender.toLowerCase();
        if(config.allowedSenders.length&&!config.allowedSenders.includes(sender))return json(res,200,{accepted:true,ignored:true,reason:'SENDER'});
        const result=ingestBankMessage(db,{
          message:event.message,
          receivedAt:event.receivedAt,
          sender:event.sender,
          source:'httpsms',
          defaultUnit:autoReviewConfig().defaultSmsUnit,
          providerEventId:event.eventId,
          providerMessageId:event.messageId,
          destination:event.owner,
          forceIgnored:event.encrypted,
          requireExplicitUnit:true
        });
        settingSet('httpsms_last_event_at',new Date().toISOString());
        settingSet('httpsms_last_event_id',event.eventId);
        if(!result.duplicate)audit('httpsms','ingest','bank_transaction',result.id,{eventId:event.eventId,owner:event.owner,sim:event.sim,encrypted:event.encrypted,usable:result.usable,direction:result.parsed.direction,amountRial:result.parsed.amountRial||0});
        if(result.usable)schedulePaymentSweep();
        return json(res,200,{accepted:true,duplicate:result.duplicate,usable:result.usable});
      }

      // Bank-SMS ingest webhook (called by an SMS-forwarder app on the phone holding the
      // receiving SIM). Authenticated by a shared secret, NOT the admin token.
      if (req.method === 'POST' && path === '/api/sms/ingest') {
        const secret = process.env.SMS_WEBHOOK_SECRET;
        if (!secret) return json(res, 503, { error: 'SMS_INGEST_DISABLED' });
        const provided = String(req.headers['x-webhook-secret'] || '');
        const expected=Buffer.from(secret),actual=Buffer.from(provided);
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(res,401,{error:'UNAUTHORIZED'});
        const b = await readJson(req);
        const message = String(b.message || b.text || '').trim();
        if (!message) return json(res, 400, { error: 'EMPTY_MESSAGE' });
        const result = ingestBankMessage(db, { message, receivedAt: b.receivedAt || b.timestamp, sender: b.sender || b.from || '', source: 'sms', defaultUnit: autoReviewConfig().defaultSmsUnit });
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

      if(req.method==='GET'&&path==='/api/admin/httpsms-settings'){
        const c=httpsmsConfig(req),review=autoReviewConfig();
        const latest=db.prepare("SELECT provider_event_id,source,status,direction,amount_rial,received_at,created_at FROM bank_transactions WHERE source='httpsms' ORDER BY created_at DESC LIMIT 1").get()||null;
        const counters=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END) matched,SUM(CASE WHEN status='unmatched' THEN 1 ELSE 0 END) unmatched,SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) ignored FROM bank_transactions WHERE source='httpsms'").get();
        return json(res,200,{enabled:c.enabled,webhookUrl:c.webhookUrl,eventType:HTTPSMS_EVENT_TYPE,issuer:c.issuer,expectedSubject:c.expectedSubject,expectedOwner:c.expectedOwner,expectedSim:c.expectedSim,allowedSenders:c.allowedSenders,signingKeyConfigured:Boolean(c.signingKey),signingKeyHint:c.signingKey?`…${c.signingKey.slice(-4)}`:'',autoReviewEnabled:review.enabled,allowAmountOnly:review.allowAmountOnly,amountToleranceRial:review.amountToleranceRial,lookbackHours:review.lookbackHours,defaultSmsUnit:review.defaultSmsUnit,lastEventAt:settingGet('httpsms_last_event_at')||null,latest,counters:{total:Number(counters.total||0),matched:Number(counters.matched||0),unmatched:Number(counters.unmatched||0),ignored:Number(counters.ignored||0)}});
      }
      if(req.method==='GET'&&path==='/api/admin/bank-agent-settings'){
        const c=bankAgentConfig(req),review=autoReviewConfig();
        const latest=db.prepare("SELECT provider_event_id,source,status,direction,amount_rial,received_at,created_at FROM bank_transactions WHERE source='nivora-agent' ORDER BY created_at DESC LIMIT 1").get()||null;
        const counters=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END) matched,SUM(CASE WHEN status='unmatched' THEN 1 ELSE 0 END) unmatched,SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) ignored FROM bank_transactions WHERE source='nivora-agent'").get();
        return json(res,200,{enabled:c.enabled,agentId:c.agentId,webhookUrl:c.webhookUrl,allowedSenders:c.allowedSenders,secretConfigured:Boolean(c.secret),secretHint:c.secret?`…${c.secret.slice(-4)}`:'',autoReviewEnabled:review.enabled,lastEventAt:settingGet('bank_agent_last_event_at')||null,latest,counters:{total:Number(counters.total||0),matched:Number(counters.matched||0),unmatched:Number(counters.unmatched||0),ignored:Number(counters.ignored||0)}});
      }
      if(req.method==='PATCH'&&path==='/api/admin/bank-agent-settings'){
        const body=await readJson(req),current=bankAgentConfig(req),enabled=typeof body.enabled==='boolean'?body.enabled:current.enabled;
        let senders=body.allowedSenders===undefined?current.allowedSenders:(Array.isArray(body.allowedSenders)?body.allowedSenders:String(body.allowedSenders).split(/[\n,]/));
        senders=[...new Set(senders.map(x=>String(x).trim().toLowerCase()).filter(Boolean))];
        if(senders.length>50||senders.some(x=>x.length>100))return json(res,400,{error:'INVALID_BANK_AGENT_SENDERS'});
        let agentId=current.agentId,secret=current.secret,generatedSecret='';
        if(body.rotateSecret===true||!agentId){agentId=`nba_${randomBytes(8).toString('hex')}`;generatedSecret=randomBytes(48).toString('base64url');secret=generatedSecret;}
        if(enabled&&(!agentId||!secret||!senders.length))return json(res,400,{error:'BANK_AGENT_SETUP_REQUIRED'});
        settingSet('bank_agent_enabled',enabled);settingSet('bank_agent_id',agentId);settingSet('bank_agent_allowed_senders',JSON.stringify(senders));if(secret)settingSet('bank_agent_secret',encrypt(secret));
        // Auto review remains exact and fail-closed. Receiptless matching is
        // allowed only for the signed first-party source and a unique amount.
        settingSet('auto_review_enabled',Boolean(enabled&&secret&&senders.length&&(body.autoReviewEnabled!==false)));
        settingSet('auto_review_allow_amount_only','true');settingSet('auto_review_trusted_agent_only','true');settingSet('auto_review_amount_tolerance_rial','0');
        audit('admin','update','bank_agent_settings',agentId,{enabled,allowedSenderCount:senders.length,secretChanged:Boolean(generatedSecret)});
        return json(res,200,{saved:true,agentId,webhookUrl:bankAgentConfig(req).webhookUrl,...(generatedSecret?{generatedSecret}: {})});
      }
      if(req.method==='PATCH'&&path==='/api/admin/httpsms-settings'){
        const body=await readJson(req),current=httpsmsConfig(req),currentReview=autoReviewConfig();
        const enabled=typeof body.enabled==='boolean'?body.enabled:current.enabled;
        const issuer=String(body.issuer??current.issuer).trim(),subject=String(body.expectedSubject??current.expectedSubject).trim(),owner=normalizeHttpSmsOwner(body.expectedOwner??current.expectedOwner),sim=String(body.expectedSim??current.expectedSim).trim().toUpperCase();
        if(!/^[A-Za-z0-9._:/-]{3,200}$/.test(issuer)||subject.length>200||(owner&&!/^\+\d{8,15}$/.test(owner))||!['','SIM1','SIM2'].includes(sim))return json(res,400,{error:'INVALID_HTTPSMS_SETTINGS'});
        let senders=body.allowedSenders===undefined?current.allowedSenders:(Array.isArray(body.allowedSenders)?body.allowedSenders:String(body.allowedSenders).split(/[\n,]/));
        senders=[...new Set(senders.map(x=>String(x).trim().toLowerCase()).filter(Boolean))];
        if(senders.length>50||senders.some(x=>x.length>100))return json(res,400,{error:'INVALID_HTTPSMS_SENDERS'});
        let signingKey=current.signingKey,generatedSigningKey='';
        if(body.rotateSigningKey===true){generatedSigningKey=randomBytes(48).toString('base64url');signingKey=generatedSigningKey;}
        else if(String(body.signingKey||'').trim())signingKey=String(body.signingKey).trim();
        if(signingKey&&(Buffer.byteLength(signingKey)<32||Buffer.byteLength(signingKey)>256))return json(res,400,{error:'INVALID_HTTPSMS_SIGNING_KEY'});
        if(enabled&&!signingKey)return json(res,400,{error:'HTTPSMS_SIGNING_KEY_REQUIRED'});
        if(enabled&&(!owner||!senders.length))return json(res,400,{error:'HTTPSMS_SOURCE_RESTRICTIONS_REQUIRED'});
        const currentPanelAutoEnabled=settingGet('auto_review_enabled')==='true';
        const requestedAutoEnabled=typeof body.autoReviewEnabled==='boolean'?body.autoReviewEnabled:currentPanelAutoEnabled;
        // Panel-managed auto-review is inseparable from the authenticated,
        // source-restricted httpSMS receiver. Disabling httpSMS always fails
        // closed; operators that intentionally use the legacy ingest route can
        // still opt in exclusively through environment configuration.
        const autoEnabled=Boolean(enabled&&signingKey&&owner&&senders.length&&requestedAutoEnabled);
        // The management flow deliberately keeps amount-only matching off. A
        // transaction without an exact receipt reference always stays manual.
        const allowAmountOnly=false;
        const requestedTolerance=body.amountToleranceRial===undefined?0:Number(body.amountToleranceRial),tolerance=0;
        const lookback=body.lookbackHours===undefined?currentReview.lookbackHours:Number(body.lookbackHours);
        const unit=String(body.defaultSmsUnit??currentReview.defaultSmsUnit);
        if(requestedTolerance!==0||!Number.isInteger(lookback)||lookback<1||lookback>24||!['rial','toman'].includes(unit))return json(res,400,{error:'INVALID_AUTO_REVIEW_SETTINGS'});
        settingSet('httpsms_enabled',enabled);settingSet('httpsms_issuer',issuer);settingSet('httpsms_expected_subject',subject);settingSet('httpsms_expected_owner',owner);settingSet('httpsms_expected_sim',sim);settingSet('httpsms_allowed_senders',JSON.stringify(senders));
        if(signingKey)settingSet('httpsms_signing_key',encrypt(signingKey));
        settingSet('auto_review_enabled',autoEnabled);settingSet('auto_review_allow_amount_only',allowAmountOnly);settingSet('auto_review_amount_tolerance_rial',tolerance);settingSet('auto_review_lookback_hours',lookback);settingSet('bank_sms_default_unit',unit);
        audit('admin','update','httpsms_settings','httpsms',{enabled,issuer,expectedOwner:owner,expectedSim:sim,allowedSenderCount:senders.length,autoReviewEnabled:autoEnabled,allowAmountOnly,amountToleranceRial:tolerance,lookbackHours:lookback,signingKeyChanged:Boolean(generatedSigningKey||String(body.signingKey||'').trim())});
        return json(res,200,{saved:true,webhookUrl:`${publicOrigin(req)}/api/webhooks/httpsms`,eventType:HTTPSMS_EVENT_TYPE,...(generatedSigningKey?{generatedSigningKey}: {})});
      }

      if(req.method==='GET'&&path==='/api/admin/emergency-settings'){
        return json(res,200,emergencyPool.status());
      }
      if(req.method==='PATCH'&&path==='/api/admin/emergency-settings'){
        const body=await readJson(req),current=emergencyConfig();
        let next;
        try{next=normalizeEmergencyConfig({
          enabled:typeof body.enabled==='boolean'?body.enabled:current.enabled,
          sources:body.sources===undefined?current.sources:body.sources,
          maxNodes:body.maxNodes===undefined?current.maxNodes:body.maxNodes,
          refreshMinutes:body.refreshMinutes===undefined?current.refreshMinutes:body.refreshMinutes
        });}catch(error){return json(res,error.status||400,{error:error.code||'INVALID_EMERGENCY_SETTINGS'});}
        settingSet('emergency_enabled',next.enabled);
        settingSet('emergency_sources',JSON.stringify(next.sources));
        settingSet('emergency_max_nodes',next.maxNodes);
        settingSet('emergency_refresh_minutes',next.refreshMinutes);
        if(current.enabled&&!next.enabled)settingSet('emergency_cache','');
        audit('admin','update','emergency_settings','pool',{enabled:next.enabled,sourceCount:next.sources.length,maxNodes:next.maxNodes,refreshMinutes:next.refreshMinutes});
        return json(res,200,{saved:true,...emergencyPool.status()});
      }
      if(req.method==='POST'&&path==='/api/admin/emergency-settings/refresh'){
        try{
          const status=await emergencyPool.refresh({allowDisabled:true,force:true});
          audit('admin','refresh','emergency_pool','pool',{nodeCount:status.nodeCount,accepted:status.accepted,rejected:status.rejected,sourceCount:status.sourceCount});
          return json(res,200,status);
        }catch(error){
          const code=error instanceof EmergencyPoolError?error.code:'EMERGENCY_REFRESH_FAILED';
          audit('admin','refresh_failed','emergency_pool','pool',{code});
          return json(res,error.status||503,{error:code});
        }
      }

      if(req.method==='GET'&&path==='/api/admin/telegram-settings'){
        const c=telegramConfig(),growth=db.prepare("SELECT COUNT(*) starts,COUNT(DISTINCT telegram_user_id) uniqueUsers FROM telegram_growth_events WHERE event_type='campaign_start'").get();return json(res,200,{enabled:c.enabled,username:c.username,channel:c.channel,latestReleaseUrl:c.latestReleaseUrl,adminIds:c.adminIds.join(','),groupIds:c.groupIds.join(','),groupAiEnabled:c.groupAiEnabled,groupAutoReply:c.groupAutoReply,publicContext:c.publicContext,growth,tokenConfigured:Boolean(c.token),tokenHint:c.token?`…${c.token.slice(-4)}`:'',webhookSecretConfigured:Boolean(c.secret),webhookUrl:'https://b.nivorali.com/api/telegram/webhook'});
      }
      if(req.method==='GET'&&path==='/api/admin/ai-settings'){
        const c=aiConfig();return json(res,200,{enabled:c.enabled,provider:'Hetzner Experiments',baseUrl:c.baseUrl,model:c.model,tokenConfigured:Boolean(c.token),tokenHint:c.token?`…${c.token.slice(-4)}`:'',experimental:true});
      }
      if(req.method==='PATCH'&&path==='/api/admin/ai-settings'){
        const b=await readJson(req),token=String(b.token||'').trim(),model=String(b.model??aiConfig().model).trim();
        if(token&&(token.length<20||token.length>500||/[\s]/.test(token)))return json(res,400,{error:'INVALID_AI_TOKEN'});
        if(!/^[A-Za-z0-9._\/-]{2,160}$/.test(model))return json(res,400,{error:'INVALID_AI_MODEL'});
        if(token)settingSet('ai_hetzner_token',encrypt(token));settingSet('ai_model',model);
        const configured=Boolean(token||aiConfig().token);if(b.enabled===true&&!configured)return json(res,400,{error:'AI_TOKEN_REQUIRED'});if(typeof b.enabled==='boolean')settingSet('ai_enabled',b.enabled);
        audit('admin','update','ai_settings','hetzner',{enabled:b.enabled===undefined?aiConfig().enabled:Boolean(b.enabled),model});return json(res,200,{saved:true,tokenConfigured:configured});
      }
      if(req.method==='POST'&&path==='/api/admin/ai-settings/test'){
        const c=aiConfig();if(!c.token)return json(res,400,{error:'AI_TOKEN_REQUIRED'});
        try{const response=await fetch(`${c.baseUrl}/models`,{headers:{authorization:`Bearer ${c.token}`,accept:'application/json'},signal:AbortSignal.timeout(15000)}),data=await response.json().catch(()=>({}));if(!response.ok)return json(res,response.status===401?401:502,{error:response.status===401?'INVALID_AI_TOKEN':'AI_PROVIDER_ERROR'});const models=Array.isArray(data.data)?data.data.map(item=>String(item?.id||'')).filter(Boolean).slice(0,50):[];settingSet('ai_last_checked_at',new Date().toISOString());return json(res,200,{connected:true,models,selectedModel:c.model,checkedAt:new Date().toISOString()});}catch(error){return json(res,503,{error:error?.name==='TimeoutError'?'AI_PROVIDER_TIMEOUT':'AI_PROVIDER_UNAVAILABLE'});}
      }
      if(req.method==='POST'&&path==='/api/admin/ai/draft-ticket'){
        const b=await readJson(req),ticket=db.prepare('SELECT id,subject,status FROM support_tickets WHERE id=?').get(String(b.ticketId||''));if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});
        const messages=db.prepare('SELECT sender_role,body FROM ticket_messages WHERE ticket_id=? ORDER BY created_at DESC LIMIT 12').all(ticket.id).reverse(),history=messages.map(message=>`${message.sender_role==='admin'?'پشتیبانی':'مشتری'}: ${message.body}`).join('\n\n');
        try{const draft=await aiCompletion({system:'شما دستیار پشتیبانی Nivora هستید. یک پاسخ کوتاه، محترمانه و کاربردی به زبان فارسی بنویسید. هیچ پرداخت، شارژ، تمدید، رفع محدودیت یا نتیجه فنی را قطعی اعلام نکنید. اگر اطلاعات کافی نیست، فقط اطلاعات لازم را از مشتری بخواهید. فقط متن پاسخ را برگردانید.',user:`موضوع: ${ticket.subject}\n\nگفتگو:\n${history}`,maxTokens:450});audit('admin','draft','ai_ticket',ticket.id,{model:aiConfig().model});return json(res,200,{draft});}catch(error){return json(res,error.status||503,{error:error.message||'AI_PROVIDER_UNAVAILABLE'});}
      }
      if(req.method==='POST'&&path==='/api/admin/ai/draft-announcement'){
        const b=await readJson(req),topic=String(b.topic||'').trim(),audience=['customer','reseller','all'].includes(b.audience)?b.audience:'all';if(topic.length<3||topic.length>800)return json(res,400,{error:'INVALID_AI_TOPIC'});
        try{const draft=await aiCompletion({system:'شما نویسنده اعلان‌های Nivora هستید. بر اساس موضوع، یک عنوان کوتاه و یک متن روشن و حرفه‌ای فارسی تولید کنید. اغراق، وعده قطعی و اطلاعات فنی حساس ننویسید. خروجی دقیقاً JSON با کلیدهای title و body باشد.',user:`مخاطب: ${audience}\nموضوع: ${topic}`,maxTokens:350});let parsed;try{parsed=JSON.parse(draft.replace(/^```(?:json)?|```$/g,'').trim())}catch{parsed={title:'اطلاعیه Nivora',body:draft}}const title=String(parsed.title||'اطلاعیه Nivora').trim().slice(0,100),body=String(parsed.body||'').trim().slice(0,1000);if(body.length<2)return json(res,502,{error:'AI_EMPTY_RESPONSE'});audit('admin','draft','ai_announcement',audience,{model:aiConfig().model});return json(res,200,{title,body});}catch(error){return json(res,error.status||503,{error:error.message||'AI_PROVIDER_UNAVAILABLE'});}
      }
      if(req.method==='POST'&&path==='/api/admin/ai/operations-summary'){
        const stats=operationsStats();
        try{const summary=await aiOperationsSummary();audit('admin','analyze','ai_operations','summary',{model:aiConfig().model});return json(res,200,{summary,stats,generatedAt:new Date().toISOString()});}catch(error){return json(res,error.status||503,{error:error.message||'AI_PROVIDER_UNAVAILABLE'});}
      }
      if(req.method==='POST'&&path==='/api/admin/ai/sales-advice'){
        const planStats=db.prepare(`SELECT p.name,p.price_irr/10 price_toman,COUNT(o.id) sales_count,COALESCE(SUM(o.amount_transferred_irr/10),0) revenue_toman FROM plans p LEFT JOIN orders o ON o.plan_id=p.id AND o.status='approved' AND o.created_at>=datetime('now','-30 day') WHERE p.active=1 GROUP BY p.id ORDER BY sales_count DESC,revenue_toman DESC LIMIT 12`).all();
        const funnel=db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE role='customer' AND created_at>=datetime('now','-30 day')) new_customers,(SELECT COUNT(*) FROM orders WHERE status='approved' AND created_at>=datetime('now','-30 day')) approved_orders,(SELECT COUNT(*) FROM orders WHERE status IN ('awaiting_receipt','under_review') AND created_at>=datetime('now','-30 day')) pending_orders,(SELECT COUNT(*) FROM wallet_topups WHERE status='approved' AND created_at>=datetime('now','-30 day')) approved_topups,(SELECT COUNT(*) FROM support_tickets WHERE created_at>=datetime('now','-30 day')) support_tickets`).get();
        try{const advice=await aiCompletion({system:'شما مشاور فروش Nivora هستید. فقط بر اساس آمار تجمیعی ۳۰ روزه، حداکثر ۶ پیشنهاد کوتاه، عملی و اخلاقی فارسی برای افزایش فروش و کاهش ریزش ارائه کنید. نام یا اطلاعات فردی نسازید، تخفیف یا درآمد قطعی وعده ندهید و تصمیم مالی خودکار نگیرید.',user:JSON.stringify({funnel,plans:planStats}),maxTokens:650});audit('admin','analyze','ai_sales','summary',{model:aiConfig().model});return json(res,200,{advice,generatedAt:new Date().toISOString()});}catch(error){return json(res,error.status||503,{error:error.message||'AI_PROVIDER_UNAVAILABLE'});}
      }
      if(req.method==='PATCH'&&path==='/api/admin/telegram-settings'){
        const b=await readJson(req);
        const channel=String(b.channel??'').trim(),releaseUrl=String(b.latestReleaseUrl??'').trim();
        const groupIds=String(b.groupIds??'').split(',').map(x=>x.trim()).filter(Boolean);
        if(channel&&!/^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(channel)&&!/^-[0-9]{6,}$/.test(channel))return json(res,400,{error:'INVALID_TELEGRAM_CHANNEL'});
        if(groupIds.some(x=>!(/^-\d{6,}$/.test(x))))return json(res,400,{error:'INVALID_TELEGRAM_GROUP_IDS'});
        if(releaseUrl){try{const u=new URL(releaseUrl);if(u.protocol!=='https:')throw new Error()}catch{return json(res,400,{error:'INVALID_RELEASE_URL'});}}
        if(typeof b.enabled==='boolean')settingSet('telegram_enabled',b.enabled);
        if(b.adminIds!==undefined)settingSet('telegram_admin_ids',String(b.adminIds).split(',').map(x=>x.trim()).filter(x=>/^\d+$/.test(x)).join(','));
        if(b.channel!==undefined)settingSet('telegram_channel',channel);
        if(b.groupIds!==undefined)settingSet('telegram_group_ids',groupIds.join(','));
        if(typeof b.groupAiEnabled==='boolean')settingSet('telegram_group_ai_enabled',b.groupAiEnabled);
        if(typeof b.groupAutoReply==='boolean')settingSet('telegram_group_auto_reply',b.groupAutoReply);
        if(b.publicContext!==undefined)settingSet('telegram_public_context',String(b.publicContext||'').trim().slice(0,3000));
        if(b.latestReleaseUrl!==undefined)settingSet('telegram_latest_release_url',releaseUrl);
        if(String(b.token||'').trim()){if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(b.token).trim()))return json(res,400,{error:'INVALID_TELEGRAM_TOKEN'});settingSet('telegram_token',encrypt(String(b.token).trim()));}
        if(b.rotateSecret===true||!telegramConfig().secret)settingSet('telegram_secret',encrypt(randomBytes(32).toString('base64url')));
        audit('admin','update','telegram_settings','telegram');return json(res,200,{saved:true});
      }
      if(req.method==='POST'&&path==='/api/admin/telegram-settings/webhook'){
        const c=telegramConfig();if(!c.enabled||!c.token||!c.secret)return json(res,400,{error:'TELEGRAM_SETTINGS_INCOMPLETE'});const me=await fetch(`https://api.telegram.org/bot${c.token}/getMe`).then(r=>r.json());if(!me.ok)return json(res,400,{error:'INVALID_TELEGRAM_TOKEN'});settingSet('telegram_username',me.result.username);const webhookUrl=`${String(process.env.PUBLIC_BASE_URL||`https://${req.headers.host}`).replace(/\/$/,``)}/api/telegram/webhook`,response=await fetch(`https://api.telegram.org/bot${c.token}/setWebhook`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:webhookUrl,secret_token:c.secret,allowed_updates:['message','callback_query','my_chat_member'],drop_pending_updates:false})}),data=await response.json();if(!response.ok||!data.ok)return json(res,502,{error:'TELEGRAM_WEBHOOK_FAILED',detail:data.description});settingSet('telegram_webhook_url',webhookUrl);return json(res,200,{connected:true,url:webhookUrl});
      }
      if(req.method==='GET'&&path==='/api/admin/telegram-settings/status'){
        const c=telegramConfig();if(!c.token)return json(res,200,{connected:false});const response=await fetch(`https://api.telegram.org/bot${c.token}/getWebhookInfo`),data=await response.json();return json(res,200,{connected:Boolean(data.ok&&data.result?.url),url:data.result?.url||'',pending:data.result?.pending_update_count||0,lastError:data.result?.last_error_message||''});
      }
      if(req.method==='POST'&&path==='/api/admin/telegram-settings/check-channel'){
        const c=telegramConfig();if(!c.token||!c.channel)return json(res,400,{error:'TELEGRAM_CHANNEL_NOT_SET'});const me=await fetch(`https://api.telegram.org/bot${c.token}/getMe`).then(r=>r.json());if(!me.ok)return json(res,400,{error:'INVALID_TELEGRAM_TOKEN'});const response=await fetch(`https://api.telegram.org/bot${c.token}/getChatMember?chat_id=${encodeURIComponent(c.channel)}&user_id=${encodeURIComponent(me.result.id)}`),data=await response.json();if(!data.ok)return json(res,400,{error:'TELEGRAM_CHANNEL_ACCESS_FAILED',detail:data.description||''});const member=data.result,canPost=member.status==='creator'||member.status==='administrator'&&member.can_post_messages!==false;return json(res,200,{connected:true,channel:c.channel,status:member.status,canPost});
      }
      if(req.method==='POST'&&path==='/api/admin/telegram-settings/publish'){
        const c=telegramConfig(),b=await readJson(req),message=String(b.message||'').trim(),releaseUrl=String(b.releaseUrl||c.latestReleaseUrl||'').trim(),linkText=String(b.linkText||'📥 دانلود آخرین نسخه Nivora').trim().slice(0,64);if(!c.token||!c.channel)return json(res,400,{error:'TELEGRAM_CHANNEL_NOT_SET'});if(message.length<1||message.length>3900)return json(res,400,{error:'INVALID_TELEGRAM_MESSAGE'});if(releaseUrl){try{const u=new URL(releaseUrl);if(u.protocol!=='https:')throw new Error()}catch{return json(res,400,{error:'INVALID_RELEASE_URL'});}}const payload={chat_id:c.channel,text:message,disable_web_page_preview:false};if(releaseUrl)payload.reply_markup={inline_keyboard:[[{text:linkText||'مشاهده',url:releaseUrl}]]};const response=await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),data=await response.json();if(!response.ok||!data.ok)return json(res,502,{error:'TELEGRAM_CHANNEL_PUBLISH_FAILED',detail:data.description||''});audit('admin','publish','telegram_channel',c.channel,{campaignCode:b.campaignCode||null});return json(res,200,{published:true});
      }

      if (req.method === 'GET' && path === '/api/admin/bank-transactions') {
        const status = url.searchParams.get('status');
        const select = 'SELECT id,amount_rial,CASE WHEN tracking_code IS NULL THEN NULL ELSE substr(tracking_code,-4) END tracking_suffix,card_last4,destination_card_last4,bank,direction,status,matched_order_id,matched_topup_id,source,received_at,created_at FROM bank_transactions';
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
      const topupReviewsMatch=path.match(/^\/api\/admin\/wallet-topups\/([^/]+)\/reviews$/);if(req.method==='GET'&&topupReviewsMatch)return json(res,200,db.prepare('SELECT * FROM wallet_topup_reviews WHERE topup_id=? ORDER BY created_at DESC LIMIT 50').all(topupReviewsMatch[1]));
      if(req.method==='GET'&&path==='/api/admin/financial-summary'){const sales=db.prepare(`SELECT COUNT(*) orders_count,COALESCE(SUM(amount_transferred_irr/10),0) sales_toman FROM orders WHERE status='approved'`).get(),wallets=db.prepare(`SELECT COALESCE(SUM(balance_toman),0) wallet_liability_toman FROM wallet_accounts`).get(),customers=db.prepare(`SELECT COUNT(*) customers_count FROM accounts WHERE role='customer'`).get(),pending=db.prepare(`SELECT COUNT(*) pending_topups,COALESCE(SUM(amount_toman),0) pending_topups_toman FROM wallet_topups WHERE status='under_review'`).get();return json(res,200,{...sales,...wallets,...customers,...pending});}
      const topupReview=path.match(/^\/api\/admin\/wallet-topups\/([^/]+)\/(approve|reject)$/);if(req.method==='POST'&&topupReview){const b=await readJson(req),topup=db.prepare(`SELECT t.*,a.name customer_name,a.phone FROM wallet_topups t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(topupReview[1]);if(!topup)return json(res,404,{error:'TOPUP_NOT_FOUND'});if(topup.status!=='under_review')return json(res,409,{error:'TOPUP_NOT_REVIEWABLE'});const now=new Date().toISOString(),action=topupReview[2];if(action==='reject'){const rejected=db.prepare("UPDATE wallet_topups SET status='rejected',review_note=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='under_review'").run(b.note||null,b.reviewedBy||'admin',now,topup.id);if(!rejected.changes)return json(res,409,{error:'TOPUP_NOT_REVIEWABLE'});audit('admin','reject','wallet_topup',topup.id,{note:b.note});return json(res,200,{id:topup.id,status:'rejected'});}try{const result=approveWalletTopup(db,topup.id,{actor:b.reviewedBy||'admin',note:b.note||'تأیید دستی مدیر',reason:b.note||'تأیید دستی مدیر'});notify(topup.account_id,'شارژ کیف پول تأیید شد',`${Number(topup.amount_toman).toLocaleString('fa-IR')} تومان به کیف پول شما افزوده شد.`);audit('admin','approve','wallet_topup',topup.id,{amountToman:topup.amount_toman});return json(res,200,{id:topup.id,status:'approved',balanceToman:result.balanceToman});}catch(error){return json(res,['TOPUP_NOT_REVIEWABLE','TOPUP_ALREADY_CREDITED'].includes(error.message)?409:400,{error:error.message});}}
      if(req.method==='GET'&&path==='/api/admin/discounts'){return json(res,200,db.prepare(`SELECT d.*,(SELECT COUNT(*) FROM discount_redemptions r WHERE r.discount_id=d.id) used_count,COALESCE((SELECT SUM(discount_toman) FROM discount_redemptions r WHERE r.discount_id=d.id),0) total_discount_toman FROM discount_codes d ORDER BY d.created_at DESC`).all());}
      if(req.method==='POST'&&path==='/api/admin/discounts'){const b=await readJson(req),code=String(b.code||'').trim().toUpperCase(),percent=Number(b.percent),maxUses=Math.max(Number(b.maxUses)||0,0),limit=Math.max(Number(b.perCustomerLimit)||1,1);if(!/^[A-Z0-9_-]{3,30}$/.test(code)||!Number.isInteger(percent)||percent<1||percent>100)return json(res,400,{error:'INVALID_DISCOUNT'});const id=randomUUID(),now=new Date().toISOString();try{db.prepare(`INSERT INTO discount_codes(id,code,percent,max_uses,per_customer_limit,expires_at,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`).run(id,code,percent,maxUses,limit,b.expiresAt||null,now,now);}catch{return json(res,409,{error:'DISCOUNT_EXISTS'});}return json(res,201,{id,code});}
      const discountMatch=path.match(/^\/api\/admin\/discounts\/([^/]+)$/);if(req.method==='PATCH'&&discountMatch){const old=db.prepare('SELECT * FROM discount_codes WHERE id=?').get(discountMatch[1]);if(!old)return json(res,404,{error:'DISCOUNT_NOT_FOUND'});const b=await readJson(req),percent=Number(b.percent??old.percent),maxUses=Number(b.maxUses??old.max_uses),limit=Number(b.perCustomerLimit??old.per_customer_limit);if(!Number.isInteger(percent)||percent<1||percent>100||maxUses<0||limit<1)return json(res,400,{error:'INVALID_DISCOUNT'});db.prepare('UPDATE discount_codes SET percent=?,max_uses=?,per_customer_limit=?,expires_at=?,active=?,updated_at=? WHERE id=?').run(percent,maxUses,limit,b.expiresAt??old.expires_at,(b.active??Boolean(old.active))?1:0,new Date().toISOString(),old.id);return json(res,200,{id:old.id});}
      if(req.method==='GET'&&path==='/api/admin/tickets'){return json(res,200,db.prepare(`SELECT t.*,a.name customer_name,a.phone,(SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1) last_message FROM support_tickets t JOIN accounts a ON a.id=t.account_id ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,t.updated_at DESC`).all());}
      if(req.method==='GET'&&path==='/api/admin/notifications'){
        const openTickets=db.prepare("SELECT COUNT(*) count FROM support_tickets WHERE status='open'").get().count;
        const pendingOrders=db.prepare("SELECT COUNT(*) count FROM orders WHERE status='under_review'").get().count;
        const pendingTopups=db.prepare("SELECT COUNT(*) count FROM wallet_topups WHERE status='under_review'").get().count;
        const pendingResets=db.prepare("SELECT COUNT(*) count FROM password_reset_requests WHERE status='pending'").get().count;
        const pendingDevices=db.prepare("SELECT COUNT(*) count FROM device_recovery_requests WHERE status='pending'").get().count;
        const latest=db.prepare(`SELECT 'ticket' type,t.subject title,a.name||' · '||COALESCE((SELECT body FROM ticket_messages WHERE ticket_id=t.id ORDER BY created_at DESC LIMIT 1),'') body,t.updated_at created_at
          FROM support_tickets t JOIN accounts a ON a.id=t.account_id WHERE t.status='open'
          UNION ALL SELECT 'order','پرداخت در انتظار بررسی',customer_name||' · '||phone,created_at FROM orders WHERE status='under_review'
          UNION ALL SELECT 'topup','شارژ کیف پول در انتظار بررسی',a.name||' · '||w.amount_toman||' تومان',w.created_at FROM wallet_topups w JOIN accounts a ON a.id=w.account_id WHERE w.status='under_review'
          UNION ALL SELECT 'device_recovery','درخواست آزادسازی دستگاه',a.name||' · '||a.phone,r.requested_at FROM device_recovery_requests r JOIN accounts a ON a.id=r.account_id WHERE r.status='pending'
          ORDER BY created_at DESC LIMIT 30`).all();
        return json(res,200,{counts:{openTickets,pendingOrders,pendingTopups,pendingResets,pendingDevices},items:latest});
      }
      if(req.method==='POST'&&path==='/api/admin/announcements'){
        const b=await readJson(req),title=String(b.title||'').trim(),body=String(b.body||'').trim(),audience=['customer','reseller','all'].includes(b.audience)?b.audience:'all';
        if(title.length<2||title.length>100||body.length<2||body.length>1000)return json(res,400,{error:'INVALID_ANNOUNCEMENT'});
        const roles=audience==='all'?['customer','reseller']:[audience],accounts=db.prepare(`SELECT id FROM accounts WHERE role IN (${roles.map(()=>'?').join(',')}) AND active=1`).all(...roles),now=new Date().toISOString();
        const insert=db.prepare('INSERT INTO notifications(id,account_id,title,body,created_at) VALUES(?,?,?,?,?)');
        db.transaction(()=>accounts.forEach(account=>insert.run(randomUUID(),account.id,title,body,now)))();
        audit('admin','broadcast','notification',audience,{title,recipients:accounts.length});return json(res,201,{sent:accounts.length});
      }
      if(req.method==='GET'&&path==='/api/admin/app-release'){
        const read=audience=>{const p=`android_${audience}_`;return {audience,versionCode:Number(settingGet(`${p}version_code`)||0),versionName:settingGet(`${p}version_name`)||'',downloadUrl:settingGet(`${p}download_url`)||'',releaseNotes:settingGet(`${p}release_notes`)||'',forceUpdate:settingGet(`${p}force_update`)==='true',publishedAt:settingGet(`${p}published_at`)||null}};
        return json(res,200,{customer:read('customer'),partner:read('partner')});
      }
      if(req.method==='PUT'&&path==='/api/admin/app-release'){
        const b=await readJson(req),audience=b.audience==='partner'?'partner':'customer',versionCode=Number(b.versionCode),versionName=String(b.versionName||'').trim(),downloadUrl=String(b.downloadUrl||'').trim(),notes=String(b.releaseNotes||'').trim();
        if(!Number.isInteger(versionCode)||versionCode<1||versionName.length<1||versionName.length>40||notes.length>2000)return json(res,400,{error:'INVALID_RELEASE'});
        try{const u=new URL(downloadUrl);if(u.protocol!=='https:'||!['github.com','objects.githubusercontent.com'].some(host=>u.hostname===host||u.hostname.endsWith(`.${host}`)))throw new Error();}catch{return json(res,400,{error:'INVALID_RELEASE_URL'});}
        const p=`android_${audience}_`,now=new Date().toISOString();settingSet(`${p}version_code`,versionCode);settingSet(`${p}version_name`,versionName);settingSet(`${p}download_url`,downloadUrl);settingSet(`${p}release_notes`,notes);settingSet(`${p}force_update`,b.forceUpdate===true);settingSet(`${p}published_at`,now);settingSet('telegram_latest_release_url',downloadUrl);audit('admin','publish','app_release',audience,{versionCode,versionName});return json(res,200,{saved:true,publishedAt:now});
      }
      const adminTicket=path.match(/^\/api\/admin\/tickets\/([^/]+)$/);if(adminTicket&&req.method==='GET'){const ticket=db.prepare(`SELECT t.*,a.name customer_name,a.phone FROM support_tickets t JOIN accounts a ON a.id=t.account_id WHERE t.id=?`).get(adminTicket[1]);if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});return json(res,200,{...ticket,messages:db.prepare('SELECT id,sender_role,body,created_at FROM ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id)});}if(adminTicket&&req.method==='POST'){const ticket=db.prepare('SELECT * FROM support_tickets WHERE id=?').get(adminTicket[1]),b=await readJson(req),body=String(b.body||'').trim();if(!ticket)return json(res,404,{error:'TICKET_NOT_FOUND'});if(b.close===true){db.prepare("UPDATE support_tickets SET status='closed',owner_archived_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(),ticket.id);notify(ticket.account_id,'تیکت بسته شد',ticket.subject);return json(res,200,{status:'closed'});}if(body.length<2)return json(res,400,{error:'INVALID_MESSAGE'});const now=new Date().toISOString();db.prepare(`INSERT INTO ticket_messages(id,ticket_id,sender_role,body,created_at) VALUES(?,?,'admin',?,?)`).run(randomUUID(),ticket.id,body,now);db.prepare("UPDATE support_tickets SET status='answered',owner_archived_at=NULL,updated_at=? WHERE id=?").run(now,ticket.id);notify(ticket.account_id,'پاسخ پشتیبانی',ticket.subject);return json(res,201,{sent:true});}

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
      const inboundList=value=>String(value||'').split(',').map(x=>Number(x.trim())).filter(x=>Number.isInteger(x)&&x>0).filter((x,i,a)=>a.indexOf(x)===i).join(',');
      const nodeFromBody=b=>({name:String(b.name||'').trim().slice(0,80),provider:String(b.provider||'').trim().slice(0,80),panelType:String(b.panelType||'3x-ui').trim().slice(0,30),baseUrl:String(b.baseUrl||'').trim().replace(/\/$/,'').slice(0,500),subscriptionBaseUrl:String(b.subscriptionBaseUrl||'').trim().replace(/\/$/,'').slice(0,500),visionInboundIds:inboundList(b.visionInboundIds),cdnInboundIds:inboundList(b.cdnInboundIds),hysteriaInboundIds:inboundList(b.hysteriaInboundIds),apiToken:String(b.apiToken||'').trim(),active:b.active!==false});
      const validUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'||u.protocol==='http:'}catch{return false}};
      const validSubscriptionBaseUrl=value=>{
        if (!value) return true;
        if (!validUrl(value)) return false;
        // The panel's client-management screen is HTML, not a subscription
        // endpoint. Accept the separate 3x-ui subscription listener instead.
        return !/\/panel\/clients(?:\/|$)/i.test(value);
      };
      const validNode=node=>node.name.length>=2&&node.panelType==='3x-ui'&&(!node.baseUrl||validUrl(node.baseUrl))&&validSubscriptionBaseUrl(node.subscriptionBaseUrl);
      if(req.method==='GET'&&path==='/api/admin/panel-nodes'){const rows=db.prepare('SELECT id,name,provider,panel_type,base_url,subscription_base_url,vision_inbound_ids,cdn_inbound_ids,hysteria_inbound_ids,api_token_encrypted,active,created_at,updated_at FROM panel_nodes ORDER BY active DESC,name').all();return json(res,200,rows.map(n=>({id:n.id,name:n.name,provider:n.provider,panelType:n.panel_type,baseUrl:n.base_url,subscriptionBaseUrl:n.subscription_base_url,visionInboundIds:n.vision_inbound_ids,cdnInboundIds:n.cdn_inbound_ids,hysteriaInboundIds:n.hysteria_inbound_ids,tokenConfigured:Boolean(decrypt(n.api_token_encrypted)),ready:Boolean(n.base_url&&n.subscription_base_url&&decrypt(n.api_token_encrypted)),active:Boolean(n.active),createdAt:n.created_at,updatedAt:n.updated_at,locationCount:db.prepare('SELECT COUNT(*) count FROM service_locations WHERE panel_node_id=?').get(n.id).count})));}
      if(req.method==='POST'&&path==='/api/admin/panel-nodes'){const n=nodeFromBody(await readJson(req));if(!validNode(n))return json(res,400,{error:'INVALID_PANEL_NODE'});const id=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO panel_nodes(id,name,provider,panel_type,base_url,subscription_base_url,vision_inbound_ids,cdn_inbound_ids,hysteria_inbound_ids,api_token_encrypted,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,n.name,n.provider,n.panelType,n.baseUrl,n.subscriptionBaseUrl,n.visionInboundIds,n.cdnInboundIds,n.hysteriaInboundIds,n.apiToken?encrypt(n.apiToken):'',n.active?1:0,now,now);audit('admin','create','panel_node',id,{name:n.name,baseUrl:n.baseUrl});return json(res,201,{id});}
      const panelNodeMatch=path.match(/^\/api\/admin\/panel-nodes\/([^/]+)$/);
      if(req.method==='PATCH'&&panelNodeMatch){const old=db.prepare('SELECT * FROM panel_nodes WHERE id=?').get(panelNodeMatch[1]);if(!old)return json(res,404,{error:'PANEL_NODE_NOT_FOUND'});const raw=await readJson(req),n=nodeFromBody({...old,name:raw.name??old.name,provider:raw.provider??old.provider,panelType:raw.panelType??old.panel_type,baseUrl:raw.baseUrl??old.base_url,subscriptionBaseUrl:raw.subscriptionBaseUrl??old.subscription_base_url,visionInboundIds:raw.visionInboundIds??old.vision_inbound_ids,cdnInboundIds:raw.cdnInboundIds??old.cdn_inbound_ids,hysteriaInboundIds:raw.hysteriaInboundIds??old.hysteria_inbound_ids,apiToken:raw.apiToken??'',active:raw.active??Boolean(old.active)});if(!validNode(n))return json(res,400,{error:'INVALID_PANEL_NODE'});db.prepare('UPDATE panel_nodes SET name=?,provider=?,panel_type=?,base_url=?,subscription_base_url=?,vision_inbound_ids=?,cdn_inbound_ids=?,hysteria_inbound_ids=?,api_token_encrypted=?,active=?,updated_at=? WHERE id=?').run(n.name,n.provider,n.panelType,n.baseUrl,n.subscriptionBaseUrl,n.visionInboundIds,n.cdnInboundIds,n.hysteriaInboundIds,n.apiToken?encrypt(n.apiToken):old.api_token_encrypted,n.active?1:0,new Date().toISOString(),old.id);audit('admin','update','panel_node',old.id,{name:n.name,baseUrl:n.baseUrl});return json(res,200,{id:old.id});}
      if(req.method==='DELETE'&&panelNodeMatch){const count=db.prepare('SELECT COUNT(*) count FROM service_locations WHERE panel_node_id=?').get(panelNodeMatch[1]).count;if(count)return json(res,409,{error:'PANEL_NODE_IN_USE'});db.prepare('DELETE FROM panel_nodes WHERE id=?').run(panelNodeMatch[1]);audit('admin','delete','panel_node',panelNodeMatch[1]);return json(res,200,{deleted:true});}
      const tunnelBody=(b,old={})=>({name:String(b.name??old.name??'').trim().slice(0,80),entryNodeId:String(b.entryNodeId??old.entry_node_id??'').trim(),exitNodeId:String(b.exitNodeId??old.exit_node_id??'').trim(),transport:String(b.transport??old.transport??'amneziawg').trim().toLowerCase(),publicHost:String(b.publicHost??old.public_host??'').trim().toLowerCase(),publicPort:Number(b.publicPort??old.public_port??51820),mtu:Number(b.mtu??old.mtu??1280),note:String(b.note??old.note??'').trim().slice(0,500),active:Boolean(b.active??Boolean(old.active))});
      const validTunnel=t=>t.name.length>=2&&t.entryNodeId!==t.exitNodeId&&['amneziawg','wireguard','reverse_tcp'].includes(t.transport)&&validHost(t.publicHost)&&Number.isInteger(t.publicPort)&&t.publicPort>0&&t.publicPort<=65535&&Number.isInteger(t.mtu)&&t.mtu>=1100&&t.mtu<=1420&&db.prepare('SELECT COUNT(*) count FROM panel_nodes WHERE id IN (?,?)').get(t.entryNodeId,t.exitNodeId).count===2;
      if(req.method==='GET'&&path==='/api/admin/transit-tunnels'){
        const rows=db.prepare(`SELECT t.*,e.name entry_node_name,x.name exit_node_name FROM transit_tunnels t JOIN panel_nodes e ON e.id=t.entry_node_id JOIN panel_nodes x ON x.id=t.exit_node_id ORDER BY t.active DESC,t.name`).all();return json(res,200,rows.map(t=>({...t,active:Boolean(t.active)})));
      }
      if(req.method==='POST'&&path==='/api/admin/transit-tunnels'){
        const t=tunnelBody(await readJson(req));if(!validTunnel(t))return json(res,400,{error:'INVALID_TRANSIT_TUNNEL'});const id=randomUUID(),now=new Date().toISOString();db.prepare(`INSERT INTO transit_tunnels(id,name,entry_node_id,exit_node_id,transport,public_host,public_port,mtu,note,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,t.name,t.entryNodeId,t.exitNodeId,t.transport,t.publicHost,t.publicPort,t.mtu,t.note,t.active?1:0,now,now);audit('admin','create','transit_tunnel',id,{transport:t.transport,entry:t.entryNodeId,exit:t.exitNodeId});return json(res,201,{id});
      }
      const tunnelTest=path.match(/^\/api\/admin\/transit-tunnels\/([^/]+)\/test$/);
      if(req.method==='POST'&&tunnelTest){const t=db.prepare('SELECT * FROM transit_tunnels WHERE id=?').get(tunnelTest[1]);if(!t)return json(res,404,{error:'TRANSIT_TUNNEL_NOT_FOUND'});const checkedAt=new Date().toISOString();try{const latencyMs=await measureTcpEndpoint(t.public_host,t.public_port);db.prepare("UPDATE transit_tunnels SET health_status='online',last_latency_ms=?,last_checked_at=?,updated_at=? WHERE id=?").run(latencyMs,checkedAt,checkedAt,t.id);return json(res,200,{status:'online',latencyMs,checkedAt});}catch{db.prepare("UPDATE transit_tunnels SET health_status='offline',last_latency_ms=NULL,last_checked_at=?,updated_at=? WHERE id=?").run(checkedAt,checkedAt,t.id);return json(res,200,{status:'offline',latencyMs:null,checkedAt});}}
      const tunnelMatch=path.match(/^\/api\/admin\/transit-tunnels\/([^/]+)$/);
      if(req.method==='PATCH'&&tunnelMatch){const old=db.prepare('SELECT * FROM transit_tunnels WHERE id=?').get(tunnelMatch[1]);if(!old)return json(res,404,{error:'TRANSIT_TUNNEL_NOT_FOUND'});const t=tunnelBody(await readJson(req),old);if(!validTunnel(t))return json(res,400,{error:'INVALID_TRANSIT_TUNNEL'});db.prepare("UPDATE transit_tunnels SET name=?,entry_node_id=?,exit_node_id=?,transport=?,public_host=?,public_port=?,mtu=?,note=?,active=?,health_status='unknown',last_latency_ms=NULL,last_checked_at=NULL,updated_at=? WHERE id=?").run(t.name,t.entryNodeId,t.exitNodeId,t.transport,t.publicHost,t.publicPort,t.mtu,t.note,t.active?1:0,new Date().toISOString(),old.id);return json(res,200,{id:old.id});}
      if(req.method==='DELETE'&&tunnelMatch){const result=db.prepare('DELETE FROM transit_tunnels WHERE id=?').run(tunnelMatch[1]);if(!result.changes)return json(res,404,{error:'TRANSIT_TUNNEL_NOT_FOUND'});audit('admin','delete','transit_tunnel',tunnelMatch[1]);return json(res,200,{deleted:true});}
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
        const base=`SELECT a.id,a.phone,a.name,a.role,a.status,a.default_discount_percent,a.device_limit_override,a.created_at,a.updated_at,a.device_bound_at,CASE WHEN EXISTS(SELECT 1 FROM account_devices d WHERE d.account_id=a.id AND d.status='active') OR a.device_binding_hash IS NOT NULL THEN 1 ELSE 0 END device_bound,(SELECT COUNT(*) FROM device_recovery_requests r WHERE r.account_id=a.id AND r.status='pending') device_recovery_pending,COALESCE(w.balance_toman,0) balance_toman FROM accounts a LEFT JOIN wallet_accounts w ON w.account_id=a.id`;
        const rows=role?db.prepare(`${base} WHERE a.role=? ORDER BY a.created_at DESC`).all(role):db.prepare(`${base} ORDER BY a.created_at DESC`).all();
        return json(res,200,rows.map(row=>row.role==='customer'?{...row,...deviceSummary(db,row.id)}:row));
      }
      if(req.method==='GET'&&path==='/api/admin/device-recovery-requests'){
        return json(res,200,listDeviceRecoveryRequests(db,{status:url.searchParams.get('status')||null}));
      }
      const adminDeviceRecoveryAction=path.match(/^\/api\/admin\/device-recovery-requests\/([^/]+)\/(approve|reject)$/);
      if(req.method==='POST'&&adminDeviceRecoveryAction){
        const request=db.prepare('SELECT account_id FROM device_recovery_requests WHERE id=?').get(adminDeviceRecoveryAction[1]);
        try{
          const result=resolveDeviceRecovery(db,adminDeviceRecoveryAction[1],{action:adminDeviceRecoveryAction[2],actor:'admin'});
          if(request&&result.resolvedNow){notify(request.account_id,result.status==='approved'?'دستگاه جدید تأیید شد':'درخواست دستگاه رد شد',result.message);audit('admin',adminDeviceRecoveryAction[2],'device_recovery',adminDeviceRecoveryAction[1]);}
          return json(res,200,result);
        }catch(error){return json(res,error.status||400,deviceRecoveryErrorBody(error));}
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
      const accountDevicesMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)\/devices$/);
      if(req.method==='GET'&&accountDevicesMatch){
        const account=db.prepare("SELECT id FROM accounts WHERE id=? AND role='customer'").get(accountDevicesMatch[1]);if(!account)return json(res,404,{error:'ACCOUNT_NOT_FOUND'});
        const recoveryRequests=listDeviceRecoveryRequests(db).filter(request=>request.account_id===account.id&&request.status==='pending');
        return json(res,200,{...deviceSummary(db,account.id),devices:listAccountDevices(db,account.id),recoveryRequests});
      }
      const accountDeviceLimitMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)\/device-limit$/);
      if(req.method==='PATCH'&&accountDeviceLimitMatch){
        const body=await readJson(req),limit=body.deviceLimit===undefined?body.limit:body.deviceLimit;try{const result=setDeviceLimitOverride(db,accountDeviceLimitMatch[1],limit);audit('admin','set_device_limit','account',accountDeviceLimitMatch[1],{limit:result.deviceLimitOverride});return json(res,200,result);}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
      }
      const accountDeviceMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)\/devices\/([^/]+)$/);
      if(req.method==='DELETE'&&accountDeviceMatch){
        try{const result=revokeAccountDevice(db,accountDeviceMatch[1],accountDeviceMatch[2],'admin');audit('admin','revoke_device','account',accountDeviceMatch[1],{deviceId:accountDeviceMatch[2]});return json(res,200,result);}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
      }
      const accountDeviceResetMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)\/device-reset$/);
      if(req.method==='POST'&&accountDeviceResetMatch){
        const account=db.prepare("SELECT id,phone FROM accounts WHERE id=? AND role='customer'").get(accountDeviceResetMatch[1]);if(!account)return json(res,404,{error:'ACCOUNT_NOT_FOUND'});
        try{resetAccountDevices(db,account.id,'admin');}catch(error){return json(res,error.status||400,deviceErrorBody(error));}
        audit('admin','reset_device','account',account.id,{phone:account.phone});notify(account.id,'دستگاه حساب آزاد شد','اکنون می‌توانید حساب را روی گوشی جدید فعال کنید.');return json(res,200,{id:account.id,deviceBound:false,sessionsRevoked:true});
      }
      const accountMatch=path.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      if(req.method==='PATCH'&&accountMatch){
        const old=db.prepare('SELECT * FROM accounts WHERE id=?').get(accountMatch[1]);if(!old)return json(res,404,{error:'ACCOUNT_NOT_FOUND'});
        const b=await readJson(req),name=String(b.name??old.name).trim().replace(/\s+/g,' '),phone=String(b.phone??old.phone),status=b.status??old.status,discount=Number(b.defaultDiscountPercent??old.default_discount_percent);
        if(name.length<3||name.length>80||/[<>\u0000-\u001f]/.test(name)||!/^09\d{9}$/.test(phone)||!['active','suspended'].includes(status)||!Number.isInteger(discount)||discount<0||discount>100)return json(res,400,{error:'INVALID_ACCOUNT'});
        let password=null;if(b.password){try{password=hashPassword(b.password)}catch(e){return json(res,400,{error:e.message});}}
        try{const now=new Date().toISOString();db.exec('BEGIN IMMEDIATE');db.prepare(`UPDATE accounts SET name=?,phone=?,status=?,default_discount_percent=?,password_hash=COALESCE(?,password_hash),password_salt=COALESCE(?,password_salt),updated_at=? WHERE id=?`).run(name,phone,status,discount,password?.hash||null,password?.salt||null,now,accountMatch[1]);if(old.role==='customer')db.prepare('UPDATE reseller_customers SET name=?,phone=?,updated_at=? WHERE account_id=?').run(name,phone,now,accountMatch[1]);db.exec('COMMIT');}
        catch{try{db.exec('ROLLBACK')}catch{}return json(res,409,{error:'PHONE_ALREADY_EXISTS'});}
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
        const locationMode=b.locationMode==='multi'?'multi':'single',bundleSize=locationMode==='multi'?Number(b.bundleSize||3):1;
        db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,location_mode,bundle_size,sort_order,active,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, b.name.trim(), b.description || '', b.priceIrr * 10, b.trafficGb, b.durationDays,
          b.deviceLimit, locationMode, bundleSize, b.sortOrder || 0, b.active === false ? 0 : 1, now, now);
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
        const locationMode=b.locationMode==='multi'?'multi':'single',bundleSize=locationMode==='multi'?Number(b.bundleSize||3):1;
        db.prepare(`UPDATE plans SET name=?,description=?,price_irr=?,traffic_gb=?,duration_days=?,device_limit=?,location_mode=?,bundle_size=?,sort_order=?,active=?,updated_at=? WHERE id=?`)
          .run(b.name.trim(), b.description || '', b.priceIrr * 10, b.trafficGb, b.durationDays, b.deviceLimit, locationMode, bundleSize, b.sortOrder || 0, b.active ? 1 : 0, now, planMatch[1]);
        audit('admin', 'update', 'plan', planMatch[1], b);
        return json(res, 200, planFromRow(db.prepare('SELECT * FROM plans WHERE id=?').get(planMatch[1])));
      }

      if (req.method === 'POST' && path === '/api/orders') {
        let b,customerName,phone,planId,amountToman,receiptReference,receiptCapability;
        try{
          b=await readJson(req,MAX_PAYMENT_BODY_BYTES);
          if(!b||Array.isArray(b)||typeof b!=='object')throw new PaymentRequestError('INVALID_ORDER');
          customerName=paymentString(b.customerName,{field:'CUSTOMER_NAME',min:2,max:100});
          phone=paymentString(b.phone,{field:'PHONE',min:11,max:11});
          if(!/^09\d{9}$/.test(phone))throw new PaymentRequestError('INVALID_PHONE');
          planId=paymentString(b.planId,{field:'PLAN',min:1,max:100});
          amountToman=optionalPaymentAmount(b.amountTransferredIrr);
          receiptReference=optionalReceiptReference(b.receiptReference);
          receiptCapability=receiptCapabilityFromUrl(b.receiptImageUrl,req);
        }catch(error){return paymentRequestError(res,error,'INVALID_ORDER');}
        const plan = db.prepare('SELECT * FROM plans WHERE id=? AND active=1').get(planId);
        if (!plan) return json(res, 400, { error: 'INVALID_ORDER' });
        if(receiptReference&&!receiptCapability)return json(res,400,{error:'INCOMPLETE_RECEIPT'});
        const hasReceipt = Boolean(receiptCapability);
        const id = randomUUID(), trackingToken = randomUUID().replace(/-/g, ''),now=new Date(),createdAt=now.toISOString(),cutoff=new Date(now.getTime()-PAYMENT_PENDING_WINDOW_MS).toISOString();
        try{
          db.exec('BEGIN IMMEDIATE');
          const pending=db.prepare("SELECT COUNT(*) count FROM orders WHERE phone=? AND status IN ('awaiting_receipt','under_review') AND created_at>=?").get(phone,cutoff).count;
          if(pending>=MAX_PENDING_PAYMENTS)throw new PaymentRequestError('TOO_MANY_PENDING_ORDERS',429);
          const receiptImageUrl=claimReceipt(db,receiptCapability,{entityType:'order',entityId:id,guest:true});
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,receipt_reference,receipt_image_url,created_at,tracking_token)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,customerName,phone,plan.id,hasReceipt?'under_review':'awaiting_receipt',amountToman===null?null:amountToman*10,receiptReference,receiptImageUrl,createdAt,trackingToken);
          db.exec('COMMIT');
        }catch(error){try{db.exec('ROLLBACK')}catch{}if(error instanceof PaymentRequestError){if(error.status===429)res.setHeader('retry-after','3600');return paymentRequestError(res,error);}throw error;}
        audit(phone, 'create', 'order', id);
        if (hasReceipt) await triggerReview(id);
        return json(res, 201, { id, trackingToken, status: hasReceipt ? 'under_review' : 'awaiting_receipt', expectedAmountIrr: Math.round(plan.price_irr / 10) });
      }

      const statusMatch = path.match(/^\/api\/orders\/([^/]+)$/);
      if (req.method === 'GET' && statusMatch) {
        const row = db.prepare(`SELECT o.id,o.plan_id,o.order_kind,o.parent_order_id,o.bundle_id,o.bundle_index,o.bundle_size,o.customer_name,o.phone,o.status,o.created_at,o.review_note,p.name plan_name,CAST(p.price_irr/10 AS INTEGER) price_toman,p.traffic_gb,p.duration_days,p.device_limit,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,l.name location_name,${locationSequenceSql} location_sequence
          FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id
          LEFT JOIN service_locations l ON l.id=o.location_id WHERE o.id=? AND o.tracking_token=?`).get(statusMatch[1], url.searchParams.get('token'));
        if (!row) return json(res, 404, { error:'ORDER_NOT_FOUND' });
        return json(res, 200, exposeSubscription(req,row));
      }
      const customerRenewMatch=path.match(/^\/api\/orders\/([^/]+)\/renew$/);
      if(req.method==='POST'&&customerRenewMatch){
        const token=url.searchParams.get('token'),original=db.prepare(`SELECT o.*,p.price_irr,s.status subscription_status,s.panel_client_id,s.subscription_url FROM orders o JOIN plans p ON p.id=o.plan_id JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.tracking_token=? AND o.order_kind='purchase' AND s.status='active'`).get(customerRenewMatch[1],token);
        if(!original)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
        let b,amountToman,receiptReference,receiptCapability;
        try{
          b=await readJson(req,MAX_PAYMENT_BODY_BYTES);
          if(!b||Array.isArray(b)||typeof b!=='object')throw new PaymentRequestError('INVALID_RENEWAL');
          amountToman=optionalPaymentAmount(b.amountTransferredIrr);
          receiptReference=optionalReceiptReference(b.receiptReference);
          receiptCapability=receiptCapabilityFromUrl(b.receiptImageUrl,req);
          if(!receiptCapability)throw new PaymentRequestError('RECEIPT_REQUIRED');
        }catch(error){return paymentRequestError(res,error,'INVALID_RENEWAL');}
        const id=randomUUID(),trackingToken=randomUUID().replace(/-/g,''),nowDate=new Date(),now=nowDate.toISOString(),cutoff=new Date(nowDate.getTime()-PAYMENT_PENDING_WINDOW_MS).toISOString();
        try{
          db.exec('BEGIN IMMEDIATE');
          const pending=db.prepare("SELECT COUNT(*) count FROM orders WHERE phone=? AND status IN ('awaiting_receipt','under_review') AND created_at>=?").get(original.phone,cutoff).count;
          if(pending>=MAX_PENDING_PAYMENTS)throw new PaymentRequestError('TOO_MANY_PENDING_ORDERS',429);
          const receiptImageUrl=claimReceipt(db,receiptCapability,{entityType:'order',entityId:id,guest:true});
          db.prepare(`INSERT INTO orders(id,customer_name,phone,plan_id,status,amount_transferred_irr,receipt_reference,receipt_image_url,created_at,tracking_token,location_id,order_kind,parent_order_id) VALUES(?,?,?,?,'under_review',?,?,?,?,?,?,'renewal',?)`).run(id,original.customer_name,original.phone,original.plan_id,amountToman===null?original.price_irr:amountToman*10,receiptReference,receiptImageUrl,now,trackingToken,original.location_id,original.id);
          db.exec('COMMIT');
        }catch(error){try{db.exec('ROLLBACK')}catch{}if(error instanceof PaymentRequestError){if(error.status===429)res.setHeader('retry-after','3600');return paymentRequestError(res,error);}throw error;}
        audit(original.phone,'create','renewal_order',id,{parentOrderId:original.id});await triggerReview(id);return json(res,201,{id,trackingToken,status:'under_review',expectedAmountToman:Math.round(original.price_irr/10)});
      }

      if (req.method === 'GET' && path === '/api/admin/orders') {
        const rows = db.prepare(`SELECT o.*,CAST(o.amount_transferred_irr/10 AS INTEGER) amount_transferred_irr,p.name plan_name,CAST(p.price_irr/10 AS INTEGER) price_irr,s.status subscription_status,s.control_status,s.subscription_url,COALESCE(s.access_token,(SELECT ps.access_token FROM subscriptions ps WHERE ps.order_id=o.parent_order_id)) subscription_access_token,s.provision_error,l.name location_name,${locationSequenceSql} location_sequence
          FROM orders o JOIN plans p ON p.id=o.plan_id LEFT JOIN subscriptions s ON s.order_id=o.id LEFT JOIN service_locations l ON l.id=o.location_id ORDER BY o.created_at DESC`).all();
        return json(res, 200, rows.map(row=>exposeSubscription(req,row)));
      }

      const adminControlMatch=path.match(/^\/api\/admin\/orders\/([^/]+)\/(suspend|resume|delete)$/);
      if(req.method==='POST'&&adminControlMatch){
        const body=await readJson(req),action=adminControlMatch[2],row=db.prepare(`SELECT o.id,o.account_id,o.location_id,o.customer_name,s.id subscription_id,s.status,s.control_status,s.panel_client_id FROM orders o JOIN subscriptions s ON s.order_id=o.id WHERE o.id=? AND o.order_kind='purchase'`).get(adminControlMatch[1]);
        if(!row)return json(res,404,{error:'SUBSCRIPTION_NOT_FOUND'});
        const reason=String(body.reason||'').trim();if(action==='suspend'&&reason.length<3)return json(res,400,{error:'SUSPENSION_REASON_REQUIRED'});if(action==='delete'&&body.confirm!==true)return json(res,400,{error:'DELETE_CONFIRMATION_REQUIRED'});
        const currentControl=row.control_status||'active';if(row.status!=='active'||currentControl==='deleted'||(action==='suspend'&&currentControl!=='active')||(action==='resume'&&currentControl!=='suspended'))return json(res,409,{error:'INVALID_SUBSCRIPTION_STATE'});
        const controlLocation=db.prepare('SELECT * FROM service_locations WHERE id=?').get(row.location_id),controlProvisioner=provisionerForLocation(controlLocation);
        try{if(action==='suspend'){if(!controlProvisioner?.suspend)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.suspend({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='suspended',suspension_reason=?,suspended_at=? WHERE id=?").run(reason,new Date().toISOString(),row.subscription_id);}else if(action==='resume'){if(!controlProvisioner?.resume)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.resume({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='active',suspension_reason=NULL,suspended_at=NULL WHERE id=?").run(row.subscription_id);}else{if(!controlProvisioner?.remove)throw new Error('CONTROL_NOT_SUPPORTED');await controlProvisioner.remove({panelClientId:row.panel_client_id});db.prepare("UPDATE subscriptions SET control_status='deleted',deleted_at=?,suspension_reason=? WHERE id=?").run(new Date().toISOString(),reason||'حذف توسط مدیریت',row.subscription_id);}if(row.account_id)notify(row.account_id,action==='suspend'?'اشتراک توسط مدیریت تعلیق شد':action==='resume'?'اشتراک توسط مدیریت فعال شد':'اشتراک توسط مدیریت حذف شد',reason||'وضعیت سرویس شما تغییر کرد.');audit('admin',action,'subscription',row.subscription_id,{orderId:row.id,reason});return json(res,200,{status:action==='resume'?'active':action==='suspend'?'suspended':'deleted'});}catch(e){return json(res,502,{error:'PANEL_CONTROL_FAILED',detail:String(e.message||e)});}
      }

      const reviewMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/(approve|reject)$/);
      if (req.method === 'POST' && reviewMatch) {
        const [_, id, action] = reviewMatch;
        const order = db.prepare(`SELECT o.*,p.name plan_name,p.traffic_gb,p.duration_days,p.device_limit,p.location_mode,p.bundle_size FROM orders o JOIN plans p ON p.id=o.plan_id WHERE o.id=?`).get(id);
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
  handler.sweep = () => sweepPendingPayments(db, agentDeps());
  return handler;
}
