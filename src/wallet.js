import { randomUUID } from 'node:crypto';

export function ensureWallet(db, accountId) {
  const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId);
  if (!account) throw new Error('ACCOUNT_NOT_FOUND');
  let wallet = db.prepare('SELECT * FROM wallet_accounts WHERE account_id=?').get(accountId);
  if (!wallet) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO wallet_accounts(id,account_id,balance_toman,updated_at) VALUES(?,?,0,?)').run(randomUUID(),accountId,now);
    wallet = db.prepare('SELECT * FROM wallet_accounts WHERE account_id=?').get(accountId);
  }
  return wallet;
}

export function postWalletTransaction(db, { accountId, amountToman, type, reference, actor, note = null }) {
  if (!Number.isInteger(amountToman) || amountToman === 0) throw new Error('INVALID_AMOUNT');
  if (!reference?.trim()) throw new Error('REFERENCE_REQUIRED');
  db.exec('BEGIN IMMEDIATE');
  try {
    const wallet = ensureWallet(db, accountId);
    const balance = wallet.balance_toman + amountToman;
    if (balance < 0) throw new Error('INSUFFICIENT_BALANCE');
    const id = randomUUID(), now = new Date().toISOString();
    db.prepare('UPDATE wallet_accounts SET balance_toman=?,updated_at=? WHERE id=?').run(balance,now,wallet.id);
    db.prepare(`INSERT INTO wallet_transactions(id,wallet_id,amount_toman,balance_after_toman,type,reference,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id,wallet.id,amountToman,balance,type,reference.trim(),actor,note,now);
    db.exec('COMMIT');
    return { id, accountId, amountToman, balanceToman:balance, type, reference, createdAt:now };
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed')) throw new Error('DUPLICATE_REFERENCE');
    throw error;
  }
}

export function getWalletStatement(db, accountId, limit = 50) {
  const wallet = ensureWallet(db, accountId);
  const transactions = db.prepare('SELECT id,amount_toman,balance_after_toman,type,reference,actor,note,created_at FROM wallet_transactions WHERE wallet_id=? ORDER BY created_at DESC LIMIT ?').all(wallet.id,Math.min(Math.max(limit,1),200));
  return { accountId, balanceToman:wallet.balance_toman, transactions };
}
