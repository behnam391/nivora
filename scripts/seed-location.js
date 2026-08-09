import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
const db=openDatabase(),now=new Date().toISOString();
let location=db.prepare('SELECT id FROM service_locations WHERE country_code=? AND provider=?').get('FI','Hetzner Online GmbH');
if(!location){const id=randomUUID();db.prepare(`INSERT INTO service_locations(id,name,country_code,city,provider,panel_type,panel_inbound_id,capacity,active,created_at,updated_at) VALUES(?,?,?,?,?,'3x-ui',1,0,1,?,?)`).run(id,'فنلاند — هلسینکی','FI','Helsinki','Hetzner Online GmbH',now,now);location={id};}
const plans=db.prepare('SELECT id FROM plans').all(),attach=db.prepare('INSERT OR IGNORE INTO plan_locations(plan_id,location_id) VALUES(?,?)');
for(const plan of plans)attach.run(plan.id,location.id);
console.log('Finland / Helsinki location is ready.');
