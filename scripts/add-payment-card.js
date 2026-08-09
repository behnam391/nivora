import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';

const [cardNumber, cardHolder, bankName = ''] = process.argv.slice(2);
const digits = String(cardNumber || '').replace(/\D/g, '');
if (digits.length !== 16 || !cardHolder) throw new Error('Usage: node scripts/add-payment-card.js <16-digit-card> <holder> [bank]');
const db = openDatabase();
const existing = db.prepare('SELECT id FROM payment_cards WHERE card_number=?').get(digits);
const now = new Date().toISOString();
if (existing) {
  db.prepare('UPDATE payment_cards SET card_holder=?,bank_name=?,active=1,updated_at=? WHERE id=?').run(cardHolder,bankName,now,existing.id);
  console.log('Payment card updated.');
} else {
  db.prepare('INSERT INTO payment_cards(id,card_number,card_holder,bank_name,sort_order,active,created_at,updated_at) VALUES(?,?,?,?,0,1,?,?)')
    .run(randomUUID(),digits,cardHolder,bankName,now,now);
  console.log('Payment card added.');
}
