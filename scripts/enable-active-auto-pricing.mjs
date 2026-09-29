import { openDatabase } from '../src/db.js';

const markupPercent=Math.max(0,Number(process.argv[2]||35)),currency=String(process.argv[3]||'EUR').toUpperCase();
if(!['USD','EUR'].includes(currency)||!Number.isFinite(markupPercent))throw new Error('Usage: node scripts/enable-active-auto-pricing.mjs MARKUP_PERCENT USD|EUR');
const db=openDatabase(),rate=Number(db.prepare('SELECT value FROM app_settings WHERE key=?').get(currency==='USD'?'pricing_usd_toman':'pricing_eur_toman')?.value||0);
if(!rate)throw new Error(`Missing ${currency} rate`);
const now=new Date().toISOString(),rows=db.prepare('SELECT id,price_irr FROM plans WHERE active=1').all(),update=db.prepare('UPDATE plans SET auto_price=1,cost_currency=?,cost_amount=?,markup_percent=?,updated_at=? WHERE id=?');
db.exec('BEGIN IMMEDIATE');try{for(const row of rows){const retailToman=Number(row.price_irr)/10,cost=retailToman/(rate*(1+markupPercent/100));update.run(currency,cost,markupPercent,now,row.id)}db.exec('COMMIT');console.log(JSON.stringify({updatedPlans:rows.length,currency,rate,markupPercent}));}catch(error){db.exec('ROLLBACK');throw error}
