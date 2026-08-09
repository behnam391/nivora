import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';

const db = openDatabase();
const plans = [
  { name:'اقتصادی', description:'مناسب استفاده روزمره و شبکه‌های اجتماعی', price:990000, traffic:30, days:30, devices:1, sort:10 },
  { name:'استاندارد', description:'انتخاب متعادل برای استفاده شخصی', price:1590000, traffic:60, days:30, devices:2, sort:20 },
  { name:'حرفه‌ای', description:'مناسب مصرف بالا، ویدئو و چند دستگاه', price:2690000, traffic:120, days:30, devices:3, sort:30 },
  { name:'پرحجم', description:'حجم بیشتر با اعتبار طولانی‌تر', price:4490000, traffic:200, days:60, devices:3, sort:40 }
];
const now = new Date().toISOString();
const find = db.prepare('SELECT id FROM plans WHERE name=?');
const insert = db.prepare(`INSERT INTO plans(id,name,description,price_irr,traffic_gb,duration_days,device_limit,sort_order,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)`);
for (const p of plans) {
  if (!find.get(p.name)) insert.run(randomUUID(),p.name,p.description,p.price,p.traffic,p.days,p.devices,p.sort,now,now);
}
console.log('Starter plans are ready.');
