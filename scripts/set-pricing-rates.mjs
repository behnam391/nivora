import { openDatabase } from '../src/db.js';

const usdToman=Number(process.argv[2]),eurToman=Number(process.argv[3]);
if(!Number.isFinite(usdToman)||usdToman<=0||!Number.isFinite(eurToman)||eurToman<=0)throw new Error('Usage: node scripts/set-pricing-rates.mjs USD_TOMAN EUR_TOMAN');
const db=openDatabase(),now=new Date().toISOString(),set=db.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`),previous=Object.fromEntries(db.prepare("SELECT key,value FROM app_settings WHERE key IN ('pricing_usd_toman','pricing_eur_toman')").all().map(row=>[row.key,row.value]));
db.exec('BEGIN IMMEDIATE');
try{
  set.run('pricing_previous_usd_toman',previous.pricing_usd_toman||usdToman,now);set.run('pricing_previous_eur_toman',previous.pricing_eur_toman||eurToman,now);
  set.run('pricing_usd_toman',Math.round(usdToman),now);set.run('pricing_eur_toman',Math.round(eurToman),now);set.run('pricing_source','manual',now);set.run('pricing_updated_at',now,now);db.exec('COMMIT');
  console.log(JSON.stringify({usdToman:Math.round(usdToman),eurToman:Math.round(eurToman),updatedAt:now}));
}catch(error){db.exec('ROLLBACK');throw error}
