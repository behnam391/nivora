import { randomUUID } from 'node:crypto';
import { DeviceBindingError, deviceSummary, effectiveDeviceLimit, isCustomerDeviceHashAuthorized } from './device-bindings.js';

const terminalStatuses = new Set(['approved','rejected','expired']);
const PENDING_TTL_MS = 24*60*60*1000;
const MAX_REQUESTS_PER_DAY = 5;

export class DeviceRecoveryError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function expireStaleRequests(db, now = new Date().toISOString()) {
  const nowMs=Date.parse(now);
  const cutoff=new Date((Number.isFinite(nowMs)?nowMs:Date.now())-PENDING_TTL_MS).toISOString();
  db.prepare("UPDATE device_recovery_requests SET status='expired',resolved_at=? WHERE status='pending' AND requested_at<?")
    .run(now,cutoff);
  return cutoff;
}

export function requestDeviceRecovery(db, { accountId, deviceHash, now = new Date().toISOString() }) {
  if (!/^[a-f0-9]{64}$/i.test(String(deviceHash || ''))) throw new DeviceBindingError('DEVICE_REQUIRED',403);
  const account = db.prepare("SELECT id,role,status FROM accounts WHERE id=? AND role='customer' AND status='active'").get(accountId);
  if (!account) throw new DeviceRecoveryError('ACCOUNT_NOT_FOUND',404);
  if (isCustomerDeviceHashAuthorized(db,accountId,deviceHash)) throw new DeviceRecoveryError('DEVICE_ALREADY_ACTIVE',409);

  const activeCount = Number(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(accountId).count);
  const deviceLimit = effectiveDeviceLimit(db,accountId);
  if (activeCount < deviceLimit) throw new DeviceRecoveryError('DEVICE_SLOT_AVAILABLE',409,{activeDeviceCount:activeCount,deviceLimit});

  const cutoff=expireStaleRequests(db,now);
  const previous = db.prepare("SELECT id,status,requested_at,resolved_at FROM device_recovery_requests WHERE account_id=? AND requested_device_hash=? AND status='pending' ORDER BY requested_at DESC LIMIT 1").get(accountId,deviceHash);
  if (previous) return {...previous,created:false,message:'درخواست قبلی شما در انتظار بررسی است.'};
  const recentCount=Number(db.prepare('SELECT COUNT(*) count FROM device_recovery_requests WHERE account_id=? AND requested_at>=?').get(accountId,cutoff).count);
  if (recentCount>=MAX_REQUESTS_PER_DAY) throw new DeviceRecoveryError('DEVICE_RECOVERY_RATE_LIMITED',429,{retryAfterSeconds:86400});

  const id = randomUUID();
  try {
    db.prepare("INSERT INTO device_recovery_requests(id,account_id,requested_device_hash,status,requested_at) VALUES(?,?,?,'pending',?)")
      .run(id,accountId,deviceHash,now);
  } catch (error) {
    const concurrent = db.prepare("SELECT id,status,requested_at,resolved_at FROM device_recovery_requests WHERE account_id=? AND requested_device_hash=? AND status='pending' ORDER BY requested_at DESC LIMIT 1").get(accountId,deviceHash);
    if (concurrent) return {...concurrent,created:false,message:'درخواست قبلی شما در انتظار بررسی است.'};
    throw error;
  }
  return {id,status:'pending',requested_at:now,created:true,message:'درخواست آزادسازی برای پشتیبانی ارسال شد.'};
}

export function deviceRecoveryStatus(db, id, now = new Date().toISOString()) {
  expireStaleRequests(db,now);
  const row = db.prepare('SELECT id,status,requested_at,resolved_at FROM device_recovery_requests WHERE id=?').get(id);
  if (!row) throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_FOUND',404);
  return {
    ...row,
    message:row.status==='approved'?'دستگاه جدید تأیید شد؛ اکنون دوباره وارد شوید.':
      row.status==='rejected'?'درخواست توسط پشتیبانی رد شد.':
      row.status==='expired'?'زمان درخواست تمام شد؛ یک درخواست تازه ارسال کنید.':'درخواست در انتظار بررسی پشتیبانی است.'
  };
}

export function listDeviceRecoveryRequests(db, { resellerId = null, status = null, limit = 200 } = {}) {
  expireStaleRequests(db);
  const clauses=[];
  const params=[];
  if (resellerId) { clauses.push('a.managed_by_reseller_id=?'); params.push(resellerId); }
  if (status) { clauses.push('r.status=?'); params.push(status); }
  params.push(Math.max(1,Math.min(Number(limit)||200,500)));
  return db.prepare(`SELECT r.id,r.account_id,r.status,r.requested_at,r.resolved_at,r.resolved_by,a.name,a.phone,
      (SELECT COUNT(*) FROM account_devices d WHERE d.account_id=a.id AND d.status='active') active_device_count,
      a.device_limit_override
    FROM device_recovery_requests r JOIN accounts a ON a.id=r.account_id
    ${clauses.length?`WHERE ${clauses.join(' AND ')}`:''}
    ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,r.requested_at DESC LIMIT ?`).all(...params)
    .map(row=>({...row,...deviceSummary(db,row.account_id)}));
}

