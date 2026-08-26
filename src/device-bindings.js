import { createHash, randomUUID } from 'node:crypto';

const DEVICE_PATTERN = /^[a-zA-Z0-9_-]{20,160}$/;
const MAX_DEVICE_LIMIT = 10;

export class DeviceBindingError extends Error {
  constructor(code, status = 403, details = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function readDeviceId(req) {
  return String(req?.headers?.['x-nivora-device'] || '').trim();
}

export function hashDeviceId(deviceId) {
  const normalized = String(deviceId || '').trim();
  return DEVICE_PATTERN.test(normalized)
    ? createHash('sha256').update(normalized).digest('hex')
    : '';
}

function legacyDevice(db, accountId) {
  const account = db.prepare('SELECT device_binding_hash,device_bound_at,created_at,updated_at FROM accounts WHERE id=?').get(accountId);
  if (!account?.device_binding_hash) return null;
  const seenAt = account.device_bound_at || account.updated_at || account.created_at || new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO account_devices(id,account_id,device_hash,label,platform,status,first_seen_at,last_seen_at)
    VALUES(?,?,?,'دستگاه قدیمی','','active',?,?)`).run(randomUUID(),accountId,account.device_binding_hash,seenAt,seenAt);
  return db.prepare('SELECT * FROM account_devices WHERE account_id=? AND device_hash=?').get(accountId,account.device_binding_hash) || null;
}

function activePlanDeviceLimit(db, accountId) {
  const row = db.prepare(`SELECT MAX(p.device_limit) device_limit
    FROM orders o
    JOIN plans p ON p.id=o.plan_id
    JOIN subscriptions s ON s.order_id=o.id
    WHERE o.account_id=? AND o.order_kind='purchase' AND o.status='approved'
      AND s.status='active' AND COALESCE(s.control_status,'active')='active'`).get(accountId);
  return Math.min(MAX_DEVICE_LIMIT,Math.max(1, Number(row?.device_limit) || 1));
}

export function effectiveDeviceLimit(db, accountId) {
  const account = db.prepare("SELECT role,device_limit_override FROM accounts WHERE id=? AND status='active'").get(accountId);
  if (!account || account.role !== 'customer') return 0;
  const override = Number(account.device_limit_override);
  return Number.isInteger(override) && override >= 1 ? Math.min(override,MAX_DEVICE_LIMIT) : activePlanDeviceLimit(db,accountId);
}

export function listAccountDevices(db, accountId, { includeRevoked = false } = {}) {
  legacyDevice(db,accountId);
  const where = includeRevoked ? '' : " AND status='active'";
  return db.prepare(`SELECT id,label,platform,status,first_seen_at,last_seen_at,revoked_at,revoked_by
    FROM account_devices WHERE account_id=?${where}
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,last_seen_at DESC`).all(accountId);
}

export function deviceSummary(db, accountId) {
  const devices = listAccountDevices(db,accountId);
  const account = db.prepare('SELECT device_limit_override FROM accounts WHERE id=?').get(accountId);
  return {
    activeDeviceCount:devices.length,
    deviceCount:devices.length,
    device_count:devices.length,
    deviceLimit:effectiveDeviceLimit(db,accountId),
    device_limit:effectiveDeviceLimit(db,accountId),
    deviceLimitOverride:account?.device_limit_override == null ? null : Number(account.device_limit_override)
  };
}

export function isCustomerDeviceAuthorized(db, accountId, deviceId) {
  const hash = hashDeviceId(deviceId);
  if (!hash) return false;
  legacyDevice(db,accountId);
  return Boolean(db.prepare("SELECT 1 ok FROM account_devices WHERE account_id=? AND device_hash=? AND status='active'").get(accountId,hash));
}

export function isCustomerDeviceHashAuthorized(db, accountId, deviceHash) {
  if (!/^[a-f0-9]{64}$/i.test(String(deviceHash || ''))) return false;
  legacyDevice(db,accountId);
  return Boolean(db.prepare("SELECT 1 ok FROM account_devices WHERE account_id=? AND device_hash=? AND status='active'").get(accountId,deviceHash));
}

export function claimCustomerDevice(db, account, req, { required = false } = {}) {
  const raw = readDeviceId(req);
  const hash = hashDeviceId(raw);
  if (!hash) {
    if (required) throw new DeviceBindingError('DEVICE_REQUIRED');
    return null;
  }
  if (!account || account.role !== 'customer') throw new DeviceBindingError('ACCOUNT_NOT_ELIGIBLE',403);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    legacyDevice(db,account.id);
    const existing = db.prepare('SELECT * FROM account_devices WHERE account_id=? AND device_hash=?').get(account.id,hash);
    if (existing?.status === 'active') {
      db.prepare('UPDATE account_devices SET last_seen_at=? WHERE id=?').run(now,existing.id);
      db.exec('COMMIT');
      return {...existing,last_seen_at:now};
    }
    const activeCount = Number(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(account.id).count);
    const limit = effectiveDeviceLimit(db,account.id);
    if (activeCount >= limit) {
      throw new DeviceBindingError(limit === 1 ? 'DEVICE_ALREADY_BOUND' : 'DEVICE_LIMIT_REACHED',403,{deviceLimit:limit,activeDeviceCount:activeCount});
    }
    const id = existing?.id || randomUUID();
    if (existing) db.prepare("UPDATE account_devices SET status='active',last_seen_at=?,revoked_at=NULL,revoked_by=NULL WHERE id=?").run(now,id);
    else db.prepare(`INSERT INTO account_devices(id,account_id,device_hash,label,platform,status,first_seen_at,last_seen_at)
      VALUES(?,?,?,'گوشی Nivora','Android','active',?,?)`).run(id,account.id,hash,now,now);
    db.prepare('UPDATE accounts SET device_binding_hash=?,device_bound_at=?,updated_at=? WHERE id=? AND device_binding_hash IS NULL').run(hash,now,now,account.id);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM account_devices WHERE id=?').get(id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function setDeviceLimitOverride(db, accountId, rawLimit) {
  const account = db.prepare("SELECT id FROM accounts WHERE id=? AND role='customer'").get(accountId);
  if (!account) throw new DeviceBindingError('ACCOUNT_NOT_FOUND',404);
  legacyDevice(db,accountId);
  const limit = rawLimit == null || rawLimit === '' ? null : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEVICE_LIMIT)) {
    throw new DeviceBindingError('INVALID_DEVICE_LIMIT',400,{maxDeviceLimit:MAX_DEVICE_LIMIT});
  }
  const activeCount = Number(db.prepare("SELECT COUNT(*) count FROM account_devices WHERE account_id=? AND status='active'").get(accountId).count);
  const resultingLimit = limit ?? activePlanDeviceLimit(db,accountId);
  if (activeCount > resultingLimit) throw new DeviceBindingError('DEVICE_LIMIT_BELOW_ACTIVE_COUNT',409,{deviceLimit:resultingLimit,activeDeviceCount:activeCount});
  const now = new Date().toISOString();
  db.prepare('UPDATE accounts SET device_limit_override=?,updated_at=? WHERE id=?').run(limit,now,accountId);
  return deviceSummary(db,accountId);
}

function syncLegacyShadow(db, accountId, now) {
  const first = db.prepare("SELECT device_hash,first_seen_at FROM account_devices WHERE account_id=? AND status='active' ORDER BY first_seen_at,id LIMIT 1").get(accountId);
  db.prepare('UPDATE accounts SET device_binding_hash=?,device_bound_at=?,updated_at=? WHERE id=?')
    .run(first?.device_hash || null,first?.first_seen_at || null,now,accountId);
}

export function revokeAccountDevice(db, accountId, deviceId, actor = 'admin') {
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const device = db.prepare("SELECT * FROM account_devices WHERE id=? AND account_id=? AND status='active'").get(deviceId,accountId);
    if (!device) throw new DeviceBindingError('DEVICE_NOT_FOUND',404);
    db.prepare("UPDATE account_devices SET status='revoked',revoked_at=?,revoked_by=?,last_seen_at=? WHERE id=?").run(now,actor,now,device.id);
    db.prepare('DELETE FROM account_sessions WHERE device_id=?').run(device.id);
    db.prepare("UPDATE hysteria_tickets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND device_binding_hash=?").run(now,accountId,device.device_hash);
    syncLegacyShadow(db,accountId,now);
    db.exec('COMMIT');
    return deviceSummary(db,accountId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function resetAccountDevices(db, accountId, actor = 'admin') {
  const account = db.prepare("SELECT id FROM accounts WHERE id=? AND role='customer'").get(accountId);
  if (!account) throw new DeviceBindingError('ACCOUNT_NOT_FOUND',404);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE account_devices SET status='revoked',revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?) WHERE account_id=? AND status='active'").run(now,actor,accountId);
    db.prepare('UPDATE accounts SET device_binding_hash=NULL,device_bound_at=NULL,updated_at=? WHERE id=?').run(now,accountId);
    db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(accountId);
    db.prepare("UPDATE hysteria_tickets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND revoked_at IS NULL").run(now,accountId);
    db.exec('COMMIT');
    return {...deviceSummary(db,accountId),sessionsRevoked:true};
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deviceErrorBody(error) {
  return {error:error.code || error.message || 'DEVICE_OPERATION_FAILED',...(error.details || {})};
}
