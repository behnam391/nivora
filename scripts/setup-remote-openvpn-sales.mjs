// Run on the Nivora control server with --env-file=.env. Never prints secrets.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';

const [countryCode, slug, name, flag, city, provider, baseUrl, tokenPath] = process.argv.slice(2);
if (!/^[A-Z]{2}$/.test(countryCode||'') || !/^[a-z0-9-]+$/.test(slug||'') ||
    !/^https:\/\/[^/]+:8791$/.test(baseUrl||'') || !tokenPath) throw new Error('INVALID_ARGUMENTS');
const db = new DatabaseSync(process.env.DATABASE_PATH || 'data/nivora.db');
const secret = readFileSync(tokenPath, 'utf8').trim();
const response = await fetch(baseUrl + '/health', {method:'POST', headers:{authorization:'Bearer '+secret}, body:'{}'});
if (!response.ok) throw new Error('AGENT_NOT_READY_'+response.status);
const candidates = db.prepare(`SELECT DISTINCT p.id,p.price_irr,p.traffic_gb,p.duration_days
  FROM plans p JOIN plan_locations pl ON pl.plan_id=p.id JOIN service_locations l ON l.id=pl.location_id
  WHERE p.active=1 AND p.duration_days=30 AND p.device_limit=1 AND p.location_mode='single'
    AND l.country_code=? AND l.panel_type<>'openvpn' ORDER BY p.traffic_gb,p.price_irr LIMIT 3`).all(countryCode);
if (!candidates.length) throw new Error('NO_EXISTING_COUNTRY_PRICE');
const key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest();
const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
const encrypted=[iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');
const now=new Date().toISOString(),nodeId=`nivora-openvpn-${slug}`,locationId=`nivora-openvpn-${slug}-location`;
mkdirSync('backups',{recursive:true,mode:0o700});
const backup=`backups/openvpn-${slug}-before-${Date.now()}.db`; db.exec(`VACUUM INTO '${backup}'`); chmodSync(backup,0o600);
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`INSERT INTO panel_nodes(id,name,provider,panel_type,base_url,api_token_encrypted,active,created_at,updated_at)
    VALUES(?,?,?,'openvpn',?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,
    base_url=excluded.base_url,api_token_encrypted=excluded.api_token_encrypted,active=1,updated_at=excluded.updated_at`)
    .run(nodeId,`${name} OpenVPN`,provider,baseUrl,encrypted,now,now);
  db.prepare(`INSERT INTO service_locations(id,name,country_code,flag_emoji,city,provider,panel_type,panel_node_id,capacity,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'openvpn',?,200,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,flag_emoji=excluded.flag_emoji,
    city=excluded.city,provider=excluded.provider,panel_node_id=excluded.panel_node_id,active=1,updated_at=excluded.updated_at`)
    .run(locationId,`${name} · OpenVPN`,countryCode,flag,city,provider,nodeId,now,now);
  for (const p of candidates) {
    const id=`ovpn-${slug}-${p.id}`;
    db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,location_mode,bundle_size,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,'single',1,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      price_irr=excluded.price_irr,traffic_gb=excluded.traffic_gb,duration_days=excluded.duration_days,active=1,updated_at=excluded.updated_at`)
      .run(id,`OpenVPN ${name} · ${p.traffic_gb||'نامحدود'} گیگ · ۳۰ روز`,
        'فایل اختصاصی OpenVPN Connect برای آیفون، اندروید و ویندوز؛ یک اتصال هم‌زمان؛ مسیر جایگزین پایدار.',
        p.price_irr,p.traffic_gb,p.duration_days,now,now);
    db.prepare('INSERT OR IGNORE INTO plan_locations(plan_id,location_id) VALUES(?,?)').run(id,locationId);
  }
  db.exec('COMMIT');
  console.log(JSON.stringify({nodeId,locationId,plans:candidates.length,health:'ok'}));
} catch (error) { db.exec('ROLLBACK'); throw error; } finally { db.close(); }