function syncLegacyShadow(db, accountId, now) {
  const first = db.prepare("SELECT device_hash,first_seen_at FROM account_devices WHERE account_id=? AND status='active' ORDER BY first_seen_at,id LIMIT 1").get(accountId);
  db.prepare('UPDATE accounts SET device_binding_hash=?,device_bound_at=?,updated_at=? WHERE id=?')
    .run(first?.device_hash||null,first?.first_seen_at||null,now,accountId);
}

export function resolveDeviceRecovery(db, requestId, { action, actor, resellerId = null, now = new Date().toISOString() }) {
  if (!['approve','reject'].includes(action)) throw new DeviceRecoveryError('INVALID_DEVICE_RECOVERY_ACTION',400);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cutoff=new Date(Date.parse(now)-PENDING_TTL_MS).toISOString();
    db.prepare("UPDATE device_recovery_requests SET status='expired',resolved_at=? WHERE id=? AND status='pending' AND requested_at<?")
      .run(now,requestId,cutoff);
    // Re-read the request and its current owner only after obtaining the write
    // lock. Otherwise two app processes can both observe `pending`; the later
    // approval could evict another device after the first one already won.
    // The ownership check must be covered by the same lock as well, so a
    // reseller cannot finish an approval after the account was reassigned.
    const request = db.prepare(`SELECT r.*,a.managed_by_reseller_id FROM device_recovery_requests r
      JOIN accounts a ON a.id=r.account_id AND a.role='customer' AND a.status='active' WHERE r.id=?`).get(requestId);
    if (!request) throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_FOUND',404);
    if (resellerId && request.managed_by_reseller_id !== resellerId) throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_MANAGED',403);
    if (terminalStatuses.has(request.status)) {
      const result = deviceRecoveryStatus(db,request.id);
      db.exec('COMMIT');
      return {...result,resolvedNow:false};
    }
    if (request.status !== 'pending') throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_PENDING',409);

    if (action === 'reject') {
      const resolved = db.prepare("UPDATE device_recovery_requests SET status='rejected',resolved_at=?,resolved_by=? WHERE id=? AND status='pending'")
        .run(now,actor,request.id);
      if (resolved.changes !== 1) throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_PENDING',409);
      const result = deviceRecoveryStatus(db,request.id);
      db.exec('COMMIT');
      return {...result,resolvedNow:true};
    }

    const limit = effectiveDeviceLimit(db,request.account_id);
    let activeCount = Number(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(request.account_id).count);
    const requested = db.prepare('SELECT * FROM account_devices WHERE account_id=? AND device_hash=?').get(request.account_id,request.requested_device_hash);
    if (!requested || requested.status !== 'active') {
      while (activeCount >= limit) {
        const victim = db.prepare("SELECT id,device_hash FROM account_devices WHERE account_id=? AND status='active' ORDER BY last_seen_at ASC,first_seen_at ASC,id LIMIT 1").get(request.account_id);
        if (!victim) break;
        db.prepare("UPDATE account_devices SET status='revoked',revoked_at=?,revoked_by=? WHERE id=?").run(now,actor,victim.id);
        db.prepare("UPDATE hysteria_tickets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND device_binding_hash=?").run(now,request.account_id,victim.device_hash);
        activeCount--;
      }
      if (requested) {
        db.prepare("UPDATE account_devices SET status='active',label=CASE WHEN label='' THEN 'دستگاه بازیابی‌شده' ELSE label END,revoked_at=NULL,revoked_by=NULL,last_seen_at=? WHERE id=?")
          .run(now,requested.id);
      } else {
        db.prepare("INSERT INTO account_devices(id,account_id,device_hash,label,platform,status,first_seen_at,last_seen_at) VALUES(?,?,?,'دستگاه بازیابی‌شده','android','active',?,?)")
          .run(randomUUID(),request.account_id,request.requested_device_hash,now,now);
      }
    }
    db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(request.account_id);
    db.prepare("UPDATE hysteria_tickets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND revoked_at IS NULL").run(now,request.account_id);
    syncLegacyShadow(db,request.account_id,now);
    const resolved = db.prepare("UPDATE device_recovery_requests SET status='approved',resolved_at=?,resolved_by=? WHERE id=? AND status='pending'")
      .run(now,actor,request.id);
    if (resolved.changes !== 1) throw new DeviceRecoveryError('DEVICE_RECOVERY_NOT_PENDING',409);
    const result = deviceRecoveryStatus(db,request.id);
    db.exec('COMMIT');
    return {...result,resolvedNow:true};
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deviceRecoveryErrorBody(error) {
  return {error:error.code||error.message||'DEVICE_RECOVERY_FAILED',...(error.details||{})};
}
