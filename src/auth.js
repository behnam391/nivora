import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('WEAK_PASSWORD');
  return { salt, hash:scryptSync(password,salt,64).toString('hex') };
}
export function verifyPassword(password, salt, expected) {
  if (!password || !salt || !expected) return false;
  const actual=scryptSync(password,salt,64),target=Buffer.from(expected,'hex');
  return actual.length===target.length&&timingSafeEqual(actual,target);
}
export function createSession(db, accountId, days = Number(process.env.SESSION_DAYS || 365)) {
  const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex');
  const now=new Date(),expires=new Date(now.getTime()+days*86400000);
  db.prepare('INSERT INTO account_sessions(id,account_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(randomBytes(16).toString('hex'),accountId,tokenHash,expires.toISOString(),now.toISOString());
  return {token,expiresAt:expires.toISOString()};
}
export function accountFromRequest(db, req, { requireDevice = false } = {}) {
  const raw=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!raw)return null;
  const hash=createHash('sha256').update(raw).digest('hex');
  const account = db.prepare(`SELECT a.* FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.status='active'`).get(hash,new Date().toISOString())||null;
  if (!requireDevice || !account || account.role !== 'customer' || !account.device_binding_hash) return account;
  const deviceId = String(req.headers['x-nivora-device'] || '');
  const deviceHash = createHash('sha256').update(deviceId).digest('hex');
  return deviceId && deviceHash === account.device_binding_hash ? account : null;
}
