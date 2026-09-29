import { openDatabase } from '../src/db.js';
import { randomUUID } from 'node:crypto';

const apply=process.argv.includes('--apply');
const db=openDatabase();
const plans=db.prepare(`SELECT p.*,GROUP_CONCAT(l.name,' | ') locations FROM plans p LEFT JOIN plan_locations pl ON pl.plan_id=p.id LEFT JOIN service_locations l ON l.id=pl.location_id GROUP BY p.id ORDER BY p.traffic_gb,p.sort_order,p.name`).all();
console.log(JSON.stringify(plans.map(p=>({id:p.id,name:p.name,priceToman:Math.round(p.price_irr/10),trafficGb:p.traffic_gb,durationDays:p.duration_days,active:Boolean(p.active),locations:p.locations})),null,2));
if(!apply){console.log('\nDry run only. Add --apply to create 10GB plans and increase active 30GB prices by 15%.');process.exit(0)}

const now=new Date().toISOString(),sources=plans.filter(p=>p.active&&p.traffic_gb===30&&p.duration_days>0),insert=db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,location_mode,bundle_size,sort_order,active,created_at,updated_at,special_message,auto_price,cost_currency,cost_amount,markup_percent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),copyLocation=db.prepare('INSERT OR IGNORE INTO plan_locations(plan_id,location_id) SELECT ?,location_id FROM plan_locations WHERE plan_id=?');
db.exec('BEGIN IMMEDIATE');
try{
  for(const source of sources){
    const raised=Math.ceil((source.price_irr/10)*1.15/5000)*5000;
    db.prepare('UPDATE plans SET price_irr=?,updated_at=? WHERE id=?').run(raised*10,now,source.id);
    const duplicate=db.prepare(`SELECT id FROM plans WHERE traffic_gb=10 AND duration_days=? AND device_limit=? AND location_mode=? AND EXISTS(SELECT 1 FROM plan_locations own WHERE own.plan_id=plans.id AND own.location_id IN (SELECT location_id FROM plan_locations WHERE plan_id=?))`).get(source.duration_days,source.device_limit,source.location_mode,source.id);
    if(duplicate)continue;
    const id=randomUUID(),tenPrice=Math.ceil((raised*.45)/5000)*5000,name=source.name.replace(/۳۰|30/g,'۱۰').replace(/سی گیگ/g,'ده گیگ');
    insert.run(id,name===source.name?`${source.name} · ۱۰ گیگ`:name,source.description,tenPrice*10,10,source.duration_days,source.device_limit,source.location_mode,source.bundle_size,Number(source.sort_order)-1,1,now,now,'پلن اقتصادی ۱۰ گیگ؛ مناسب مصرف سبک',0,'NONE',0,0);
    copyLocation.run(id,source.id);
  }
  db.exec('COMMIT');console.log(`Applied: raised ${sources.length} active 30GB plan(s); 10GB plans were created where missing.`);
}catch(error){db.exec('ROLLBACK');throw error}
