import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

export class HysteriaAuthError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

function validSecret(secret) {
  return Buffer.byteLength(String(secret || ''), 'utf8') >= 32;
}

const validHostname = value => net.isIP(value) > 0 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(String(value || ''));

function nodeConfigKey(secret) {
  if (!validSecret(secret)) throw new HysteriaAuthError('HYSTERIA2_NOT_CONFIGURED', 503);
  return createHash('sha256').update(`nivora-hysteria-node-config-v1\0${secret}`).digest();
}

export function encryptHysteriaNodeValue(value, secret) {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', nodeConfigKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptHysteriaNodeValue(value, secret) {
  if (!value) return '';
  try {
    const [version, iv, tag, encrypted] = String(value).split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) return '';
    const decipher = createDecipheriv('aes-256-gcm', nodeConfigKey(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function sign(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verify(secret, token) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) throw new HysteriaAuthError('INVALID_TICKET');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) throw new HysteriaAuthError('INVALID_TICKET');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new HysteriaAuthError('INVALID_TICKET');
  }
}

function hostForUri(host) {
  return String(host).includes(':') ? `[${host}]` : host;
}

export function hashHysteriaNodeSecret(secret) {
  if (!validSecret(secret)) throw new HysteriaAuthError('WEAK_NODE_SECRET', 400);
  return sha256(secret);
}

