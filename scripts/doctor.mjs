import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const dbPath=process.env.DATABASE_PATH||'data/nivora.db';
if(!existsSync(dbPath))throw new Error(`Database not found: ${dbPath}`);
const db=new DatabaseSync(dbPath,{readOnly:true});
const nodes=db.prepare(`SELECT id,name,panel_type,base_url,subscription_base_url,active,
  CASE WHEN length(api_token_encrypted)>10 THEN 1 ELSE 0 END token_configured FROM panel_nodes ORDER BY name`).all();
const locations=db.prepare(`SELECT l.id,l.name,l.country_code,l.active,l.panel_node_id,
  COUNT(DISTINCT pl.plan_id) plan_count FROM service_locations l LEFT JOIN plan_locations pl ON pl.location_id=l.id GROUP BY l.id ORDER BY l.name`).all();
const problems=[];
for(const n of nodes){
  if(n.active&&!n.base_url)problems.push(`${n.name}: آدرس پنل/API خالی است`);
  if(n.active&&!n.token_configured)problems.push(`${n.name}: توکن ثبت نشده است`);
  if(n.active&&n.panel_type!=='openvpn'&&!n.subscription_base_url)problems.push(`${n.name}: آدرس اشتراک خالی است`);
}
const legacyDefaultConfigured=Boolean(process.env.PANEL_BASE_URL&&process.env.PANEL_API_TOKEN&&process.env.PANEL_SUBSCRIPTION_BASE_URL);
for(const l of locations){if(l.active&&!l.panel_node_id&&!legacyDefaultConfigured)problems.push(`${l.name}: به سرور مشخصی متصل نیست و سرور پیش‌فرض هم کامل نیست`);if(l.active&&!l.plan_count)problems.push(`${l.name}: هیچ پلن فعالی به آن متصل نیست`);}
const backupDir=resolve(process.env.BACKUP_DIR||'backups');
const backups=existsSync(backupDir)?readdirSync(backupDir).filter(x=>/^nivora-.*\.db$/.test(x)).map(x=>({name:x,time:statSync(resolve(backupDir,x)).mtimeMs})).sort((a,b)=>b.time-a.time):[];
console.log(JSON.stringify({ok:problems.length===0,database:dbPath,nodes:nodes.map(n=>({name:n.name,type:n.panel_type,active:Boolean(n.active),configured:Boolean(n.base_url&&n.token_configured&&(n.panel_type==='openvpn'||n.subscription_base_url))})),activeLocations:locations.filter(l=>l.active).length,latestBackup:backups[0]?.name||null,problems},null,2));
db.close();
if(problems.length)process.exitCode=2;
