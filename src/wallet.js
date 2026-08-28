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

// Write one ledger entry inside an already-open database transaction.  Keeping
// this primitive separate lets payment confirmation consume a bank transaction,
// approve a top-up, and credit the wallet as one all-or-nothing operation.
export function postWalletTransactionInTransaction(db, { accountId, amountToman, type, reference, actor, note = null }) {
  if (!Number.isInteger(amountToman) || amountToman === 0) throw new Error('INVALID_AMOUNT');
  if (!reference?.trim()) throw new Error('REFERENCE_REQUIRED');
  const wallet = ensureWallet(db, accountId);
  const balance = wallet.balance_toman + amountToman;
  if (balance < 0) throw new Error('INSUFFICIENT_BALANCE');
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('UPDATE wallet_accounts SET balance_toman=?,updated_at=? WHERE id=?').run(balance,now,wallet.id);
  db.prepare(`INSERT INTO wallet_transactions(id,wallet_id,amount_toman,balance_after_toman,type,reference,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,wallet.id,amountToman,balance,type,reference.trim(),actor,note,now);
  return { id, accountId, amountToman, balanceToman:balance, type, reference, createdAt:now };
}

export function postWalletTransaction(db, params) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = postWalletTransactionInTransaction(db, params);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed')) throw new Error('DUPLICATE_REFERENCE');
    throw error;
  }
}

// Move credit between two wallets as one durable ledger operation.  The optional
// callback runs before commit so business metadata (for example, reseller
// ownership of a credit) cannot get out of sync with either wallet entry.
export function transferWalletBalance(db, {
  fromAccountId,
  toAccountId,
  amountToman,
  reference,
  actor,
  fromNote = null,
  toNote = null,
  onTransfer = null
}) {
  if (!Number.isInteger(amountToman) || amountToman <= 0) throw new Error('INVALID_AMOUNT');
  if (!reference?.trim()) throw new Error('REFERENCE_REQUIRED');
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) throw new Error('INVALID_TRANSFER');
  db.exec('BEGIN IMMEDIATE');
  try {
    const fromWallet = ensureWallet(db, fromAccountId);
    const toWallet = ensureWallet(db, toAccountId);
    const fromBalance = fromWallet.balance_toman - amountToman;
    if (fromBalance < 0) throw new Error('INSUFFICIENT_BALANCE');
    const toBalance = toWallet.balance_toman + amountToman;
    const now = new Date().toISOString(), transferReference = reference.trim();
    const outId = randomUUID(), inId = randomUUID();
    db.prepare('UPDATE wallet_accounts SET balance_toman=?,updated_at=? WHERE id=?').run(fromBalance,now,fromWallet.id);
    db.prepare('UPDATE wallet_accounts SET balance_toman=?,updated_at=? WHERE id=?').run(toBalance,now,toWallet.id);
    db.prepare(`INSERT INTO wallet_transactions(id,wallet_id,amount_toman,balance_after_toman,type,reference,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(outId,fromWallet.id,-amountToman,fromBalance,'transfer_out',`${transferReference}:out`,actor,fromNote,now);
    db.prepare(`INSERT INTO wallet_transactions(id,wallet_id,amount_toman,balance_after_toman,type,reference,actor,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(inId,toWallet.id,amountToman,toBalance,'transfer_in',`${transferReference}:in`,actor,toNote,now);
    const result={reference:transferReference,amountToman,fromAccountId,toAccountId,fromBalanceToman:fromBalance,toBalanceToman:toBalance,outTransactionId:outId,inTransactionId:inId,createdAt:now};
    if (onTransfer) onTransfer(result);
    db.exec('COMMIT');
    return result;
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