export function createHysteriaTicketService(db, {
  secret,
  ttlSeconds = 45,
  resumeSeconds = 43_200,
  statsReader = async () => ({}),
  statsMaxAgeSeconds = 180,
  now = () => Date.now()
} = {}) {
  const signingSecret = String(secret || '');
  const ttl = Math.min(120, Math.max(15, Number(ttlSeconds) || 45));
  const resumeTtl = Math.min(86_400, Math.max(ttl, Number(resumeSeconds) || 43_200));
  const maxStatsAgeMs = Math.max(30, Number(statsMaxAgeSeconds) || 180) * 1000;

  const requireEnabled = () => {
    if (!validSecret(signingSecret)) throw new HysteriaAuthError('HYSTERIA2_NOT_CONFIGURED', 503);
  };

  const rowForOrder = (orderId, accountId, routeId) => db.prepare(`
    SELECT s.id subscription_id,s.status subscription_status,s.control_status,s.panel_client_id,
      s.hysteria_started_at,s.hysteria_expires_at,s.hysteria_duration_days,s.hysteria_traffic_limit_bytes,s.hysteria_used_bytes,
      o.id order_id,o.account_id,o.location_id,o.status order_status,o.order_kind,
      a.status account_status,a.device_binding_hash,
      n.id route_id,n.public_host,n.public_port,n.sni,n.obfs_type,n.obfs_password_encrypted,n.pin_sha256,n.active node_active
    FROM orders o
    JOIN subscriptions s ON s.order_id=o.id
    JOIN accounts a ON a.id=o.account_id
    JOIN hysteria_nodes n ON n.location_id=o.location_id AND n.active=1
    WHERE o.id=? AND o.account_id=?
      AND (?='auto' OR n.id=? )
    ORDER BY n.priority ASC,n.id ASC
    LIMIT 1
  `).get(orderId, accountId, routeId, routeId);

  const rowForClaims = claims => db.prepare(`
    SELECT s.id subscription_id,s.status subscription_status,s.control_status,s.panel_client_id,
      s.hysteria_started_at,s.hysteria_expires_at,s.hysteria_duration_days,s.hysteria_traffic_limit_bytes,s.hysteria_used_bytes,
      o.id order_id,o.account_id,o.location_id,o.status order_status,o.order_kind,
      a.status account_status,a.device_binding_hash,
      n.id route_id,n.public_host,n.public_port,n.sni,n.obfs_type,n.obfs_password_encrypted,n.pin_sha256,n.active node_active
    FROM subscriptions s
    JOIN orders o ON o.id=s.order_id
    JOIN accounts a ON a.id=o.account_id
    JOIN hysteria_nodes n ON n.id=? AND n.location_id=o.location_id
    WHERE s.id=? AND o.id=? AND o.account_id=?
  `).get(claims.rid, claims.sid, claims.oid, claims.aid);

  const assertBaseEligibility = (row, deviceBindingHash) => {
    if (!row || !row.node_active) throw new HysteriaAuthError('HYSTERIA2_ROUTE_NOT_FOUND', 404);
    if (row.order_kind !== 'purchase' || row.order_status !== 'approved' || row.subscription_status !== 'active') {
      throw new HysteriaAuthError('SUBSCRIPTION_NOT_ACTIVE', 409);
    }
    if (row.control_status && row.control_status !== 'active') throw new HysteriaAuthError('SUBSCRIPTION_SUSPENDED', 409);
    if (row.account_status !== 'active') throw new HysteriaAuthError('ACCOUNT_SUSPENDED', 403);
    if (!deviceBindingHash || !row.device_binding_hash || !safeEqual(deviceBindingHash, row.device_binding_hash)) {
      throw new HysteriaAuthError('DEVICE_MISMATCH', 403);
    }
    if (!validHostname(row.public_host) || !Number.isInteger(Number(row.public_port)) || Number(row.public_port) < 1 || Number(row.public_port) > 65535) {
      throw new HysteriaAuthError('HYSTERIA2_ROUTE_INVALID', 503);
    }
  };

  // Panel statistics are an additional, cross-protocol quota signal. Remote
  // nodes may temporarily have no fresh snapshot, so availability must not
  // take down an otherwise valid Hysteria subscription. Fresh explicit
  // disable/expiry/exhaustion signals still fail closed.
  const assertPanelEntitlement = async row => {
    const stats = await statsReader();
    const panel = stats?.[row.panel_client_id];
    if (!panel) return;
    const clock = now();
    const syncedAt = Number(panel.syncedAt || 0);
    if (!syncedAt || clock - syncedAt > maxStatsAgeMs) return;
    if (panel.enabled === false) throw new HysteriaAuthError('SUBSCRIPTION_DISABLED', 409);
    const expiry = Number(panel.expiryTime || 0);
    if (expiry > 0 && expiry <= clock) throw new HysteriaAuthError('SUBSCRIPTION_EXPIRED', 409);
    const total = Number(panel.totalBytes || 0);
    const used = Number(panel.upBytes || 0) + Number(panel.downBytes || 0) + Number(row.hysteria_used_bytes || 0);
    if (total > 0 && used >= total) throw new HysteriaAuthError('SUBSCRIPTION_EXHAUSTED', 409);
  };

  const syncHysteriaEntitlement = row => {
    const totals = db.prepare(`
      SELECT COALESCE(SUM(p.duration_days),0) duration_days,COALESCE(SUM(p.traffic_gb),0) traffic_gb
      FROM orders o
      JOIN plans p ON p.id=o.plan_id
      JOIN subscriptions s ON s.order_id=o.id AND s.status='active'
      WHERE o.status='approved' AND (o.id=? OR (o.order_kind='renewal' AND o.parent_order_id=?))
    `).get(row.order_id, row.order_id);
    const appliedDays = Math.max(0, Number(row.hysteria_duration_days || 0));
    const totalDays = Math.max(1, Number(totals.duration_days || 0));
    const clock = now();
    let startedAt = row.hysteria_started_at;
    let expiresAt = row.hysteria_expires_at;
    if (!startedAt || !expiresAt) {
      startedAt = new Date(clock).toISOString();
      expiresAt = new Date(clock + totalDays * DAY_MS).toISOString();
    } else if (totalDays > appliedDays) {
      expiresAt = new Date(Date.parse(expiresAt) + (totalDays - appliedDays) * DAY_MS).toISOString();
    }
    const trafficLimit = Math.max(1, Number(totals.traffic_gb || 0)) * GB;
    db.prepare(`UPDATE subscriptions SET hysteria_started_at=?,hysteria_expires_at=?,hysteria_duration_days=?,hysteria_traffic_limit_bytes=? WHERE id=?`)
      .run(startedAt, expiresAt, totalDays, trafficLimit, row.subscription_id);
    return {...row, hysteria_started_at:startedAt, hysteria_expires_at:expiresAt, hysteria_duration_days:totalDays, hysteria_traffic_limit_bytes:trafficLimit};
  };

  const assertHysteriaEntitlement = row => {
    if (!row.hysteria_expires_at || Date.parse(row.hysteria_expires_at) <= now()) {
      throw new HysteriaAuthError('SUBSCRIPTION_EXPIRED', 409);
    }
    const limit = Number(row.hysteria_traffic_limit_bytes || 0);
    if (limit > 0 && Number(row.hysteria_used_bytes || 0) >= limit) {
      throw new HysteriaAuthError('SUBSCRIPTION_EXHAUSTED', 409);
    }
  };

  return {
    configured: validSecret(signingSecret),

    async issue({orderId, accountId, deviceBindingHash, routeId}) {
      requireEnabled();
      let row = rowForOrder(orderId, accountId, routeId);
      assertBaseEligibility(row, deviceBindingHash);
      await assertPanelEntitlement(row);
      row = syncHysteriaEntitlement(row);
      assertHysteriaEntitlement(row);
      const issuedAt = Math.floor(now() / 1000);
      const claims = {
        v: 1,
        jti: randomBytes(18).toString('base64url'),
        sid: row.subscription_id,
        oid: row.order_id,
        aid: row.account_id,
        did: deviceBindingHash,
        rid: row.route_id,
        iat: issuedAt,
        exp: issuedAt + ttl
      };
      const token = sign(signingSecret, claims);
      const initialExpiresAt = new Date(claims.exp * 1000).toISOString();
      const resumeExpiresAt = new Date(now() + resumeTtl * 1000).toISOString();
      db.prepare(`INSERT INTO hysteria_tickets(id,subscription_id,node_id,account_id,device_binding_hash,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(claims.jti,row.subscription_id,row.route_id,row.account_id,deviceBindingHash,sha256(token),resumeExpiresAt,new Date(now()).toISOString());
      const query = new URLSearchParams();
      if (row.sni) query.set('sni', row.sni);
      const obfsType = String(row.obfs_type || '').toLowerCase();
      if (obfsType) {
        const obfsPassword = decryptHysteriaNodeValue(row.obfs_password_encrypted, signingSecret);
        if (!['salamander','gecko'].includes(obfsType) || !obfsPassword) throw new HysteriaAuthError('HYSTERIA2_ROUTE_INVALID', 503);
        query.set('obfs', obfsType);
        query.set('obfs-password', obfsPassword);
      }
      if (row.pin_sha256) query.set('pinSHA256', row.pin_sha256);
      const suffix = query.size ? `?${query}` : '';
      return {
        routeId: row.route_id,
        uri: `hysteria2://${encodeURIComponent(token)}@${hostForUri(row.public_host)}:${row.public_port}/${suffix}`,
        expiresAt: initialExpiresAt
      };
    },

    async authenticate({routeId, nodeSecret, token}) {
      requireEnabled();
      const node = db.prepare('SELECT * FROM hysteria_nodes WHERE id=? AND active=1').get(routeId);
      if (!node || !validSecret(nodeSecret) || !safeEqual(sha256(nodeSecret), node.node_secret_hash)) {
        throw new HysteriaAuthError('INVALID_NODE_CREDENTIALS', 401);
      }
      const claims = verify(signingSecret, token);
      if (claims.v !== 1 || claims.rid !== routeId || !claims.jti) {
        throw new HysteriaAuthError('INVALID_TICKET');
      }
      const ticket = db.prepare('SELECT * FROM hysteria_tickets WHERE id=? AND token_hash=? AND node_id=?').get(claims.jti,sha256(token),routeId);
      if (!ticket || ticket.revoked_at || ticket.expires_at <= new Date(now()).toISOString()) {
        throw new HysteriaAuthError('INVALID_TICKET');
      }
      // The token has a very small first-use window. Once accepted, the same
      // in-memory Xray core may reauthenticate after a radio/network handover
      // until the bounded resume window ends.
      if (!ticket.consumed_at && Number(claims.exp) <= Math.floor(now() / 1000)) {
        throw new HysteriaAuthError('INVALID_TICKET');
      }
      let row = rowForClaims(claims);
      assertBaseEligibility(row, claims.did);
      await assertPanelEntitlement(row);
      row = syncHysteriaEntitlement(row);
      assertHysteriaEntitlement(row);
      const consumedAt = new Date(now()).toISOString();
      const clientId = ticket.client_id || `hy2-${sha256(row.subscription_id).slice(0,32)}`;
      const result = db.prepare(`UPDATE hysteria_tickets SET consumed_at=COALESCE(consumed_at,?),client_id=COALESCE(client_id,?) WHERE id=? AND revoked_at IS NULL AND expires_at>?`)
        .run(consumedAt, clientId, claims.jti, consumedAt);
      if (result.changes !== 1) throw new HysteriaAuthError('INVALID_TICKET');
      return {ok:true,id:clientId};
    },

    recordUsage({routeId, nodeSecret, clients}) {
      requireEnabled();
      const node = db.prepare('SELECT * FROM hysteria_nodes WHERE id=? AND active=1').get(routeId);
      if (!node || !validSecret(nodeSecret) || !safeEqual(sha256(nodeSecret), node.node_secret_hash)) {
        throw new HysteriaAuthError('INVALID_NODE_CREDENTIALS', 401);
      }
      if (!clients || typeof clients !== 'object' || Array.isArray(clients) || Object.keys(clients).length > 10_000) {
        throw new HysteriaAuthError('INVALID_USAGE_PAYLOAD', 400);
      }
      const readCounter = db.prepare('SELECT * FROM hysteria_usage_counters WHERE node_id=? AND client_id=?');
      const saveCounter = db.prepare(`INSERT INTO hysteria_usage_counters(node_id,client_id,last_tx_bytes,last_rx_bytes,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(node_id,client_id) DO UPDATE SET last_tx_bytes=excluded.last_tx_bytes,last_rx_bytes=excluded.last_rx_bytes,updated_at=excluded.updated_at`);
      const findSubscription = db.prepare(`SELECT subscription_id FROM hysteria_tickets
        WHERE node_id=? AND client_id=? ORDER BY created_at DESC LIMIT 1`);
      const addUsage = db.prepare('UPDATE subscriptions SET hysteria_used_bytes=hysteria_used_bytes+? WHERE id=?');
      let accepted = 0;
      let addedBytes = 0;
      const appliedAt = new Date(now()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [clientId, raw] of Object.entries(clients)) {
          if (!/^hy2-[a-f0-9]{32}$/.test(clientId) || !raw || typeof raw !== 'object') continue;
          const tx = Math.max(0, Math.floor(Number(raw.tx) || 0));
          const rx = Math.max(0, Math.floor(Number(raw.rx) || 0));
          if (!Number.isSafeInteger(tx) || !Number.isSafeInteger(rx)) continue;
          const target = findSubscription.get(routeId, clientId);
          if (!target) continue;
          const previous = readCounter.get(routeId, clientId);
          const deltaTx = previous ? (tx >= previous.last_tx_bytes ? tx - previous.last_tx_bytes : tx) : tx;
          const deltaRx = previous ? (rx >= previous.last_rx_bytes ? rx - previous.last_rx_bytes : rx) : rx;
          const delta = deltaTx + deltaRx;
          saveCounter.run(routeId, clientId, tx, rx, appliedAt);
          if (delta > 0) addUsage.run(delta, target.subscription_id);
          accepted += 1;
          addedBytes += delta;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return {ok:true,accepted,addedBytes};
    }
  };
}
