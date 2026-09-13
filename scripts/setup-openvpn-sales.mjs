// Run inside /opt/nivora with --env-file=.env; never prints secrets.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,chmodSync} from 'node:fs';
import {createHash,createCipheriv,randomBytes} from 'node:crypto';
const db=new DatabaseSync(process.env.DATABASE_PATH||'data/nivora.db');
const candidates=db.prepare(`SELECT DISTINCT p.id,p.name,p.price_irr,p.traffic_gb,p.duration_days FROM plans p JOIN plan_locations pl ON pl.plan_id=p.id JOIN service_locations l ON l.id=pl.location_id WHERE p.active=1 AND p.duration_days=30 AND p.device_limit=1 AND p.location_mode='single' AND l.country_code='FI' AND l.panel_type<>'openvpn' ORDER BY p.traffic_gb,p.price_irr LIMIT 3`).all();
if(process.argv[2]!=='configure'){console.log(JSON.stringify(candidates));db.close();process.exit(0);}
if(!candidates.length)throw new Error('NO_EXISTING_FINLAND_PRICE');
const secret=readFileSync('/etc/nivora-classic/sales-token','utf8').trim();
const response=await fetch('http://127.0.0.1:8791/health',{method:'POST',headers:{authorization:'Bearer '+secret},body:'{}'});
if(!response.ok)throw new Error('AGENT_NOT_READY');
const key=createHash('sha256').update(process.env.SETTINGS_ENCRYPTION_KEY||process.env.ADMIN_TOKEN).digest(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
const encrypted=[iv,cipher.getAuthTag(),data].map(b=>b.toString('base64url')).join('.');
const now=new Date().toISOString(),nodeId='nivora-openvpn-fi',locationId='nivora-openvpn-fi-location';
mkdirSync('backups',{recursive:true,mode:0o700});
const backup='backups/openvpn-before-'+Date.now()+'.db';
db.exec(`VACUUM INTO '${backup}'`);chmodSync(backup,0o600);
db.exec('BEGIN IMMEDIATE');
try{
 db.prepare(`INSERT INTO panel_nodes(id,name,provider,panel_type,base_url,api_token_encrypted,active,created_at,updated_at) VALUES(?,'فنلاند OpenVPN','Hetzner','openvpn','http://127.0.0.1:8791',?,1,?,?) ON CONFLICT(id) DO UPDATE SET api_token_encrypted=excluded.api_token_encrypted,updated_at=excluded.updated_at`).run(nodeId,encrypted,now,now);
 db.prepare(`INSERT INTO service_locations(id,name,country_code,flag_emoji,city,provider,panel_type,panel_node_id,capacity,active,created_at,updated_at) VALUES(?,'فنلاند · OpenVPN','FI','🇫🇮','Helsinki','Hetzner','openvpn',?,200,1,?,?) ON CONFLICT(id) DO NOTHING`).run(locationId,nodeId,now,now);
 for(const p of candidates){
  const id='ovpn-fi-'+p.id;
  db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,location_mode,bundle_size,active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,'single',1,1,?,?) ON CONFLICT(id) DO NOTHING`).run(id,`OpenVPN فنلاند · ${p.traffic_gb||'نامحدود'} گیگ · ۳۰ روز`,'فایل اختصاصی برای OpenVPN Connect آیفون و اندروید؛ یک اتصال هم‌زمان؛ شروع اعتبار از خرید. اتصال داخل اپ نیوورا نیست.',p.price_irr,p.traffic_gb,p.duration_days,now,now);
  db.prepare('INSERT OR IGNORE INTO plan_locations(plan_id,location_id) VALUES(?,?)').run(id,locationId);
 }
 db.exec('COMMIT');
 console.log(JSON.stringify({nodeId,locationId,plans:candidates.map(p=>({id:'ovpn-fi-'+p.id,trafficGb:p.traffic_gb,priceToman:p.price_irr/10}))}));
}catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
